/**
 * Interactive scale distributions (price spacing + amount split), step-curve:
 * each distribution is a fixed 5-node piecewise-linear curve sampled at every rung —
 * so any level count (2–20) reshapes without re-dragging, and BOTH the canvas
 * preview and the submitted orders derive from the exact same math (see
 * getScaleLevelPrices / getScaleLevelSizes in ../orders.ts).
 *
 * - Price nodes are FRACTIONS of the start→end range: node0 is pinned to0 and the
 *   last node to1 (the ladder always spans exactly start…end), middles draggable,
 *   monotonicity enforced while dragging.
 * - Amount nodes are RELATIVE WEIGHTS (0..1) sampled per rung and normalized at
 *   use time, so "flat" is uniform no matter the values.
 * - `null` = flat/uniform (the default) — the legacy linear/equal behavior.
 */

export const SCALE_DIST_NODE_COUNT = 5;

export type ScalePresetKey = "flat" | "start" | "end" | "custom";

/** Price curves: fractions of the price range at uniform x = i / (nodes - 1). */
export const SCALE_DIST_PRICE_PRESETS: Record<Exclude<ScalePresetKey, "custom">, readonly number[]> = {
	flat: [0, 0.25, 0.5, 0.75, 1],
	// Gaps grow left→right: rungs bunch near the START price.
	start: [0, 0.1, 0.3, 0.6, 1],
	// Gaps shrink left→right: rungs bunch near the END price.
	end: [0, 0.4, 0.7, 0.9, 1],
};

/** Amount curves: relative weights at the same node positions. */
export const SCALE_DIST_AMOUNT_PRESETS: Record<Exclude<ScalePresetKey, "custom">, readonly number[]> = {
	flat: [1, 1, 1, 1, 1],
	// Heavier size near the START price.
	start: [1, 0.75, 0.5, 0.35, 0.2],
	// Heavier size near the END price.
	end: [0.2, 0.35, 0.5, 0.75, 1],
};

/** Piecewise-linear sample of a node curve at t ∈ [0,1] (nodes at uniform x). */
export function sampleScaleCurve(nodes: readonly number[], t: number): number {
	if (nodes.length === 0) return t;
	if (nodes.length === 1) return nodes[0];
	const clamped = Math.min(Math.max(t, 0), 1);
	const x = clamped * (nodes.length - 1);
	const index = Math.min(Math.floor(x), nodes.length - 2);
	const frac = x - index;
	return nodes[index] + (nodes[index + 1] - nodes[index]) * frac;
}

/** Which preset chip a node set matches ("custom" when it matches none, null → "flat"). */
export function matchScalePreset(
	nodes: number[] | null,
	presets: Record<Exclude<ScalePresetKey, "custom">, readonly number[]>,
): ScalePresetKey {
	if (nodes === null) return "flat";
	for (const key of ["flat", "start", "end"] as const) {
		const preset = presets[key];
		if (preset.length === nodes.length && preset.every((v, i) => Math.abs(v - nodes[i]) < 1e-9)) return key;
	}
	return "custom";
}
