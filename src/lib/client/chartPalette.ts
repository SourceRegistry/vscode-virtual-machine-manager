/**
 * Series colors for the dashboard charts. Each metric keeps its color everywhere it appears
 * (color follows the entity). Both columns are steps of the same four hues of the reference
 * categorical palette and pass the palette validator on their surface (light #fcfcfb, dark #1a1a19).
 */
import type { ThemeKind } from './theme-sync';

export type SeriesKey = 'cpu' | 'memory' | 'read' | 'write';

const LIGHT: Record<SeriesKey, string> = { cpu: '#2a78d6', memory: '#eb6834', read: '#1baf7a', write: '#6250d6' };
const DARK: Record<SeriesKey, string> = { cpu: '#3987e5', memory: '#d95926', read: '#199e70', write: '#9085e9' };

export function seriesColor(key: SeriesKey, kind: ThemeKind): string {
	return kind === 'light' || kind === 'high-contrast-light' ? LIGHT[key] : DARK[key];
}
