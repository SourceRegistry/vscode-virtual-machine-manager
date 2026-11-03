// Shim for SvelteKit's `$app/forms`. `enhance` intercepts the submit and hands the form data to
// a handler registered by the webview app (which forwards it to the extension host over RPC),
// so client-lib's <Form> works unchanged.
import type { ActionResult, SubmitFunction } from './kit';

export type { ActionResult, SubmitFunction };

export type FormActionHandler = (input: {
	/** Named action, e.g. `save` for `action="?/save"`; `default` otherwise. */
	name: string;
	action: URL;
	formData: FormData;
	form: HTMLFormElement;
}) => Promise<ActionResult>;

let handler: FormActionHandler | undefined;

export function setFormActionHandler(next: FormActionHandler | undefined): void {
	handler = next;
}

function actionName(action: URL): string {
	const match = /^\?\/([^&]+)/.exec(action.search);
	return match ? decodeURIComponent(match[1]) : 'default';
}

export function enhance(form: HTMLFormElement, submit: SubmitFunction = () => {}) {
	async function onSubmit(event: SubmitEvent) {
		event.preventDefault();
		const submitter = (event.submitter as HTMLButtonElement | HTMLInputElement | null) ?? null;
		const rawAction = submitter?.hasAttribute('formaction') ? submitter.formAction : form.getAttribute('action') ?? '?';
		const action = new URL(rawAction, location.href);
		const formData = new FormData(form, submitter ?? undefined);
		const controller = new AbortController();
		let cancelled = false;
		const callback = await submit({
			action,
			formData,
			formElement: form,
			controller,
			submitter,
			cancel: () => (cancelled = true)
		});
		if (cancelled) return;

		let result: ActionResult;
		try {
			result = handler
				? await handler({ name: actionName(action), action, formData, form })
				: { type: 'error', status: 500, error: new Error('No form action handler registered') };
		} catch (error) {
			result = { type: 'failure', status: 400, data: { message: error instanceof Error ? error.message : String(error) } };
		}

		const update = async (options?: { reset?: boolean }) => {
			if (result.type === 'success' && options?.reset !== false) form.reset();
		};
		if (typeof callback === 'function') await callback({ action, formData, formElement: form, result, update });
		else await update();
	}

	form.addEventListener('submit', onSubmit);
	return {
		destroy() {
			form.removeEventListener('submit', onSubmit);
		}
	};
}

export function deserialize<T = ActionResult>(text: string): T {
	return JSON.parse(text) as T;
}

export async function applyAction(): Promise<void> {}
