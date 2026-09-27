import type { Position } from "@hypeterminal/hl-react";
import { isSpotAssetId } from "@hypeterminal/hl-react";
import { PAPER_BALANCE_USD, PAPER_DEFAULT_LEVERAGE } from "@/config/paper";
import { type ExchangeOrder, OPEN_ORDER_TYPE_PREFIXES } from "@/config/trade";
import type { OrderResult } from "@/lib/trade/extract-order-status";
import { NO_EXCHANGE_RESPONSE } from "@/lib/trade/extract-order-status";
import type { MarginMode } from "@/lib/trade/margin-mode";
import type { OpenOrder } from "@/lib/trade/open-orders";

export interface PaperPosition {
	assetId: number;
	coin: string;
	dex?: string;
	/** Signed position size in base units. */
	szi: number;
	entryPx: number;
	leverage: number;
	marginMode: MarginMode;
}

export interface PaperFill {
	assetId: number;
	/** Empty when the fill only reduces an already-tracked position. */
	coin: string;
	dex?: string;
	isBuy: boolean;
	size: number;
	price: number;
	reduceOnly: boolean;
	isTrigger: boolean;
	leverage: number;
	marginMode: MarginMode;
}

export interface PaperOrderMeta {
	coin?: string;
	dex?: string;
	leverage?: number;
	marginMode?: MarginMode;
}

/** A limit order resting on the simulated book — drawn on the chart and draggable. */
export interface PaperOpenOrder {
	oid: number;
	assetId: number;
	coin: string;
	dex?: string;
	isBuy: boolean;
	/** Remaining size in base units. */
	size: number;
	limitPx: number;
	reduceOnly: boolean;
	leverage: number;
	marginMode: MarginMode;
	tif: "Gtc" | "Alo";
	placedAt: number;
	/** Resting trigger (stop entry / TP / SL): fires when the mark trades through triggerPx. */
	isTrigger?: boolean;
	triggerPx?: number;
	tpsl?: "tp" | "sl";
	isMarketTrigger?: boolean;
}

export interface PaperPlanSplit {
	/** Executable legs (market/IOC + trigger entries) applied to positions immediately. */
	fills: PaperFill[];
	/** Gtc/Alo limit legs that rest on the simulated book. */
	resting: PaperOpenOrder[];
}

/** Two times the smallest double precision step at position scale — below this a position counts as closed. */
const CLOSE_EPSILON = 1e-12;

let lastPaperOid = 1_000_000_000;

function nextPaperOid(): number {
	lastPaperOid += 1;
	return lastPaperOid;
}

/** Ensures newly allocated oids never collide with ids restored from persistence. */
export function seedPaperOid(minOid: number): void {
	if (Number.isFinite(minOid) && minOid > lastPaperOid) lastPaperOid = minOid;
}

/** Test hook: resets oid allocation so assertions can be deterministic. */
export function resetPaperOidCounter(): void {
	lastPaperOid = 1_000_000_000;
}

interface PaperQuoteRow {
	coin: string;
	token: number;
	total: string;
	hold: string;
	entryNtl: string;
}

export function sumPaperMarginUsed(positions: readonly PaperPosition[]): number {
	let total = 0;
	for (const position of positions) {
		if (position.leverage <= 0) continue;
		total += (Math.abs(position.szi) * position.entryPx) / position.leverage;
	}
	return total;
}

export function paperAvailableUsdc(positions: readonly PaperPosition[], realizedUsd = 0): number {
	return Math.max(0, PAPER_BALANCE_USD + realizedUsd - sumPaperMarginUsed(positions));
}

/**
 * Signed units that left the book when a fill transitioned `oldSzi` → `newSzi`:
 * positive when long units closed, negative when short units covered. Zero when the
 * fill only added. Shared by the balance accounting and the chart's risk labels.
 */
export function closedUnitsRemoved(oldSzi: number, newSzi: number): number {
	if (oldSzi === 0) return 0;
	if (newSzi === 0) return oldSzi;
	if (Math.sign(newSzi) === Math.sign(oldSzi)) {
		return Math.abs(newSzi) < Math.abs(oldSzi) ? oldSzi - newSzi : 0;
	}
	return oldSzi;
}

/** Realized PnL of one fill: units closed × (fill price − the entry they carried). */
export function paperRealizedForFill(
	before: readonly PaperPosition[],
	after: readonly PaperPosition[],
	fill: PaperFill,
): number {
	const old = before.find((position) => position.assetId === fill.assetId);
	if (!old) return 0;
	const next = after.find((position) => position.assetId === fill.assetId);
	return closedUnitsRemoved(old.szi, next?.szi ?? 0) * (fill.price - old.entryPx);
}

/**
 * Pure netting for one simulated fill. Opens, adds, reduces, closes, and reverses positions;
 * skips conditional TP/SL resting on an open position and reduce-only fills with nothing to reduce.
 */
export function applyPaperFill(positions: readonly PaperPosition[], fill: PaperFill): PaperPosition[] {
	if (!Number.isFinite(fill.size) || fill.size <= 0) return [...positions];
	if (!Number.isFinite(fill.price) || fill.price <= 0) return [...positions];

	const index = positions.findIndex((p) => p.assetId === fill.assetId);
	const existing = index === -1 ? undefined : positions[index];

	// Trigger orders (stop entries, TP/SL) are acknowledged but never move preview positions.
	if (fill.isTrigger) return [...positions];
	// Reduce-only entries with nothing to reduce have nothing to do.
	if (!existing && fill.reduceOnly) return [...positions];
	// A fresh position needs a coin name to be displayed.
	if (!existing && !fill.coin) return [...positions];

	const delta = (fill.isBuy ? 1 : -1) * fill.size;

	if (!existing) {
		return [
			...positions,
			{
				assetId: fill.assetId,
				coin: fill.coin,
				dex: fill.dex,
				szi: delta,
				entryPx: fill.price,
				leverage: fill.leverage > 0 ? fill.leverage : PAPER_DEFAULT_LEVERAGE,
				marginMode: fill.marginMode,
			},
		];
	}

	let nextSzi = existing.szi + delta;
	// Reduce-only can close a position but never flip it.
	if (fill.reduceOnly && Math.sign(nextSzi) !== Math.sign(existing.szi)) {
		nextSzi = 0;
	}
	if (Math.abs(nextSzi) <= CLOSE_EPSILON) {
		return positions.filter((_, i) => i !== index);
	}

	let entryPx = existing.entryPx;
	if (Math.sign(nextSzi) !== Math.sign(existing.szi)) {
		// Reversed through zero — the remainder opens at the fill price.
		entryPx = fill.price;
	} else if (Math.sign(delta) === Math.sign(existing.szi)) {
		// Added to the same side — weighted average entry.
		entryPx = (Math.abs(existing.szi) * existing.entryPx + Math.abs(delta) * fill.price) / Math.abs(nextSzi);
	}

	const updated: PaperPosition = {
		...existing,
		szi: nextSzi,
		entryPx,
		coin: fill.coin || existing.coin,
		dex: fill.dex ?? existing.dex,
	};
	return [...positions.slice(0, index), updated, ...positions.slice(index + 1)];
}

export type PaperMarketResolver = (assetId: number) => { coin: string; dex?: string } | undefined;

function isRestingLimitTif(tif: string | undefined): tif is "Gtc" | "Alo" {
	return tif === "Gtc" || tif === "Alo";
}

/**
 * Splits a simulated plan: market/IOC legs fill now, Gtc/Alo limits and perp/builder
 * triggers rest on the simulated book (drawable, draggable, cancelable — triggers fire
 * from the fill engine when the mark trades through them). Spot executable and spot
 * trigger legs are acknowledged but not tracked — preview spot balances are static.
 */
export function splitPaperPlan(
	orders: readonly ExchangeOrder[],
	meta: PaperOrderMeta | undefined,
	resolve: PaperMarketResolver,
): PaperPlanSplit {
	const fills: PaperFill[] = [];
	const resting: PaperOpenOrder[] = [];

	for (const order of orders) {
		const assetId = Number(order.a);
		const size = Number(order.s);
		const price = Number(order.p);
		const isTrigger = "trigger" in order.t;
		const tif = "limit" in order.t ? order.t.limit.tif : undefined;
		const info = resolve(assetId);
		const coin = meta?.coin ?? info?.coin ?? "";
		const dex = meta?.dex ?? info?.dex;

		if (isTrigger) {
			const trigger = "trigger" in order.t ? order.t.trigger : undefined;
			const rawTriggerPx = Number(trigger?.triggerPx ?? price);
			const triggerPx = Number.isFinite(rawTriggerPx) && rawTriggerPx > 0 ? rawTriggerPx : price;
			if (isSpotAssetId(assetId) || !coin) {
				// Spot triggers are acknowledged only — preview spot balances are static.
				fills.push({
					assetId,
					coin,
					dex,
					isBuy: order.b,
					size,
					price,
					reduceOnly: order.r,
					isTrigger: true,
					leverage: meta?.leverage ?? PAPER_DEFAULT_LEVERAGE,
					marginMode: meta?.marginMode ?? "cross",
				});
				continue;
			}
			// Perp/builder triggers rest so the chart can draw, drag and fire them —
			// stop entries, TPs and SLs all activate when the mark trades through.
			resting.push({
				oid: nextPaperOid(),
				assetId,
				coin,
				dex,
				isBuy: order.b,
				size,
				limitPx: price,
				reduceOnly: order.r,
				leverage: meta?.leverage ?? PAPER_DEFAULT_LEVERAGE,
				marginMode: meta?.marginMode ?? "cross",
				tif: "Gtc",
				placedAt: Date.now(),
				isTrigger: true,
				triggerPx,
				tpsl: trigger?.tpsl ?? undefined,
				isMarketTrigger: trigger?.isMarket ?? true,
			});
			continue;
		}

		if (isRestingLimitTif(tif)) {
			if (isSpotAssetId(assetId)) {
				// Spot limits rest for the chart but preview spot balances are static.
				if (coin) {
					resting.push({
						oid: nextPaperOid(),
						assetId,
						coin,
						dex,
						isBuy: order.b,
						size,
						limitPx: price,
						reduceOnly: order.r,
						leverage: meta?.leverage ?? PAPER_DEFAULT_LEVERAGE,
						marginMode: meta?.marginMode ?? "cross",
						tif,
						placedAt: Date.now(),
					});
				}
				continue;
			}
			if (coin) {
				resting.push({
					oid: nextPaperOid(),
					assetId,
					coin,
					dex,
					isBuy: order.b,
					size,
					limitPx: price,
					reduceOnly: order.r,
					leverage: meta?.leverage ?? PAPER_DEFAULT_LEVERAGE,
					marginMode: meta?.marginMode ?? "cross",
					tif,
					placedAt: Date.now(),
				});
			}
			continue;
		}

		// Market / IOC legs fill immediately. Spot executable legs are acknowledged but
		// not tracked — preview spot balances are static (perp/builder legs go to fills).
		if (isSpotAssetId(assetId)) continue;
		fills.push({
			assetId,
			coin,
			dex,
			isBuy: order.b,
			size,
			price,
			reduceOnly: order.r,
			isTrigger: false,
			leverage: meta?.leverage ?? PAPER_DEFAULT_LEVERAGE,
			marginMode: meta?.marginMode ?? "cross",
		});
	}

	return { fills, resting };
}

/**
 * Mirrors the real exchange's status derivation: executable fills report "Filled",
 * resting limits report "Placed", trigger-only plans report "Set".
 */
export function derivePaperResult(orders: readonly ExchangeOrder[], split: PaperPlanSplit): OrderResult {
	if (orders.length === 0) return { ok: false, error: NO_EXCHANGE_RESPONSE };
	if (split.fills.some((fill) => !fill.isTrigger)) return { ok: true, outcome: "filled" };
	if (split.resting.some((order) => !order.isTrigger)) return { ok: true, outcome: "resting" };
	return { ok: true, outcome: "triggerSet" };
}

/**
 * A resting limit crosses when the live mark trades through its price. A trigger
 * fires when the mark reaches its trigger price coming from the trigger's side:
 * TPs get reached from the losing direction, stops from the breakout direction.
 */
export function hasPaperLimitCrossed(
	order: Pick<PaperOpenOrder, "isBuy" | "limitPx" | "coin" | "isTrigger" | "triggerPx" | "tpsl">,
	marks: Record<string, string>,
): boolean {
	const raw = marks[order.coin];
	if (raw === undefined) return false;
	const mark = Number(raw);
	if (!Number.isFinite(mark) || mark <= 0) return false;
	if (order.isTrigger) {
		const triggerPx = order.triggerPx ?? order.limitPx;
		if (!Number.isFinite(triggerPx) || triggerPx <= 0) return false;
		// A take-profit for a long sits above and is reached by a rising mark;
		// a stop for a long sits below and is reached by a falling mark (and vice
		// versa for shorts) — (tpsl === "tp") !== isBuy captures both directions.
		const risesToTrigger = (order.tpsl === "tp") !== order.isBuy;
		return risesToTrigger ? mark >= triggerPx : mark <= triggerPx;
	}
	return order.isBuy ? mark <= order.limitPx : mark >= order.limitPx;
}

/**
 * Price a resting order executes at: triggers fill at their trigger price; limits
 * get price improvement — a marketable fill never prices worse than the mark.
 * Single source for the fill engine and the fill notifications.
 */
export function restingExecutionPrice(
	order: Pick<PaperOpenOrder, "isBuy" | "limitPx" | "coin" | "isTrigger" | "triggerPx">,
	marks: Record<string, string>,
): number {
	if (order.isTrigger) return order.triggerPx ?? order.limitPx;
	const markValue = Number(marks[order.coin]);
	if (!Number.isFinite(markValue) || markValue <= 0) return order.limitPx;
	return order.isBuy ? Math.min(order.limitPx, markValue) : Math.max(order.limitPx, markValue);
}

/**
 * Collects resting orders the mark has crossed: they leave the book and (for perps)
 * become positions via the shared netting rules. Pure — the store just commits the result.
 */
export function collectPaperFills(
	positions: readonly PaperPosition[],
	openOrders: readonly PaperOpenOrder[],
	marks: Record<string, string>,
): { positions: PaperPosition[]; filled: PaperOpenOrder[]; remaining: PaperOpenOrder[]; realized: number } {
	const filled: PaperOpenOrder[] = [];
	const remaining: PaperOpenOrder[] = [];
	let nextPositions: PaperPosition[] = [...positions];
	let realized = 0;

	for (const order of openOrders) {
		if (!hasPaperLimitCrossed(order, marks)) {
			remaining.push(order);
			continue;
		}
		filled.push(order);
		if (isSpotAssetId(order.assetId)) continue; // spot fills don't move perp positions
		// Fill price: marketable orders execute at the market, never worse than the limit
		// (dragging a buy above the mark opens at the current price, like a real book).
		const crossedPrice = restingExecutionPrice(order, marks);
		const fill: PaperFill = {
			assetId: order.assetId,
			coin: order.coin,
			dex: order.dex,
			isBuy: order.isBuy,
			size: order.size,
			price: crossedPrice,
			reduceOnly: order.reduceOnly,
			isTrigger: false,
			leverage: order.leverage,
			marginMode: order.marginMode,
		};
		const before = nextPositions;
		nextPositions = applyPaperFill(before, fill);
		realized += paperRealizedForFill(before, nextPositions, fill);
	}

	return { positions: nextPositions, filled, remaining, realized };
}

/** Maps a resting paper order into the SDK open-order shape so tables render unchanged. */
export function toOpenOrder(order: PaperOpenOrder): OpenOrder {
	if (order.isTrigger) {
		const triggerPx = order.triggerPx ?? order.limitPx;
		const risesToTrigger = (order.tpsl === "tp") !== order.isBuy;
		const kind = order.tpsl === "tp" ? OPEN_ORDER_TYPE_PREFIXES.takeProfit : OPEN_ORDER_TYPE_PREFIXES.stop;
		const execution = order.isMarketTrigger === false ? "Limit" : "Market";
		return {
			coin: order.coin,
			side: order.isBuy ? "B" : "A",
			limitPx: String(order.limitPx),
			sz: String(order.size),
			oid: order.oid,
			timestamp: order.placedAt,
			origSz: String(order.size),
			triggerCondition: risesToTrigger ? ">=" : "<=",
			isTrigger: true,
			triggerPx: String(triggerPx),
			children: [],
			isPositionTpsl: false,
			reduceOnly: order.reduceOnly,
			orderType: `${kind} ${execution}`,
			tif: order.tif,
			cloid: null,
		};
	}
	return {
		coin: order.coin,
		side: order.isBuy ? "B" : "A",
		limitPx: String(order.limitPx),
		sz: String(order.size),
		oid: order.oid,
		timestamp: order.placedAt,
		origSz: String(order.size),
		triggerCondition: "",
		isTrigger: false,
		triggerPx: "0",
		children: [],
		isPositionTpsl: false,
		reduceOnly: order.reduceOnly,
		orderType: "Limit",
		tif: order.tif,
		cloid: null,
	};
}

/** Ensures the selected market's quote token has a simulated balance row (non-USDC quotes included). */
export function withPaperQuoteToken(rows: readonly PaperQuoteRow[], quoteCoin: string): PaperQuoteRow[] {
	const existing = rows.find((row) => row.coin === quoteCoin);
	const total = String(PAPER_BALANCE_USD);
	const row: PaperQuoteRow = existing
		? { ...existing, total, hold: "0", entryNtl: total }
		: { coin: quoteCoin, token: 0, total, hold: "0", entryNtl: total };
	return [...rows.filter((r) => r.coin !== quoteCoin), row];
}

/** Builds hl-react Position rows from paper state, using live marks when available. */
export function buildPaperUserPositions(
	positions: readonly PaperPosition[],
	mids: Record<string, string> | undefined,
	maxLeverage: number,
): Position[] {
	const rows: Position[] = [];
	for (const p of positions) {
		const markRaw = mids ? Number(mids[p.coin]) : Number.NaN;
		const mark = Number.isFinite(markRaw) && markRaw > 0 ? markRaw : p.entryPx;
		const positionValue = Math.abs(p.szi) * mark;
		const unrealizedPnl = (mark - p.entryPx) * p.szi;
		const marginUsed = p.leverage > 0 ? (Math.abs(p.szi) * p.entryPx) / p.leverage : 0;
		const returnOnEquity = marginUsed > 0 ? unrealizedPnl / marginUsed : 0;
		rows.push({
			dex: p.dex ?? "",
			coin: p.coin,
			szi: String(p.szi),
			entryPx: String(p.entryPx),
			positionValue: String(positionValue),
			unrealizedPnl: String(unrealizedPnl),
			returnOnEquity: String(returnOnEquity),
			liquidationPx: null,
			marginUsed: String(marginUsed),
			maxLeverage,
			leverage:
				p.marginMode === "isolated"
					? { type: "isolated", value: p.leverage, rawUsd: String(marginUsed) }
					: { type: "cross", value: p.leverage },
			cumFunding: { allTime: "0", sinceOpen: "0", sinceChange: "0" },
		});
	}
	return rows;
}
