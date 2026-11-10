import * as vscode from 'vscode';
import { describeConfigHost, parseUserAtHost, sshQuestionsFor, type ConfigHost } from '../../shared/sshConfigHosts';
import { addSshHost, loadSshConfigHosts, openSshConfig } from '../ssh/hosts';
import { sshConfigPath } from '../ssh/connect';
import { isFieldVisible, isRemotePath, validateValue, type FieldSchema, type FieldValue, type FieldValues } from '@vmm/sdk';

/** Returned when the user pressed the back button on the first collected step. */
export const BACK = Symbol('back');
export type Back = typeof BACK;

interface StepPosition {
	title: string;
	step: number;
	totalSteps: number;
	canGoBack: boolean;
}

export interface PickItem<T> extends vscode.QuickPickItem {
	value: T;
}

/** Native single-select step with optional back button. */
export function pickStep<T>(
	position: StepPosition,
	items: PickItem<T>[],
	options: { placeholder?: string; active?: T } = {}
): Promise<PickItem<T> | Back | undefined> {
	return new Promise((resolve) => {
		const pick = vscode.window.createQuickPick<PickItem<T>>();
		pick.title = position.title;
		pick.step = position.step;
		pick.totalSteps = position.totalSteps;
		pick.placeholder = options.placeholder;
		pick.items = items;
		pick.ignoreFocusOut = true;
		const active = items.find((i) => i.value === options.active);
		if (active) pick.activeItems = [active];
		pick.buttons = position.canGoBack ? [vscode.QuickInputButtons.Back] : [];
		let done = false;
		const finish = (value: PickItem<T> | Back | undefined) => {
			if (done) return;
			done = true;
			resolve(value);
			pick.dispose();
		};
		pick.onDidTriggerButton((b) => b === vscode.QuickInputButtons.Back && finish(BACK));
		pick.onDidAccept(() => finish(pick.selectedItems[0]));
		pick.onDidHide(() => finish(undefined));
		pick.show();
	});
}

/** Native text step with validation and optional back button. */
export function textStep(
	position: StepPosition,
	options: {
		value?: string;
		prompt?: string;
		placeholder?: string;
		password?: boolean;
		validate?: (value: string) => string | undefined;
	}
): Promise<string | Back | undefined> {
	return new Promise((resolve) => {
		const box = vscode.window.createInputBox();
		box.title = position.title;
		box.step = position.step;
		box.totalSteps = position.totalSteps;
		box.value = options.value ?? '';
		box.prompt = options.prompt;
		box.placeholder = options.placeholder;
		box.password = options.password ?? false;
		box.ignoreFocusOut = true;
		box.buttons = position.canGoBack ? [vscode.QuickInputButtons.Back] : [];
		let done = false;
		const finish = (value: string | Back | undefined) => {
			if (done) return;
			done = true;
			resolve(value);
			box.dispose();
		};
		const validate = () => {
			const message = options.validate?.(box.value);
			box.validationMessage = message;
			return !message;
		};
		box.onDidChangeValue(() => validate());
		box.onDidTriggerButton((b) => b === vscode.QuickInputButtons.Back && finish(BACK));
		box.onDidAccept(() => {
			if (validate()) finish(box.value);
		});
		box.onDidHide(() => finish(undefined));
		box.show();
	});
}

export interface CollectOptions {
	title: string;
	/** Steps that precede the collected fields (for the step counter). */
	stepOffset?: number;
	/** Extra steps after the collected fields (for the step counter). */
	trailingSteps?: number;
	/** Whether the first collected step shows a back button (returns BACK). */
	canGoBackFromFirst?: boolean;
	includeAdvanced?: boolean;
	/** Secret fields already stored: empty input keeps them. */
	storedSecrets?: string[];
}

/**
 * Collects values for a list of provider fields as a native multi-step input.
 * Returns the values, BACK when the user went back from the first step, or undefined on cancel.
 */
export async function collectFields(
	fields: FieldSchema[],
	initial: FieldValues,
	options: CollectOptions
): Promise<FieldValues | Back | undefined> {
	const asked = fields.filter((f) => !f.readonly && (options.includeAdvanced || !f.advanced));
	const values: FieldValues = { ...initial };
	const offset = options.stepOffset ?? 0;
	// Which fields apply can change as the user answers (a sign-in method shows its own fields).
	const applicable = () => asked.filter((f) => isFieldVisible(f, values, fields));
	let index = 0;
	while (index < applicable().length) {
		const steps = applicable();
		const field = steps[index];
		const position: StepPosition = {
			title: options.title,
			step: offset + index + 1,
			totalSteps: offset + steps.length + (options.trailingSteps ?? 0),
			canGoBack: index > 0 || !!options.canGoBackFromFirst
		};
		const result = await fieldStep(field, values[field.key], position, options.storedSecrets?.includes(field.key) ?? false, values);
		if (result === undefined) return undefined;
		if (result === BACK) {
			if (index === 0) return BACK;
			index--;
			continue;
		}
		values[field.key] = result.value;
		Object.assign(values, result.set);
		index++;
	}
	return values;
}

type StepResult = { value: FieldValue; /** Other fields this answer settles (an ssh host brings its own user, port and key). */ set?: FieldValues };

async function fieldStep(
	field: FieldSchema,
	current: FieldValue,
	position: StepPosition,
	hasStoredSecret: boolean,
	values: FieldValues = {}
): Promise<StepResult | Back | undefined> {
	const optionalHint = field.required ? '' : ' (optional)';
	switch (field.type) {
		case 'select': {
			if (!field.options?.length) break;
			const items: PickItem<string | undefined>[] = field.options.map((o) => ({
				label: o.label,
				description: o.description,
				value: o.value
			}));
			if (!field.required) items.unshift({ label: '$(close) None', value: undefined });
			const picked = await pickStep(position, items, {
				placeholder: `${field.label}${optionalHint}${field.description ? ` — ${field.description}` : ''}`,
				active: current === undefined ? undefined : String(current)
			});
			if (picked === undefined || picked === BACK) return picked;
			return { value: picked.value };
		}
		case 'checkbox': {
			const picked = await pickStep(
				position,
				[
					{ label: '$(check) Yes', value: true },
					{ label: '$(close) No', value: false }
				],
				{ placeholder: `${field.label}${field.description ? ` — ${field.description}` : ''}`, active: Boolean(current ?? field.default) }
			);
			if (picked === undefined || picked === BACK) return picked;
			return { value: picked.value };
		}
		case 'file':
		case 'directory':
			return pathStep(field, current, position, !isRemotePath(field, values));
		case 'sshHost':
			return sshHostStep(field, current, position);
		default:
			break;
	}

	const isSecret = field.secret || field.type === 'password';
	const unit = field.unit ? ` (${field.unit})` : '';
	const text = await textStep(position, {
		value: isSecret ? '' : current === undefined ? '' : String(current),
		prompt: `${field.label}${unit}${optionalHint}${field.description ? ` — ${field.description}` : ''}`,
		placeholder: isSecret && hasStoredSecret ? 'Stored securely — leave empty to keep' : field.placeholder,
		password: isSecret,
		validate: (raw) => {
			if (isSecret && hasStoredSecret && raw === '') return undefined;
			return validateValue(field, field.type === 'number' && raw !== '' ? Number(raw) : raw);
		}
	});
	if (text === undefined || text === BACK) return text;
	if (field.type === 'number') return { value: text === '' ? undefined : Number(text) };
	return { value: text === '' ? undefined : text };
}

type HostChoice = { kind: 'host'; value: string } | { kind: 'add' } | { kind: 'configure' };

/**
 * Pick a host from the ssh config (searchable), or type `user@host`; "Add New SSH Host…" and "Configure SSH
 * Hosts…" are at the bottom, as in Remote - SSH. The list reloads when the config is saved.
 */
function sshHostStep(field: FieldSchema, current: FieldValue, position: StepPosition): Promise<StepResult | Back | undefined> {
	return new Promise((resolve) => {
		const pick = vscode.window.createQuickPick<PickItem<HostChoice>>();
		pick.title = position.title;
		pick.step = position.step;
		pick.totalSteps = position.totalSteps;
		pick.placeholder = `Select configured SSH host or enter user@host${field.required ? '' : ' (optional)'}`;
		pick.ignoreFocusOut = true;
		pick.buttons = position.canGoBack ? [vscode.QuickInputButtons.Back] : [];
		let hosts: ConfigHost[] = loadSshConfigHosts();
		let busy = false;
		let done = false;
		const disposables: vscode.Disposable[] = [];

		const render = () => {
			const typed = pick.value.trim();
			const items: PickItem<HostChoice>[] = [];
			if (typed && !hosts.some((h) => h.alias === typed) && parseUserAtHost(typed)) {
				items.push({ label: `$(plug) ${typed}`, description: 'Use as typed', alwaysShow: true, value: { kind: 'host', value: typed } });
			}
			for (const host of hosts) items.push({ label: host.alias, description: describeConfigHost(host), value: { kind: 'host', value: host.alias } });
			items.push({ label: '', kind: vscode.QuickPickItemKind.Separator, value: { kind: 'add' } });
			items.push({ label: '$(add) Add New SSH Host…', alwaysShow: true, value: { kind: 'add' } });
			items.push({ label: '$(gear) Configure SSH Hosts…', description: sshConfigPath(), alwaysShow: true, value: { kind: 'configure' } });
			pick.items = items;
			const active = current === undefined ? undefined : items.find((i) => i.value.kind === 'host' && i.value.value === String(current));
			if (active) pick.activeItems = [active];
		};
		const chosen = (alias: string): StepResult => {
			const known = loadSshConfigHosts().find((h) => h.alias === alias);
			return { value: alias, set: sshQuestionsFor(known, known ? undefined : parseUserAtHost(alias)?.user) };
		};
		const finish = (value: StepResult | Back | undefined) => {
			if (done) return;
			done = true;
			for (const d of disposables) d.dispose();
			resolve(value);
			pick.dispose();
		};
		const reload = () => {
			hosts = loadSshConfigHosts();
			render();
		};

		disposables.push(
			pick.onDidChangeValue(render),
			pick.onDidTriggerButton((b) => b === vscode.QuickInputButtons.Back && finish(BACK)),
			pick.onDidHide(() => !busy && finish(undefined)),
			vscode.workspace.onDidSaveTextDocument(reload),
			pick.onDidAccept(async () => {
				const choice = pick.selectedItems[0]?.value;
				if (!choice) return;
				if (choice.kind === 'host') return finish(chosen(choice.value));
				if (choice.kind === 'configure') {
					await openSshConfig().then(undefined, () => undefined);
					return;
				}
				busy = true;
				try {
					const added = await addSshHost().catch(() => undefined);
					if (added) return finish(chosen(added));
				} finally {
					busy = false;
				}
				if (!done) {
					reload();
					pick.show();
				}
			})
		);
		render();
		pick.show();
	});
}

async function pathStep(
	field: FieldSchema,
	current: FieldValue,
	position: StepPosition,
	canBrowse = true
): Promise<{ value: FieldValue } | Back | undefined> {
	const directory = field.type === 'directory';
	let value = current === undefined ? undefined : String(current);
	for (;;) {
		const items: PickItem<'keep' | 'browse' | 'none' | 'type'>[] = [];
		if (value) items.push({ label: `$(${directory ? 'folder' : 'file'}) ${value}`, description: 'Current', value: 'keep' });
		if (canBrowse) items.push({ label: `$(folder-opened) Browse…`, value: 'browse' });
		items.push({ label: `$(edit) Enter path…`, value: 'type' });
		if (!field.required) items.push({ label: '$(close) None', description: field.placeholder, value: 'none' });
		const picked = await pickStep(position, items, {
			placeholder: `${field.label}${field.required ? '' : ' (optional)'}${field.description ? ` — ${field.description}` : ''}`
		});
		if (picked === undefined || picked === BACK) return picked;
		switch (picked.value) {
			case 'keep':
				return { value };
			case 'none':
				return { value: undefined };
			case 'type': {
				const typed = await textStep({ ...position, canGoBack: true }, { value, prompt: field.label });
				if (typed === undefined) return undefined;
				if (typed === BACK) continue;
				return { value: typed || undefined };
			}
			case 'browse': {
				const uris = await vscode.window.showOpenDialog({
					canSelectFiles: !directory,
					canSelectFolders: directory,
					canSelectMany: false,
					filters: field.filters,
					title: field.label,
					defaultUri: value ? vscode.Uri.file(value) : undefined
				});
				if (uris?.[0]) return { value: uris[0].fsPath };
				continue;
			}
		}
	}
}
