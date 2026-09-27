/**
 * DOM metrics + tone colors for chart label strips rendered OUTSIDE klinecharts
 * (the TradingView overlay layer). Mirrors create-line-overlay's canvas metrics —
 * the color vars are the same CSS custom properties getChartColors() reads, so
 * both renderers produce identical pixels by construction.
 */
export const LABEL_FONT = "500 10px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
export const LABEL_PAD_X = 5;
export const LABEL_PAD_Y = 2;
export const LABEL_BORDER = 1;
/** Strip height: font + vertical padding + klinecharts' extra 4px breathing room. */
export const LABEL_BOX_HEIGHT = 10 + LABEL_PAD_Y * 2 + 4;
/** Minimum inset from the plot's left edge; rows float left of center. */
export const ROW_INSET = 20;

export type StripTone = "buy" | "sell" | "up" | "down" | "tp" | "sl" | "preview";

/** Text color for a segment tone (mirrors the renderer's toneColor). */
export function toneTextColor(tone: StripTone): string {
	if (tone === "preview") return "var(--text-weak)";
	return tone === "buy" || tone === "up" || tone === "tp" ? "var(--market-up)" : "var(--market-down)";
}

/**
 * Filled-chip colors: preview chips use the brand accent (gray-on-gray would
 * disappear), side chips (Long/Short) keep their tone as background.
 * Mirrors the renderer's filledBg/fgColor rules.
 */
export function toneFilledColors(tone: StripTone): { background: string; color: string } {
	if (tone === "preview") return { background: "var(--fill-brand-strong)", color: "var(--text-strong)" };
	return { background: toneTextColor(tone), color: "var(--text-strong)" };
}
