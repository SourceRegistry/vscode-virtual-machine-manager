/**
 * The screens agents look at and type into: one shared VNC connection per machine, opened on first use and
 * closed after a minute without calls (or when the machine's display goes away). No `vscode` import.
 */
import type { Duplex } from 'node:stream';
import { RfbClient } from './rfb';
import { framePng, toScreen } from './screen';
import type { KeyStroke } from './keys';

export interface DisplayStream {
	stream: Duplex;
	credentials?: { password: string };
	dispose(): void;
}

export interface Screenshot {
	png: Buffer;
	/** The screenshot's size: coordinates for the mouse are in these pixels. */
	width: number;
	height: number;
	/** The guest's real screen size. */
	screen: { width: number; height: number };
}

/** A pointer action, in screenshot pixels. */
export type MouseAction =
	| { action: 'move' | 'click' | 'double_click' | 'right_click' | 'middle_click'; x: number; y: number }
	| { action: 'drag'; x: number; y: number; toX: number; toY: number }
	| { action: 'scroll'; x: number; y: number; direction: 'up' | 'down'; amount: number };

const LEFT = 1;
const MIDDLE = 2;
const RIGHT = 4;
const WHEEL_UP = 8;
const WHEEL_DOWN = 16;

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Session {
	client: Promise<RfbClient>;
	dispose(): void;
	timer?: NodeJS.Timeout;
	/** Calls on one screen run one after another (a click must not interleave with typing). */
	queue: Promise<unknown>;
}

export class DisplaySessions {
	private readonly sessions = new Map<string, Session>();

	constructor(
		private readonly idleMs = 60_000,
		/** Between key and pointer events, so the guest sees each one. */
		private readonly stepMs = 15
	) {}

	private session(key: string, open: () => Promise<DisplayStream>): Session {
		const existing = this.sessions.get(key);
		if (existing) return existing;
		let opened: DisplayStream | undefined;
		const session: Session = {
			client: (async () => {
				opened = await open();
				const client = await RfbClient.connect(opened.stream, { password: opened.credentials?.password });
				opened.stream.once('close', () => {
					if (this.sessions.get(key) === session) this.close(key);
				});
				return client;
			})(),
			dispose: () => {
				void session.client.then((c) => c.close(), () => undefined);
				opened?.dispose();
			},
			queue: Promise.resolve()
		};
		// A failed connection is not kept: the next call tries again.
		session.client.catch(() => {
			if (this.sessions.get(key) === session) this.close(key);
		});
		this.sessions.set(key, session);
		return session;
	}

	/** Runs `work` on the machine's screen, after earlier calls on it, and restarts its idle timer. */
	private async use<T>(key: string, open: () => Promise<DisplayStream>, work: (client: RfbClient) => Promise<T>): Promise<T> {
		const session = this.session(key, open);
		clearTimeout(session.timer);
		const run = session.queue.then(async () => work(await session.client));
		session.queue = run.catch(() => undefined);
		try {
			return await run;
		} finally {
			if (this.sessions.get(key) === session) {
				clearTimeout(session.timer);
				session.timer = setTimeout(() => this.close(key), this.idleMs);
			}
		}
	}

	screenshot(key: string, open: () => Promise<DisplayStream>): Promise<Screenshot> {
		return this.use(key, open, async (client) => {
			const frame = await client.capture();
			return { ...framePng(frame), screen: { width: frame.width, height: frame.height } };
		});
	}

	keys(key: string, open: () => Promise<DisplayStream>, strokes: readonly KeyStroke[]): Promise<void> {
		return this.use(key, open, async (client) => {
			for (const stroke of strokes) {
				client.key(stroke.keysym, stroke.down);
				await pause(this.stepMs);
			}
		});
	}

	mouse(key: string, open: () => Promise<DisplayStream>, action: MouseAction): Promise<void> {
		return this.use(key, open, async (client) => {
			const screen = { width: client.width, height: client.height };
			const at = toScreen(action.x, action.y, screen);
			const press = async (buttons: number) => {
				client.pointer(at.x, at.y, buttons);
				await pause(this.stepMs * 3);
				client.pointer(at.x, at.y, 0);
				await pause(this.stepMs * 3);
			};
			client.pointer(at.x, at.y, 0);
			await pause(this.stepMs);
			switch (action.action) {
				case 'move':
					return;
				case 'click':
					return press(LEFT);
				case 'double_click':
					await press(LEFT);
					return press(LEFT);
				case 'right_click':
					return press(RIGHT);
				case 'middle_click':
					return press(MIDDLE);
				case 'scroll':
					for (let i = 0; i < action.amount; i++) await press(action.direction === 'up' ? WHEEL_UP : WHEEL_DOWN);
					return;
				case 'drag': {
					const to = toScreen(action.toX, action.toY, screen);
					client.pointer(at.x, at.y, LEFT);
					await pause(this.stepMs * 3);
					const steps = 10;
					for (let i = 1; i <= steps; i++) {
						client.pointer(at.x + ((to.x - at.x) * i) / steps, at.y + ((to.y - at.y) * i) / steps, LEFT);
						await pause(this.stepMs);
					}
					client.pointer(to.x, to.y, 0);
					await pause(this.stepMs * 3);
				}
			}
		});
	}

	close(key?: string): void {
		for (const [k, session] of this.sessions) {
			if (key !== undefined && k !== key) continue;
			clearTimeout(session.timer);
			this.sessions.delete(k);
			session.dispose();
		}
	}

	dispose(): void {
		this.close();
	}
}
