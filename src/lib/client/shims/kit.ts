// Type-level shim for `@sveltejs/kit` (client-lib only imports types from it).
export type ActionResult<Success extends Record<string, unknown> | undefined = Record<string, any>, Failure extends Record<string, unknown> | undefined = Record<string, any>> =
	| { type: 'success'; status: number; data?: Success }
	| { type: 'failure'; status: number; data?: Failure }
	| { type: 'redirect'; status: number; location: string }
	| { type: 'error'; status?: number; error: any };

export interface ActionFailure<T = undefined> {
	status: number;
	data: T;
}

export type Action = (...args: any[]) => any;

export type SubmitFunction = (input: {
	action: URL;
	formData: FormData;
	formElement: HTMLFormElement;
	controller: AbortController;
	submitter: HTMLElement | null;
	cancel: () => void;
}) =>
	| void
	| ((opts: {
			formData: FormData;
			formElement: HTMLFormElement;
			action: URL;
			result: ActionResult;
			update: (options?: { reset?: boolean; invalidateAll?: boolean }) => Promise<void>;
	  }) => unknown)
	| Promise<void | ((opts: any) => unknown)>;

export function fail<T>(status: number, data: T): ActionFailure<T> {
	return { status, data };
}
