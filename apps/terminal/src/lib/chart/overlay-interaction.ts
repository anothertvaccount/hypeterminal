/**
 * Stamp for "the user just interacted with a chart label" (pressed an overlay, clicked
 * ✕/TP/SL). The chart hotkey click-handler consults this so a hold-key + click that
 * starts on a label never also places an order at that pixel.
 */

let lastInteractionAt = 0;

const DEFAULT_WINDOW_MS = 300;

export function noteChartOverlayInteraction(now: number = Date.now()): void {
	lastInteractionAt = now;
}

export function isChartOverlayInteractionRecent(windowMs = DEFAULT_WINDOW_MS, now: number = Date.now()): boolean {
	return now - lastInteractionAt < windowMs;
}
