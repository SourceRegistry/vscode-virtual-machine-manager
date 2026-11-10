/**
 * Hyper-V has no template concept, so a template is a stopped VM whose Notes start with this marker.
 * The provider hides the marker from the user and the power script refuses to start such a VM.
 * Keep the literal in step with `scripts.POWER`.
 */
export const TEMPLATE_MARKER = '[vmm:template]';

export function isTemplate(notes: string | null | undefined): boolean {
	return (notes ?? '').startsWith(TEMPLATE_MARKER);
}

/** The notes as the user wrote them, without the marker. */
export function visibleNotes(notes: string | null | undefined): string {
	const text = notes ?? '';
	return isTemplate(text) ? text.slice(TEMPLATE_MARKER.length).replace(/^\r?\n/, '') : text;
}

/** Notes with the marker set (`template`) or removed. */
export function withTemplate(notes: string | null | undefined, template: boolean): string {
	const text = visibleNotes(notes);
	return template ? (text ? `${TEMPLATE_MARKER}\n${text}` : TEMPLATE_MARKER) : text;
}
