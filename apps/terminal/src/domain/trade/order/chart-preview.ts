import { canPreviewScale, getScaleLevelPrices, getScaleLevelSizes } from "@/domain/trade/orders";
import { calculateEstimatedPnl } from "@/lib/trade/tpsl";
import { formatSignedUsd, formatUsd, type LabelSegment, type LineOverlayResolution } from "./chart-labels";

export type PreviewKind = "limit" | "tp" | "sl" | "scaleStart" | "scaleEnd" | "scaleMid";

function previewTitle(kind: PreviewKind, side: "buy" | "sell"): string {
	switch (kind) {
		case "limit":
			return side === "buy" ? "BUY" : "SELL";
		case "tp":
			return "TAKE PROFIT";
		case "sl":
			return "STOP LOSS";
		case "scaleStart":
			return "SCALE START";
		case "scaleEnd":
			return "SCALE END";
		default:
			return "SCALE";
	}
}

/**
 * Label for a form draft line: the limit/TP/SL of an order that exists only in the
 * form. Every strip carries a PREVIEW chip and an explicit "not in book until
 * submitted" cell so the canvas can never be mistaken for resting orders — nothing
 * reaches the exchange until the user submits the form. Lines are draggable: a
 * release writes the new price back into the matching form field.
 */
export interface PreviewDetail {
	/** Draft price the numbers below are computed at. */
	price: number;
	/** Composed order size in base units — 0/absent omits the number cells. */
	size: number;
	/** Display-ready size (the caller owns market szDecimals formatting). */
	sizeText?: string;
	/** Entry reference for TP/SL PnL (typed limit price, else the mark). */
	refPrice?: number;
}

export function buildPreviewSegments(
	kind: PreviewKind,
	side: "buy" | "sell",
	detail?: PreviewDetail,
): LineOverlayResolution {
	// Exits (TP/SL) sit opposite the entry; limit and scale ladders keep the entry side.
	const isExit = kind === "tp" || kind === "sl";
	const isBuy = isExit ? side !== "buy" : side === "buy";
	const segments: LabelSegment[] = [
		{ text: "PREVIEW", tone: "preview", filled: true },
		{ text: previewTitle(kind, side), tone: isBuy ? "buy" : "sell", key: "preview" },
	];
	// Size-aware numbers: the limit line shows the notional, TP/SL drafts the realized
	// PnL at the composed size, and each scale rung ITS OWN per-order size (the caller
	// passes ladder size / levels — a full-size figure on a rung would lie).
	if (detail && detail.size > 0 && detail.price > 0) {
		if (isExit) {
			// Realized PnL if this TP/SL fills, at the size currently composed in the form.
			if (detail.refPrice !== undefined && detail.refPrice > 0) {
				const pnl = calculateEstimatedPnl({ referencePrice: detail.refPrice, side, size: detail.size }, detail.price);
				if (pnl !== null) segments.push({ text: formatSignedUsd(pnl), tone: pnl < 0 ? "down" : "up" });
			}
		} else if (kind === "limit") {
			segments.push({ text: formatUsd(detail.size * detail.price), tone: isBuy ? "buy" : "sell" });
		}
		if (detail.sizeText) segments.push({ text: detail.sizeText, tone: "preview" });
	}
	segments.push({ text: "not in book until submitted", tone: "preview" });
	return { segments, isBuy };
}

/**
 * Entry reference for the draft labels' PnL math — mirrors getOrderPrice: the typed
 * limit price, the scale ladder's midpoint (or one typed end), else the mark.
 */
export function draftReferencePrice(input: {
	orderType: string;
	limitPriceInput: string;
	scaleStartInput: string;
	scaleEndInput: string;
	/** Current mark, or0 when unknown. */
	mark: number;
}): number | undefined {
	if (input.orderType === "scale") {
		const start = Number(input.scaleStartInput);
		const end = Number(input.scaleEndInput);
		const s = Number.isFinite(start) && start > 0 ? start : undefined;
		const e = Number.isFinite(end) && end > 0 ? end : undefined;
		if (s !== undefined && e !== undefined) return (s + e) / 2;
		if (s !== undefined) return s;
		if (e !== undefined) return e;
		return input.mark > 0 ? input.mark : undefined;
	}
	const limit = Number(input.limitPriceInput);
	if (Number.isFinite(limit) && limit > 0) return limit;
	return input.mark > 0 ? input.mark : undefined;
}

export interface FormDraftInput {
	orderType: string;
	/** Scale distribution curves + size context for the per-rung size labels. */
	scalePriceDist?: number[] | null;
	scaleAmountDist?: number[] | null;
	sizeValue?: number;
	szDecimals?: number;
	limitPriceInput: string;
	tpSlEnabled: boolean;
	/** capabilities.hasTpSl && canUseTpSl(orderType) — computed by the caller's market context. */
	tpSlAllowed: boolean;
	tpPriceInput: string;
	slPriceInput: string;
	scalePreview: boolean;
	scaleStartInput: string;
	scaleEndInput: string;
	scaleLevels: number;
}

/**
 * The form's canvas drafts — ONE source of truth for both canvas variants:
 * a limit line when a limit price is typed, TP/SL lines while toggled on, and the
 * scale ladder while previewing. Empty when nothing applies.
 */
export function computeFormDrafts(input: FormDraftInput): {
	price: number;
	kind: PreviewKind;
	scaleLevels?: number;
	rungSizeText?: string;
}[] {
	const drafts: { price: number; kind: PreviewKind; scaleLevels?: number; rungSizeText?: string }[] = [];
	const limit = Number(input.limitPriceInput);
	if (input.orderType === "limit" && Number.isFinite(limit) && limit > 0) {
		drafts.push({ price: limit, kind: "limit" });
	}
	if (input.tpSlEnabled && input.tpSlAllowed) {
		const tp = Number(input.tpPriceInput);
		const sl = Number(input.slPriceInput);
		if (Number.isFinite(tp) && tp > 0) drafts.push({ price: tp, kind: "tp" });
		if (Number.isFinite(sl) && sl > 0) drafts.push({ price: sl, kind: "sl" });
	}
	if (input.orderType === "scale" && input.scalePreview) {
		const start = Number(input.scaleStartInput);
		const end = Number(input.scaleEndInput);
		const hasStart = Number.isFinite(start) && start > 0;
		const hasEnd = Number.isFinite(end) && end > 0;
		if (hasStart && hasEnd && canPreviewScale(input.scaleStartInput, input.scaleEndInput, input.scaleLevels)) {
			const prices = getScaleLevelPrices(
				input.scaleStartInput,
				input.scaleEndInput,
				input.scaleLevels,
				input.scalePriceDist,
			);
			const rungSizeTexts =
				input.sizeValue !== undefined && input.sizeValue > 0 && input.szDecimals !== undefined
					? getScaleLevelSizes(input.sizeValue, prices.length, input.szDecimals, input.scaleAmountDist)
					: null;
			const lastIndex = prices.length - 1;
			prices.forEach((priceText, index) => {
				const price = Number(priceText);
				if (!Number.isFinite(price) || price <= 0) return;
				let kind: PreviewKind = "scaleMid";
				if (index === 0) kind = "scaleStart";
				else if (index === lastIndex) kind = "scaleEnd";
				drafts.push({ price, kind, scaleLevels: prices.length, rungSizeText: rungSizeTexts?.[index] });
			});
		} else {
			// Partial: preview whichever end exists as its own line so the field the
			// user is typing (or just picked on the chart) always maps to a line.
			if (hasStart) drafts.push({ price: start, kind: "scaleStart" });
			if (hasEnd) drafts.push({ price: end, kind: "scaleEnd" });
		}
	}
	return drafts;
}
