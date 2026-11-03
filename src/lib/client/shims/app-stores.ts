// Shim for SvelteKit's legacy `$app/stores`.
import { readable } from 'svelte/store';
import { page as pageState } from './app-state.svelte';

export const page = readable(pageState);
export const navigating = readable(null);
export const updated = { ...readable(false), check: async () => false };
