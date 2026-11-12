/**
 * The machines as tools for AI agents (roadmap phase 21):
 *  - language model tools for agent mode inside VS Code (Copilot and other chat participants); VS Code shows
 *    its own confirmation for actions (`prepareInvocation`);
 *  - an MCP server for agents outside VS Code (Claude Code, other MCP clients), opt-in with `vmm.mcp.enabled`,
 *    on 127.0.0.1 with a bearer token; actions are confirmed in a VS Code dialog.
 * Destructive calls (power off, reset, revert or delete a snapshot) are refused unless `vmm.agent.allowDestructive`.
 * Keyboard and mouse control is allowed per machine for 15 minutes; a status bar item shows it and takes it back.
 */
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { ConnectionManager, VmLocation } from '../clusters/ConnectionManager';
import type { VmControl } from '../api/VmControl';
import type { VmActivity } from '../activity/VmActivity';
import { errorMessage, scopedLogger } from '../util/log';
import { ExtensionAgentBackend } from './backend';
import { DisplaySessions } from './display';
import { startMcpServer, type McpServerHandle, type McpToolInfo, type McpToolResult } from './mcpServer';
import { TOOLS, ToolOutput, findTool, refusal, validateInput, type AgentBackend, type AgentTool } from './tools';
import { vmHandle } from '../../shared/vmLookup';
import { screenControlMode, type ScreenControlMode } from './control';

const TOKEN_SECRET = 'vmm.mcp.token';
const log = scopedLogger('agent');

const allowDestructive = () => vscode.workspace.getConfiguration('vmm.agent').get<boolean>('allowDestructive', false);
const toJson = (value: unknown) => JSON.stringify(value, null, 2);

/**
 * Runs a tool after checking its input and whether agents may make this call at all, and after `confirm`
 * (the MCP path asks the user here; VS Code's agent mode asked already through `prepareInvocation`).
 */
export async function runTool(tool: AgentTool, input: unknown, backend: AgentBackend, destructiveAllowed: boolean, confirm?: (tool: AgentTool, input: unknown) => Promise<void>): Promise<McpToolResult> {
	const invalid = validateInput(tool.inputSchema, input);
	if (invalid) throw new Error(`Invalid input for ${tool.name}: ${invalid}`);
	const refused = refusal(tool.risk(input as never), destructiveAllowed);
	if (refused) throw new Error(refused);
	await confirm?.(tool, input);
	const result = await tool.run(input as never, backend);
	return result instanceof ToolOutput ? { text: toJson(result.json), images: result.images } : { text: toJson(result) };
}

/** How long one "Allow" gives agents a machine's keyboard and mouse. */
export const CONTROL_MINUTES = 15;

/**
 * Which machines agents may type and click on, until when. Shown in the status bar while any is allowed;
 * clicking it takes control back from all of them.
 */
class ControlGrants implements vscode.Disposable {
	private readonly grants = new Map<string, { name: string; until: number; location: VmLocation }>();
	private readonly item = vscode.window.createStatusBarItem('vmm.agentControl', vscode.StatusBarAlignment.Left, 50);
	private readonly timer = setInterval(() => this.update(), 30_000);

	constructor(
		private readonly onRevoke: (location: VmLocation, why: string) => void,
		private readonly closeDisplay: (key: string) => void
	) {
		this.item.name = 'VM Manager: AI agent control';
		this.item.command = 'vmm.agent.revokeControl';
		this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
	}

	has(key: string): boolean {
		const grant = this.grants.get(key);
		return !!grant && grant.until > Date.now();
	}

	allow(key: string, location: VmLocation): void {
		this.grants.set(key, { name: location.vm.name, until: Date.now() + CONTROL_MINUTES * 60_000, location });
		this.update();
	}

	/** Ends one machine's permission; false when it had none. */
	release(key: string, why: string): boolean {
		const grant = this.grants.get(key);
		if (!grant) return false;
		this.grants.delete(key);
		this.closeDisplay(key);
		this.onRevoke(grant.location, why);
		this.update();
		return true;
	}

	revokeAll(why: string): number {
		const count = this.grants.size;
		for (const [key, grant] of this.grants) {
			this.closeDisplay(key);
			this.onRevoke(grant.location, why);
		}
		this.grants.clear();
		this.update();
		return count;
	}

	private update(): void {
		for (const [key, grant] of this.grants) {
			if (grant.until > Date.now()) continue;
			this.grants.delete(key);
			this.closeDisplay(key);
			this.onRevoke(grant.location, 'Keyboard and mouse control by AI agents ended (time is up)');
		}
		const grants = [...this.grants.values()];
		void vscode.commands.executeCommand('setContext', 'vmm.agentControlActive', grants.length > 0);
		if (!grants.length) return this.item.hide();
		const minutes = (until: number) => Math.max(1, Math.ceil((until - Date.now()) / 60_000));
		this.item.text = `$(hubot) AI controls ${grants.length === 1 ? grants[0].name : `${grants.length} machines`}`;
		this.item.tooltip = `AI agents may use the keyboard and mouse of ${grants.map((g) => `${g.name} (${minutes(g.until)} min left)`).join(', ')}.\n\nClick to take control back now.`;
		this.item.show();
	}

	dispose(): void {
		clearInterval(this.timer);
		this.item.dispose();
	}
}

export function toolInfo(tool: AgentTool): McpToolInfo {
	// The risk can depend on the input (power: start vs. power off); the hint describes the worst case.
	const worst = tool.name === 'vmm_power_vm' ? 'destructive' : tool.risk({} as never);
	return { name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema, annotations: { readOnlyHint: worst === 'read', destructiveHint: worst === 'destructive', openWorldHint: false } };
}

export function registerAgentTools(context: vscode.ExtensionContext, manager: ConnectionManager, control: VmControl, activity: VmActivity): vscode.Disposable[] {
	const record = { record: (location: VmLocation, text: string, level?: 'info' | 'warn' | 'error') => activity.record(location.ref, text, level) };
	const displays = new DisplaySessions();
	const chatBackend = new ExtensionAgentBackend(manager, control, record, 'an AI agent in VS Code', displays);
	const mcpBackend = new ExtensionAgentBackend(manager, control, record, 'an MCP client', displays);
	const grants = new ControlGrants((location, why) => activity.record(location.ref, why), (key) => displays.close(key));
	const disposables: vscode.Disposable[] = [displays, grants];
	/** The machine a tool input names, as the key control is allowed under. */
	const target = async (input: unknown) => {
		const location = await control.resolve(String((input as { vm?: unknown })?.vm ?? ''));
		return { location, key: vmHandle(location.ref) };
	};
	const allow = (location: VmLocation, key: string, via: string, always = false) => {
		grants.allow(key, location);
		activity.record(location.ref, always ? `Keyboard and mouse used by AI agents (always allowed for this machine; asked by ${via})` : `Keyboard and mouse control allowed to AI agents for ${CONTROL_MINUTES} minutes (asked by ${via})`);
	};
	for (const backend of [chatBackend, mcpBackend]) backend.onRelease = (location, key, via) => grants.release(key, `Keyboard and mouse handed back by ${via}`);

	/** What the user chose for this machine's keyboard and mouse. */
	const modeOf = (location: VmLocation): ScreenControlMode => {
		const config = vscode.workspace.getConfiguration('vmm.agent');
		return screenControlMode({ name: location.vm.name, cluster: location.cluster.cluster.name }, config.get('screenControl'), config.get('screenControlPerMachine'));
	};
	const denied = (name: string) =>
		new Error(`Keyboard and mouse control of ${name} is turned off for AI agents (settings vmm.agent.screenControl and vmm.agent.screenControlPerMachine).`);
	/** No question needed: control already allowed, always allowed, or refused (the call then fails). */
	const settled = (mode: ScreenControlMode, key: string) => mode === 'allow' || mode === 'deny' || (mode === 'ask' && grants.has(key));
	const ALWAYS = 'Always Allow This Machine';
	const alwaysAllow = async (location: VmLocation) => {
		const config = vscode.workspace.getConfiguration('vmm.agent');
		const current = config.get<Record<string, string>>('screenControlPerMachine') ?? {};
		await config.update('screenControlPerMachine', { ...current, [location.vm.name]: 'allow' }, vscode.ConfigurationTarget.Global);
	};
	const controlQuestion = (name: string) => `Let AI agents use the keyboard and mouse of ${name}?`;
	const controlDetail = (mode: ScreenControlMode) =>
		mode === 'askEveryTime'
			? 'Asked for every call on this machine (vmm.agent.screenControlPerMachine).'
			: `For ${CONTROL_MINUTES} minutes or until the agent hands it back, without asking again for each key or click. The status bar shows it; click there to take control back.`;
	/** After the user allowed a call in agent mode, or before one needing no question. */
	const afterAllowed = (mode: ScreenControlMode, location: VmLocation, key: string, via: string) => {
		if (mode === 'deny') throw denied(location.vm.name);
		if (mode !== 'askEveryTime' && !grants.has(key)) allow(location, key, via, mode === 'allow');
	};

	// Language model tools: declared in package.json `languageModelTools`, implemented here.
	if (vscode.lm?.registerTool) {
		for (const tool of TOOLS) {
			disposables.push(
				vscode.lm.registerTool<Record<string, unknown>>(tool.name, {
					prepareInvocation: async (options) => {
						const risk = tool.risk(options.input as never);
						const what = tool.describe(options.input as never);
						if (risk === 'read') return { invocationMessage: what };
						if (risk === 'control') {
							const { location, key } = await target(options.input);
							const mode = modeOf(location);
							if (settled(mode, key)) return { invocationMessage: what };
							return { invocationMessage: what, confirmationMessages: { title: controlQuestion(location.vm.name), message: new vscode.MarkdownString(`${what}\n\n${controlDetail(mode)}`) } };
						}
						const warning = risk === 'destructive' ? '\n\n**This cannot be undone.**' : '';
						return { invocationMessage: what, confirmationMessages: { title: tool.title, message: new vscode.MarkdownString(`${what}${warning}`) } };
					},
					invoke: async (options) => {
						try {
							// Getting here means the user allowed it in VS Code's confirmation.
							if (tool.risk(options.input as never) === 'control') {
								const { location, key } = await target(options.input);
								afterAllowed(modeOf(location), location, key, 'an AI agent in VS Code');
							}
							const result = await runTool(tool, options.input, chatBackend, allowDestructive());
							// Image parts are newer than the types this extension builds against (1.95).
							return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(result.text), ...imageParts(result)] as vscode.LanguageModelTextPart[]);
						} catch (error) {
							log.warn(`${tool.name}: ${errorMessage(error)}`);
							throw error;
						}
					}
				})
			);
		}
	}

	// The MCP server, started and stopped with the setting.
	let server: McpServerHandle | undefined;
	let starting: Promise<void> | undefined;
	const token = async (): Promise<string> => {
		let value = await context.secrets.get(TOKEN_SECRET);
		if (!value) {
			value = randomBytes(32).toString('base64url');
			await context.secrets.store(TOKEN_SECRET, value);
		}
		return value;
	};
	const confirm = async (tool: AgentTool, input: unknown): Promise<void> => {
		const risk = tool.risk(input as never);
		if (risk === 'read') return;
		if (risk === 'control') {
			const { location, key } = await target(input);
			const mode = modeOf(location);
			if (settled(mode, key)) return afterAllowed(mode, location, key, 'an MCP client');
			const once = mode === 'ask' ? `Allow for ${CONTROL_MINUTES} Minutes` : 'Allow';
			const choice = await vscode.window.showWarningMessage(controlQuestion(location.vm.name), { modal: true, detail: `An MCP client wants to: ${tool.describe(input as never)}.\n\n${controlDetail(mode)}` }, once, ALWAYS);
			if (!choice) throw new Error('The user declined keyboard and mouse control of this machine.');
			if (choice === ALWAYS) {
				await alwaysAllow(location);
				return afterAllowed('allow', location, key, 'an MCP client');
			}
			return afterAllowed(mode, location, key, 'an MCP client');
		}
		const choice = await vscode.window.showWarningMessage(
			`An MCP client wants to: ${tool.describe(input as never)}`,
			{ modal: true, detail: `Tool ${tool.name}, asked through the VM Manager MCP server.${risk === 'destructive' ? ' This cannot be undone.' : ''}` },
			'Allow'
		);
		if (choice !== 'Allow') throw new Error('The user declined this action.');
	};
	const stop = async () => {
		const running = server;
		server = undefined;
		if (running) {
			await running.close();
			log.info('MCP server stopped');
		}
	};
	const sync = async () => {
		const config = vscode.workspace.getConfiguration('vmm.mcp');
		await stop();
		if (!config.get<boolean>('enabled', false)) return;
		const port = config.get<number>('port', 7254);
		try {
			server = await startMcpServer({
				port,
				token: await token(),
				serverInfo: { name: 'vm-manager', version: String(context.extension.packageJSON.version ?? '0.0.0') },
				instructions: 'Virtual machines managed by VM Manager in VS Code. Start with vmm_list_vms. Actions are confirmed by the user in VS Code; destructive ones may be turned off.',
				tools: () => TOOLS.map(toolInfo),
				call: (name, args) => runTool(findTool(name)!, args, mcpBackend, allowDestructive(), confirm),
				log: (line) => log.info(`MCP ${line}`)
			});
			log.info(`MCP server listening on ${server.url}`);
		} catch (error) {
			const message = /EADDRINUSE/.test(String(error)) ? `Port ${port} is in use. Choose another one in the setting vmm.mcp.port.` : errorMessage(error);
			void vscode.window.showErrorMessage(`VM Manager could not start its MCP server: ${message}`);
		}
	};
	const restart = () => (starting = (starting ?? Promise.resolve()).then(sync, sync));

	disposables.push(
		vscode.workspace.onDidChangeConfiguration((event) => { if (event.affectsConfiguration('vmm.mcp')) void restart(); }),
		vscode.commands.registerCommand('vmm.mcp.copySetup', async () => {
			if (!vscode.workspace.getConfiguration('vmm.mcp').get<boolean>('enabled', false)) {
				const choice = await vscode.window.showInformationMessage('The MCP server for AI agents is off.', { modal: true, detail: 'It listens on 127.0.0.1 only and asks you before every action. Turn it on?' }, 'Turn On');
				if (choice !== 'Turn On') return;
				await vscode.workspace.getConfiguration('vmm.mcp').update('enabled', true, vscode.ConfigurationTarget.Global);
				await restart();
			}
			await starting;
			if (!server) return;
			const secret = await token();
			const json = toJson({ mcpServers: { 'vm-manager': { type: 'http', url: server.url, headers: { Authorization: `Bearer ${secret}` } } } });
			const pick = await vscode.window.showQuickPick(
				[
					{ label: 'Claude Code', description: 'claude mcp add …', value: `claude mcp add --transport http vm-manager ${server.url} --header "Authorization: Bearer ${secret}"` },
					{ label: 'JSON configuration', description: 'mcpServers entry for other MCP clients', value: json }
				],
				{ title: 'Copy MCP Server Setup', placeHolder: 'It contains the access token: keep it out of shared files and chats.' }
			);
			if (!pick) return;
			await vscode.env.clipboard.writeText(pick.value);
			void vscode.window.showInformationMessage(`Copied the ${pick.label} setup for ${server.url}. It holds the access token; "VM: Reset MCP Access Token" makes a new one.`);
		}),
		vscode.commands.registerCommand('vmm.agent.revokeControl', () => {
			const count = grants.revokeAll('Keyboard and mouse control taken back from AI agents');
			void vscode.window.setStatusBarMessage(count ? 'AI agents no longer control any machine’s keyboard and mouse.' : 'AI agents control no machine.', 4000);
		}),
		vscode.commands.registerCommand('vmm.mcp.resetToken', async () => {
			await context.secrets.delete(TOKEN_SECRET);
			await restart();
			void vscode.window.showInformationMessage('Made a new MCP access token. Clients set up with the old one must be set up again (VM: Copy MCP Server Setup).');
		}),
		{ dispose: () => void stop() }
	);
	void restart();
	return disposables;
}

/**
 * Screenshots as image parts of a language model tool result. `LanguageModelDataPart` exists from VS Code 1.106;
 * on older versions the model gets the text only (which says the size), and the call says why there is no image.
 */
function imageParts(result: McpToolResult): unknown[] {
	if (!result.images?.length) return [];
	const DataPart = (vscode as unknown as { LanguageModelDataPart?: { image(data: Uint8Array, mimeType: string): unknown } }).LanguageModelDataPart;
	if (!DataPart) return [new vscode.LanguageModelTextPart('(This VS Code is too old to pass the screenshot to the model: it needs VS Code 1.106 or newer.)')];
	return result.images.map((image) => DataPart.image(new Uint8Array(image.data), image.mimeType));
}
