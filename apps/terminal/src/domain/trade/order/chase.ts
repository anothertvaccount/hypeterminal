import { ORDER_MIN_NOTIONAL_USD } from "@/config/trade";
import { szDecimalsToPriceDecimals } from "@/lib/format";

/**
 * Client-side chase limit (Hyperliquid has NO native chase order — the SDK's order
 * schema only knows Gtc/Ioc/Alo/FrontendMarket limits and triggers, so this mirrors
 * what chase UIs do: place a limit at the real top of book, keep re-pricing it to
 * the touch until it fills, cancel after a timeout).
 *
 * Placement is priced from a **fresh book snapshot** (best bid for buys, best ask
 * for sells) — non-marketable by construction, which is what makes the post-only
 * (Alo) option safe and keeps the order on the maker side. The mark-derived
 * fallback below is preview-only/GTC-only: `mark − tick` can sit above the live
 * ask, so Alo must never use it (Hyperliquid rejects marketable post-only orders).
 */

/** Auto-cancel when the chase has not filled within this long. */
export const CHASE_TIMEOUT_MS = 30_000;
/** Minimum gap between re-price modifications sent to the exchange. */
export const CHASE_MODIFY_INTERVAL_MS = 750;
/**
 * Live `openOrders` snapshots arrive only after the placement ACK (the first tick
 * can run before the just-placed order is visible; preview is synchronous and
 * never hits this) — wait this long for the order to appear before concluding the
 * chase cannot track it.
 */
export const CHASE_TRACK_GRACE_MS = 5_000;
/** Placement re-fetches of the book after a benign post-only race rejection. */
export const CHASE_PLACE_MAX_RETRIES = 2;

export interface ChaseEntry {
	coin: string;
	/** Position dex — lets a close-mode chase look its position up (builder markets too). */
	dex?: string;
	side: "buy" | "sell";
	/** Submitted (formatted) size — matched against the resting order's origSz. */
	sizeText: string;
	reduceOnly: boolean;
	startedAt: number;
	/**
	 * "entry" chases time out after CHASE_TIMEOUT_MS (you were entering — a stale
	 * resting order is unwanted). "close" chases NEVER time out: they ride the touch
	 * until the position is flat (or the remainder can't fill an order), which is
	 * what a chase close must do. Derived from reduceOnly at hand-off.
	 */
	mode?: "entry" | "close";
}

/**
 * Starting price one tick behind the mark. Safe unconditionally as GTC: if the
 * book is already through this price the order fills at ≤ it (a post-only order
 * would be rejected — Hyperliquid refuses marketable Alo) and, in preview, it
 * rests until the mark trades through — the book-less fallback until the engine
 * can re-price to the real top of book.
 */
export function chaseBehindMarkPrice(side: "buy" | "sell", markPx: number, szDecimals: number): number {
	const tick = 10 ** -szDecimalsToPriceDecimals(szDecimals);
	const base = Number.isFinite(markPx) && markPx > 0 ? markPx : 0;
	const price = side === "buy" ? base - tick : base + tick;
	return price > 0 ? price : tick;
}

export interface ChaseBookLevel {
	px?: string;
}
/** l2Book snapshot shape: index 0 = bids, index 1 = asks. */
export type ChaseBookLevels = readonly [readonly ChaseBookLevel[], readonly ChaseBookLevel[]];

/**
 * The real touch from a book snapshot: best bid for buys, best ask for sells
 * (null when the snapshot is missing/empty — e.g. before the first event).
 */
export function chaseBookTouch(side: "buy" | "sell", levels: ChaseBookLevels | undefined | null): number | null {
	const sideLevels = levels?.[side === "buy" ? 0 : 1];
	const best = Array.isArray(sideLevels) ? sideLevels[0] : undefined;
	const px = Number(best?.px);
	return best?.px !== undefined && Number.isFinite(px) && px > 0 ? px : null;
}

/**
 * Placement price for a chase limit: the book touch when a snapshot is available
 * (non-marketable by construction — post-only-safe and maker-side). Without a
 * book: post-only must not guess (null → the caller surfaces an error), while GTC
 * may fall back to `mark − tick` (preview, or a transient info-API failure).
 */
export function chasePlacementPrice(
	side: "buy" | "sell",
	levels: ChaseBookLevels | undefined | null,
	markPx: number,
	szDecimals: number,
	tif: "Gtc" | "Ioc" | "Alo" | "FrontendMarket",
): number | null {
	const touch = chaseBookTouch(side, levels);
	if (touch !== null) return touch;
	if (tif === "Alo") return null;
	return chaseBehindMarkPrice(side, markPx, szDecimals);
}

/**
 * Hyperliquid's benign post-only rejection: the book moved through the price
 * between our read and the exchange's matching. Not a failure — re-fetch and
 * retry (placement) or simply re-price next tick (engine).
 */
export function isPostOnlyRaceError(message: string | null | undefined): boolean {
	if (!message) return false;
	return /post only|immediately matched/i.test(message);
}

export interface ChaseOrderLike {
	coin: string;
	side: string;
	origSz: string;
	isTrigger: boolean;
	reduceOnly: boolean;
}

/** The resting order this chase entry manages: same coin, side, size; not a trigger. */
export function findChaseOrder<T extends ChaseOrderLike>(orders: readonly T[], entry: ChaseEntry): T | undefined {
	const wantedSide = entry.side === "buy" ? "B" : "A";
	return orders.find(
		(order) =>
			order.coin === entry.coin &&
			order.side === wantedSide &&
			!order.isTrigger &&
			order.reduceOnly === entry.reduceOnly &&
			String(order.origSz) === entry.sizeText,
	);
}

/** True once the chase has run out of time and must be cancelled. */
export function shouldCancelChase(startedAt: number, now: number, timeoutMs: number): boolean {
	return now - startedAt >= timeoutMs;
}

/**
 * True while a chase whose order has never been spotted should keep waiting for
 * the snapshot in flight instead of concluding it is already gone.
 */
export function shouldWaitForOrderSnapshot(startedAt: number, now: number): boolean {
	return now - startedAt < CHASE_TRACK_GRACE_MS;
}

/** How a chase ended: engine-known outcomes in preview, neutral "completed" live. */
export type ChaseOutcome = "filled" | "cancelled" | "timeout" | "error" | "completed";

/**
 * Outcome for a chase whose resting order disappeared: preview records whether the
 * book filled it or it was cancelled (paper store tracks oids); live can only report
 * "completed" (filled or cancelled externally — the chime/toasts cover the rest).
 */
export function resolveChaseOutcome(outcomeByOid: Record<number, ChaseOutcome>, oid: number | undefined): ChaseOutcome {
	if (oid !== undefined) {
		const hit = outcomeByOid[oid];
		if (hit) return hit;
	}
	return "completed";
}

/** What a close chase should do on one tick. */
export type CloseChaseAction = "wait" | "replace" | "completed" | "dust";

/**
 * Decision for a close chase whose order is (or may not be) on the book.
 *
 * The important rule: `remaining === null` means the position is NOT KNOWN yet
 * (the snapshot is still in flight) and must never be treated as flat. Reading
 * unknown data as flat cancels a live resting order and retires the chase as
 * "completed" — which is exactly how a phone chase stopped after ~40s while the
 * position was still open. A close chase keeps going until the position is flat:
 * order gone + position open means RE-POST, not give up.
 */
export function nextCloseChaseAction(input: {
	/** null = position unknown (snapshot in flight). */
	remaining: { szi: number; closeable: string } | null;
	/** Mark used for the sub-minimum-notional (dust) test. */
	markPx: number;
}): CloseChaseAction {
	const { remaining } = input;
	if (remaining === null) return "wait";
	if (remaining.szi === 0) return "completed";
	const closeable = Number(remaining.closeable);
	if (!(closeable > 0) || Math.abs(remaining.szi) * input.markPx < ORDER_MIN_NOTIONAL_USD) return "dust";
	return "replace";
}
