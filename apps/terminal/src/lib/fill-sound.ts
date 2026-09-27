import { STORAGE_KEYS } from "@/config/app";

/**
 * Fill alert chime: a short two-note sine ding, generated with the Web Audio API
 * (no asset files). Buys ascend, sells descend. The AudioContext is created lazily
 * and resumed on the first user gesture, per browser autoplay policy. Every failure
 * is swallowed — sound must never interfere with trading.
 */

let audioContext: AudioContext | null = null;
let gestureListenersAttached = false;

export function isFillSoundMuted(): boolean {
	try {
		return localStorage.getItem(STORAGE_KEYS.FILL_SOUND) === "muted";
	} catch {
		return false;
	}
}

export function setFillSoundMuted(muted: boolean): void {
	try {
		if (muted) localStorage.setItem(STORAGE_KEYS.FILL_SOUND, "muted");
		else localStorage.removeItem(STORAGE_KEYS.FILL_SOUND);
	} catch {
		// Storage unavailable — mute lasts for this session only.
	}
}

/** Attempt log (dev only) so browser test scripts can assert which sound fired. */
const soundLog: Array<"fill" | "action"> = [];
if (import.meta.env.DEV) {
	(globalThis as { __hlSoundLog?: Array<"fill" | "action"> }).__hlSoundLog = soundLog;
}

function noteSound(kind: "fill" | "action"): void {
	if (import.meta.env.DEV) soundLog.push(kind);
}

function attachGestureResume(): void {
	if (gestureListenersAttached || typeof window === "undefined") return;
	gestureListenersAttached = true;
	const resume = () => {
		if (audioContext?.state === "suspended") void audioContext.resume().catch(() => undefined);
	};
	window.addEventListener("pointerdown", resume, { once: true });
	window.addEventListener("keydown", resume, { once: true });
}

function ensureAudioContext(): AudioContext | null {
	if (typeof window === "undefined") return null;
	try {
		if (!audioContext) {
			const Ctor = window.AudioContext;
			if (!Ctor) return null;
			audioContext = new Ctor();
			attachGestureResume();
		}
		return audioContext;
	} catch {
		return null;
	}
}

function ping(ctx: AudioContext, frequency: number, at: number, duration: number, peak: number): void {
	const oscillator = ctx.createOscillator();
	const gain = ctx.createGain();
	oscillator.type = "sine";
	oscillator.frequency.setValueAtTime(frequency, at);
	gain.gain.setValueAtTime(0.0001, at);
	gain.gain.linearRampToValueAtTime(peak, at + 0.012);
	gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
	oscillator.connect(gain);
	gain.connect(ctx.destination);
	oscillator.start(at);
	oscillator.stop(at + duration + 0.02);
	oscillator.onended = () => {
		oscillator.disconnect();
		gain.disconnect();
	};
}

export function playFillSound(side: "buy" | "sell"): void {
	noteSound("fill");
	if (isFillSoundMuted()) return;
	const ctx = ensureAudioContext();
	if (!ctx) return;
	try {
		if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
		const start = ctx.currentTime + 0.02;
		// Buy: A4 → E5 (up). Sell: A4 → F4 (down).
		const [first, second] = side === "buy" ? [880, 1174.66] : [880, 698.46];
		ping(ctx, first, start, 0.16, 0.14);
		ping(ctx, second, start + 0.12, 0.24, 0.12);
	} catch {
		// Never let audio problems break trading.
	}
}

/**
 * Order placed / cancelled tick — deliberately unlike the two-note fill chime:
 * a dry triangle blip (G4) with a tiny high click, no melody, no tail. Muted by the
 * same toggle as fills (one switch governs all trade sounds).
 */
export function playActionSound(): void {
	noteSound("action");
	if (isFillSoundMuted()) return;
	const ctx = ensureAudioContext();
	if (!ctx) return;
	try {
		if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
		const at = ctx.currentTime + 0.02;

		const blip = ctx.createOscillator();
		const blipGain = ctx.createGain();
		blip.type = "triangle";
		blip.frequency.setValueAtTime(392, at);
		blipGain.gain.setValueAtTime(0.0001, at);
		blipGain.gain.linearRampToValueAtTime(0.16, at + 0.008);
		blipGain.gain.exponentialRampToValueAtTime(0.0001, at + 0.09);
		blip.connect(blipGain);
		blipGain.connect(ctx.destination);
		blip.start(at);
		blip.stop(at + 0.12);
		blip.onended = () => {
			blip.disconnect();
			blipGain.disconnect();
		};

		const click = ctx.createOscillator();
		const clickGain = ctx.createGain();
		click.type = "square";
		click.frequency.setValueAtTime(2400, at);
		clickGain.gain.setValueAtTime(0.0001, at);
		clickGain.gain.linearRampToValueAtTime(0.05, at + 0.004);
		clickGain.gain.exponentialRampToValueAtTime(0.0001, at + 0.03);
		click.connect(clickGain);
		clickGain.connect(ctx.destination);
		click.start(at);
		click.stop(at + 0.05);
		click.onended = () => {
			click.disconnect();
			clickGain.disconnect();
		};
	} catch {
		// Never let audio problems break trading.
	}
}
