import Big from "big.js";
import { formatSizeForOrder } from "@/domain/trade/orders";

/**
 * Quick size chips (the `$5 / $50 / …` row above the slider): each click ADDS its
 * USD amount to the current order value. Quote mode writes USD directly; base mode
 * converts through the mark and floors to the market's size precision — returns null
 * when conversion isn't possible (no mark / invalid amount) so the field stays put.
 */
/**
 * Size string for a fraction (0, 1] of a signed position size — the axis-menu TP/SL
 * percentage buttons. Null when the fraction is invalid or formats to zero at the
 * market's size precision (callers surface that as a failed order).
 */
export function sizeForFraction(szi: number, fraction: number, szDecimals: number): string | null {
	if (!Number.isFinite(szi) || szi === 0) return null;
	if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1) return null;
	const base = Math.abs(szi) * fraction;
	if (!Number.isFinite(base) || base <= 0) return null;
	const text = formatSizeForOrder(base, szDecimals);
	const parsed = Number(text);
	if (!Number.isFinite(parsed) || parsed <= 0) return null;
	return text;
}

export function increaseSizeByUsd(params: {
	currentUsd: number;
	amountUsd: number;
	markPx: number;
	sizeMode: "base" | "quote";
	szDecimals: number;
	/** Cap in base units; the rounded size never crosses it. */
	maxSize?: number;
}): string | null {
	const { amountUsd, markPx, sizeMode, szDecimals, maxSize } = params;
	if (!Number.isFinite(amountUsd) || amountUsd <= 0) return null;

	const current = Number.isFinite(params.currentUsd) && params.currentUsd > 0 ? params.currentUsd : 0;
	const target = current + amountUsd;
	if (!Number.isFinite(target) || target <= 0) return null;

	if (sizeMode === "quote") {
		return String(Number(target.toFixed(2)));
	}
	if (!Number.isFinite(markPx) || markPx <= 0) return null;

	// Round to the NEAREST size step rather than flooring. Flooring under-fills by up
	// to a whole step, which is worst on the small chips: at BTC's 0.00001 step a
	// "$5" chip floored to 0.00005 = $4.20, 16% short of the number on the button.
	// Half a step either way is far closer to what the chip promises, and rounding up
	// can never cross the available size because the cap clamps it.
	const step = new Big(1).div(new Big(10).pow(szDecimals));
	let steps = new Big(target).div(markPx).div(step).round(0, Big.roundHalfUp);
	if (steps.lte(0)) return null;
	if (maxSize !== undefined && Number.isFinite(maxSize) && maxSize > 0) {
		const maxSteps = new Big(maxSize).div(step).round(0, Big.roundDown);
		if (steps.gt(maxSteps)) steps = maxSteps;
		if (steps.lte(0)) return null;
	}
	const nextBase = steps.times(step);
	if (!nextBase.gt(0)) return null;
	// Already an exact multiple of the step, so the floor is a no-op — this just
	// trims trailing zeros ("0.00060" → "0.0006") like every other size in the app.
	return formatSizeForOrder(nextBase.toNumber(), szDecimals);
}
