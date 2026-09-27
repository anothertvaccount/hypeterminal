import type { ExchangeOrder } from "@/config/trade";
import { formatPriceForOrder } from "@/domain/trade/orders";
import { isStopOrder, isTakeProfitOrder, type OpenOrder } from "@/lib/trade/open-orders";

/**
 * Chart line labels: every resting order and the open position
 * render as a row of bordered boxes on the canvas — order type, projected PnL if the
 * order hits, the cumulative PnL scenario, R/P flags, size, cancel ✕ — and the
 * position gets Long/Short, size, live uPnL and draggable TP/SL buttons.
 *
 * The two PnL numbers answer "how much am I up or down if this order hits":
 *  - first  = realized PnL of this order alone (reduce-only closes vs the current
 *             average entry; opening orders realize nothing, so +0.00 USD) —
 *             see `realizedIfHit` below;
 *  - second = the cumulative scenario (see ./chart-risk.ts): the mark trades to this
 *             order's price, every open order between the current mark and that price
 *             fills on the way, and the total is what the account is worth at that
 *             level (realized closes + the PnL of whatever position remains). Works
 *             with no position at all — the resting ladder alone produces the number.
 *
 * Kept free of the paper engine import so chart consumers and tests stay light; the
 * cumulative walker lives in ./chart-risk.ts.
 */

export type LabelTone = "buy" | "sell" | "up" | "down" | "tp" | "sl" | "preview";

export interface LabelSegment {
	/** Interactive boxes only: "cancel" on order lines, "tp"/"sl" on the position line, "preview" on form drafts. */
	key?: "cancel" | "tp" | "sl" | "preview";
	text: string;
	tone: LabelTone;
	/** Solid-fill badge (the Long/Short chip) instead of an outlined box. */
	filled?: boolean;
}

/** Normalized open order used by the label math — derived from the SDK shape. */
export interface ChartOrder {
	side: "B" | "A";
	/** Limit price for resting limits, trigger price for triggers. */
	price: number;
	/** Remaining size in base units. */
	size: number;
	reduceOnly: boolean;
	/** Time-in-force: shown verbatim as GTC/IOC, post-only (Alo) as "P". Null when unknown. */
	tif: "Gtc" | "Ioc" | "Alo" | null;
	isTrigger: boolean;
	tpsl: "tp" | "sl" | null;
}

export interface ChartLabelPosition {
	coin?: string;
	dex?: string;
	/** Signed position size in base units. */
	szi: number;
	entryPx: number;
}

export interface ChartLabelContext {
	position: ChartLabelPosition | null;
	/** Every open order on this market (the label's own order included). */
	orders: readonly ChartOrder[];
	/** Live mark; labels omit the PnL numbers until the first tick arrives. */
	mark?: number;
}

export interface LineOverlayResolution {
	segments: LabelSegment[];
	isBuy: boolean;
	/**
	 * Pixel row for the line + chips when they must stay pinned (the entry line never
	 * moves — during a TP/SL drag only the overlay's point tracks the pointer).
	 */
	lineY?: number;
	/** Floating preview row drawn at the drag point (the TP/SL chip). */
	ghost?: {
		y: number;
		/** Chip the dashed connector drops from (tp/sl box of the pinned row). */
		anchor?: "tp" | "sl";
		segments: LabelSegment[];
	};
}

export function chartOrderFromOpenOrder(order: OpenOrder): ChartOrder {
	const isTrigger = order.isTrigger;
	const rawTif = order.tif;
	const tif = rawTif === "Gtc" || rawTif === "Ioc" || rawTif === "Alo" ? rawTif : null;
	let tpsl: "tp" | "sl" | null = null;
	if (isTakeProfitOrder(order)) tpsl = "tp";
	else if (isStopOrder(order)) tpsl = "sl";
	return {
		side: order.side,
		price: Number(isTrigger ? order.triggerPx : order.limitPx),
		size: Number(order.sz),
		reduceOnly: order.reduceOnly,
		tif,
		isTrigger,
		tpsl,
	};
}

export function formatSignedUsd(value: number): string {
	if (!Number.isFinite(value)) return "+0.00 USD";
	const normalized = Math.abs(value) < 0.005 ? 0 : value;
	const sign = normalized < 0 ? "-" : "+";
	return `${sign}${Math.abs(normalized).toFixed(2)} USD`;
}

export function formatUsd(value: number): string {
	if (!Number.isFinite(value)) return "0.00 USD";
	return `${Math.abs(value).toFixed(2)} USD`;
}

/** Order type word shown at the head of the label. */
export function orderTypeWord(order: ChartOrder): string {
	if (order.isTrigger) {
		if (order.tpsl === "tp") return "TP";
		if (order.tpsl === "sl") return "SL";
		return "Stop";
	}
	return "Limit";
}

/**
 * "[R, GTC]"-style flags: R = reduce-only, then the time-in-force — GTC and IOC
 * verbatim, post-only (Alo) as "P". Empty string when there is nothing to flag.
 */
export function orderFlagsText(order: ChartOrder): string {
	const flags: string[] = [];
	if (order.reduceOnly) flags.push("R");
	if (order.tif === "Gtc") flags.push("GTC");
	else if (order.tif === "Ioc") flags.push("IOC");
	else if (order.tif === "Alo") flags.push("P");
	return flags.length > 0 ? ` [${flags.join(", ")}]` : "";
}

/**
 * PnL this single order realizes if it fills: reduce-only closes against the current
 * average entry; opening orders realize nothing (+0.00 USD). This is the label's
 * first number.
 */
export function realizedIfHit(order: ChartOrder, position: ChartLabelPosition | null): number {
	if (!order.reduceOnly || !position || position.szi === 0) return 0;
	const closed = Math.min(order.size, Math.abs(position.szi));
	if (position.szi > 0 && order.side === "A") return closed * (order.price - position.entryPx);
	if (position.szi < 0 && order.side === "B") return closed * (position.entryPx - order.price);
	return 0;
}

/** Segments for the position's chart label: side badge, size, live uPnL, TP/SL buttons. */
export function buildPositionSegments(position: ChartLabelPosition, mark: number | undefined): LineOverlayResolution {
	const isLong = position.szi > 0;
	const tone: LabelTone = isLong ? "buy" : "sell";
	const effectiveMark = mark !== undefined && mark > 0 ? mark : position.entryPx;
	const notional = Math.abs(position.szi) * effectiveMark;
	const pnl = position.szi * (effectiveMark - position.entryPx);
	const segments: LabelSegment[] = [
		{ text: isLong ? "Long" : "Short", tone, filled: true },
		{ text: formatUsd(notional), tone },
	];
	if (mark !== undefined && mark > 0) {
		segments.push({ text: formatSignedUsd(pnl), tone: pnl < 0 ? "down" : "up" });
	}
	segments.push({ text: "TP", tone: "tp", key: "tp" });
	segments.push({ text: "SL", tone: "sl", key: "sl" });
	return { isBuy: isLong, segments };
}

/**
 * Floating TP/SL preview chip shown at the drop price while dragging: the realized
 * PnL if the trigger hits, the side, and the return in percent from the entry —
 * `+$20.17 │ TP │ +6.01%`. pct is direction-aware (a short's
 * take-profit below entry reports a positive return).
 */
export function buildTpSlGhostSegments(params: {
	tpsl: "tp" | "sl";
	entryPx: number;
	szi: number;
	price: number;
}): LabelSegment[] {
	const tone: LabelTone = params.tpsl === "tp" ? "tp" : "sl";
	const word = params.tpsl === "tp" ? "TP" : "SL";
	const segments: LabelSegment[] = [];

	if (Number.isFinite(params.price) && params.price > 0 && params.entryPx > 0 && params.szi !== 0) {
		const pnl = params.szi * (params.price - params.entryPx);
		const notional = Math.abs(params.szi) * params.entryPx;
		const pct = notional > 0 ? (pnl / notional) * 100 : Number.NaN;
		segments.push({ text: formatSignedUsd(pnl), tone });
		segments.push({ text: word, tone, filled: true });
		if (Number.isFinite(pct)) {
			const sign = pct < 0 ? "-" : "+";
			segments.push({ text: `${sign}${Math.abs(pct).toFixed(2)}%`, tone });
		}
		return segments;
	}

	segments.push({ text: word, tone, filled: true });
	return segments;
}

/**
 * Plan for attaching a TP/SL trigger to an EXISTING position (position-line drag,
 * axis menu, V/B chart hotkeys). The grouping must be `positionTpsl`: Hyperliquid
 * rejects a trigger-only batch under `normalTpsl` with
 * "Main order cannot be trigger order" — normalTpsl reserves the first slot for a
 * main entry order, while positionTpsl is exactly "triggers against a position".
 * Sized orders are kept (partial TP/SL percentages), reduce-only as always.
 */
export function buildPositionTriggerPlan(order: ExchangeOrder): { orders: ExchangeOrder[]; grouping: "positionTpsl" } {
	return { orders: [order], grouping: "positionTpsl" };
}

/** Reduce-only market trigger used by the TP/SL button drag — 100% of the position. */
export function buildTpSlExchangeOrder(params: {
	assetId: number;
	isBuy: boolean;
	size: string;
	triggerPrice: number;
	tpsl: "tp" | "sl";
}): ExchangeOrder {
	const triggerPx = formatPriceForOrder(params.triggerPrice);
	return {
		a: params.assetId,
		b: params.isBuy,
		p: triggerPx,
		s: params.size,
		r: true,
		t: { trigger: { isMarket: true, triggerPx, tpsl: params.tpsl } },
	};
}
