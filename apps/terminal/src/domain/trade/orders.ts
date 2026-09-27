import {
	DEFAULT_LEVERAGE_FALLBACK,
	type ExchangeOrder,
	HL_PRICE_MAX_DECIMALS,
	HL_PRICE_MAX_SIG_FIGS,
	type LimitTif,
	type OrderType,
	SCALE_LEVELS_MAX,
	SCALE_LEVELS_MIN,
} from "@/config/trade";
import { getExecutedPrice } from "@/domain/trade/order/price";
import { sampleScaleCurve } from "@/domain/trade/order/scale-distribution";
import { clampInt, formatDecimalFloor, isPositive, toBig, toSafeBig } from "@/lib/trade/numbers";
import { isScaleOrderType, isStopOrderType, isTriggerOrderType, usesLimitPrice } from "@/lib/trade/order-types";
import type { Side } from "@/lib/trade/types";

export interface EntryOrderParams {
	assetId: number;
	side: Side;
	orderType: OrderType;
	sizeValue: number;
	szDecimals: number;
	markPx: number;
	price: number;
	slippageBps: number;
	reduceOnly: boolean;
	tif: LimitTif;
	limitPriceInput: string;
	triggerPriceInput: string;
	scaleStartPriceInput: string;
	scaleEndPriceInput: string;
	scaleLevelsNum: number | null;
	/** Optional interactive distribution curves (null/absent = linear prices / uniform sizes). */
	scalePriceDist?: number[] | null;
	scaleAmountDist?: number[] | null;
	tpSlEnabled: boolean;
	canUseTpSl: boolean;
	tpPriceNum: number | null;
	slPriceNum: number | null;
}

export interface OrderBuildResult {
	orders: ExchangeOrder[];
	grouping: "normalTpsl" | "positionTpsl" | "na";
}

export function buildOrders(params: EntryOrderParams): OrderBuildResult {
	const {
		assetId,
		side,
		orderType,
		sizeValue,
		szDecimals,
		markPx,
		price,
		slippageBps,
		reduceOnly,
		tif,
		limitPriceInput,
		triggerPriceInput,
		scaleStartPriceInput,
		scaleEndPriceInput,
		scaleLevelsNum,
		scalePriceDist,
		scaleAmountDist,
		tpSlEnabled,
		canUseTpSl,
		tpPriceNum,
		slPriceNum,
	} = params;

	const isScaleOrder = isScaleOrderType(orderType);
	const isTriggerOrder = isTriggerOrderType(orderType);
	const isStopOrder = isStopOrderType(orderType);
	const usesLimitPriceForOrder = usesLimitPrice(orderType);

	const orders: ExchangeOrder[] = [];
	const formattedSize = formatSizeForOrder(sizeValue, szDecimals);
	const hasTp = tpSlEnabled && canUseTpSl && isPositive(tpPriceNum);
	const hasSl = tpSlEnabled && canUseTpSl && isPositive(slPriceNum);
	const isBuy = side === "buy";

	if (isScaleOrder) {
		buildScaleOrders(orders, {
			assetId,
			isBuy,
			sizeValue,
			szDecimals,
			reduceOnly,
			tif,
			scaleStartPriceInput,
			scaleEndPriceInput,
			scaleLevelsNum,
			scalePriceDist,
			scaleAmountDist,
		});
	} else if (isTriggerOrder) {
		buildTriggerOrder(orders, {
			assetId,
			isBuy,
			formattedSize,
			triggerPriceInput,
			limitPriceInput,
			isStopOrder,
			usesLimitPriceForOrder,
		});
	} else {
		buildStandardOrder(orders, {
			assetId,
			isBuy,
			orderType,
			formattedSize,
			markPx,
			price,
			slippageBps,
			reduceOnly,
			// Chase keeps the form's tif — post-only (Alo) is safe because
			// use-order-submit prices the placement from a fresh book snapshot.
			tif,
		});
	}

	// TP/SL legs attach to ANY entry main — including the scale ladder (the ladder's
	// total size closes across the shared full-size reduce-only triggers; grouping
	// stays normalTpsl, mains first).
	if (hasTp && tpPriceNum !== null) {
		buildTpSlOrder(orders, { assetId, isBuy: !isBuy, formattedSize, triggerPrice: tpPriceNum, tpsl: "tp" });
	}
	if (hasSl && slPriceNum !== null) {
		buildTpSlOrder(orders, { assetId, isBuy: !isBuy, formattedSize, triggerPrice: slPriceNum, tpsl: "sl" });
	}

	return { orders, grouping: hasTp || hasSl ? "normalTpsl" : "na" };
}

interface ScaleOrderParams {
	assetId: number;
	scalePriceDist?: number[] | null;
	scaleAmountDist?: number[] | null;
	isBuy: boolean;
	sizeValue: number;
	szDecimals: number;
	reduceOnly: boolean;
	tif: LimitTif;
	scaleStartPriceInput: string;
	scaleEndPriceInput: string;
	scaleLevelsNum: number | null;
}

function buildScaleOrders(orders: ExchangeOrder[], params: ScaleOrderParams): void {
	// Same helpers the canvas preview uses — the ladder you see is the ladder that ships.
	const levels = clampInt(Math.round(params.scaleLevelsNum ?? SCALE_LEVELS_MIN), SCALE_LEVELS_MIN, SCALE_LEVELS_MAX);
	const prices = getScaleLevelPrices(
		params.scaleStartPriceInput,
		params.scaleEndPriceInput,
		levels,
		params.scalePriceDist,
	);
	const sizes = getScaleLevelSizes(params.sizeValue, levels, params.szDecimals, params.scaleAmountDist);

	for (let i = 0; i < levels; i += 1) {
		orders.push({
			a: params.assetId,
			b: params.isBuy,
			p: prices[i],
			s: sizes[i],
			r: params.reduceOnly,
			t: { limit: { tif: params.tif } },
		});
	}
}

/**
 * Level prices for a scale ladder — mirrors buildScaleOrders' math exactly (Big
 * step division + Hyperliquid price formatting) so the canvas preview lands on
 * precisely the prices the submitted orders would.
 */
export function getScaleLevelPrices(
	startPriceInput: string,
	endPriceInput: string,
	scaleLevelsNum: number | null,
	scalePriceDist?: readonly number[] | null,
): string[] {
	const levels = clampInt(Math.round(scaleLevelsNum ?? SCALE_LEVELS_MIN), SCALE_LEVELS_MIN, SCALE_LEVELS_MAX);
	const start = toSafeBig(startPriceInput);
	const end = toSafeBig(endPriceInput);
	const prices: string[] = [];
	if (!scalePriceDist || scalePriceDist.length === 0) {
		// Legacy linear path — kept byte-identical so existing plans/tests don't shift.
		const step = levels > 1 ? end.minus(start).div(levels - 1) : start.times(0);
		for (let i = 0; i < levels; i += 1) {
			prices.push(formatPriceForOrder(start.plus(step.times(i)).toNumber()));
		}
		return prices;
	}
	for (let i = 0; i < levels; i += 1) {
		const t = levels > 1 ? i / (levels - 1) : 0;
		const fraction = sampleScaleCurve(scalePriceDist, t);
		prices.push(formatPriceForOrder(start.plus(end.minus(start).times(fraction)).toNumber()));
	}
	return prices;
}

/**
 * Per-rung sizes: uniform (size ÷ levels, the legacy behavior) or weighted by an
 * amount curve sampled at each rung and normalized to the total. If a distribution
 * would round some rung to zero at the market's size precision, falls back to the
 * uniform split — a broken zero-size order is never emitted.
 */
export function getScaleLevelSizes(
	sizeValue: number,
	scaleLevelsNum: number | null,
	szDecimals: number,
	scaleAmountDist?: readonly number[] | null,
): string[] {
	const levels = clampInt(Math.round(scaleLevelsNum ?? SCALE_LEVELS_MIN), SCALE_LEVELS_MIN, SCALE_LEVELS_MAX);
	const uniform = () => {
		const per = toSafeBig(sizeValue).div(levels);
		const single = formatSizeForOrder(per.toNumber(), szDecimals);
		return Array.from({ length: levels }, () => single);
	};
	if (!scaleAmountDist || scaleAmountDist.length === 0) return uniform();

	const weights: number[] = [];
	let sum = 0;
	for (let i = 0; i < levels; i += 1) {
		const t = levels > 1 ? i / (levels - 1) : 0;
		const w = Math.max(sampleScaleCurve(scaleAmountDist, t), 0);
		weights.push(w);
		sum += w;
	}
	if (!(sum > 0)) return uniform();
	const sizes = weights.map((w) => formatSizeForOrder(toSafeBig(sizeValue).times(w).div(sum).toNumber(), szDecimals));
	if (sizes.some((s) => !(Number(s) > 0))) return uniform();
	return sizes;
}

/** A scale ladder can be previewed once start/end prices and the level count are usable. */
export function canPreviewScale(
	startPriceInput: string,
	endPriceInput: string,
	scaleLevelsNum: number | null,
): boolean {
	const start = Number(startPriceInput);
	const end = Number(endPriceInput);
	const levels = Math.round(scaleLevelsNum ?? Number.NaN);
	return (
		Number.isFinite(start) &&
		start > 0 &&
		Number.isFinite(end) &&
		end > 0 &&
		Number.isFinite(levels) &&
		levels >= SCALE_LEVELS_MIN &&
		levels <= SCALE_LEVELS_MAX
	);
}

interface TriggerOrderParams {
	assetId: number;
	isBuy: boolean;
	formattedSize: string;
	triggerPriceInput: string;
	limitPriceInput: string;
	isStopOrder: boolean;
	usesLimitPriceForOrder: boolean;
}

function buildTriggerOrder(orders: ExchangeOrder[], params: TriggerOrderParams): void {
	const triggerPx = formatPriceForOrder(toBig(params.triggerPriceInput)?.toNumber() ?? 0);
	const limitPx = formatPriceForOrder(toBig(params.limitPriceInput)?.toNumber() ?? 0);

	orders.push({
		a: params.assetId,
		b: params.isBuy,
		p: params.usesLimitPriceForOrder ? limitPx : triggerPx,
		s: params.formattedSize,
		r: true,
		t: {
			trigger: {
				isMarket: !params.usesLimitPriceForOrder,
				triggerPx,
				tpsl: params.isStopOrder ? "sl" : "tp",
			},
		},
	});
}

interface StandardOrderParams {
	assetId: number;
	isBuy: boolean;
	orderType: OrderType;
	formattedSize: string;
	markPx: number;
	price: number;
	slippageBps: number;
	reduceOnly: boolean;
	tif: LimitTif;
}

function buildStandardOrder(orders: ExchangeOrder[], params: StandardOrderParams): void {
	const orderPrice = getExecutedPrice(
		params.orderType,
		params.isBuy ? "buy" : "sell",
		params.markPx,
		params.slippageBps,
		params.price,
	);
	const formattedPrice = formatPriceForOrder(orderPrice);

	orders.push({
		a: params.assetId,
		b: params.isBuy,
		p: formattedPrice,
		s: params.formattedSize,
		r: params.reduceOnly,
		t: params.orderType === "market" ? { limit: { tif: "FrontendMarket" as const } } : { limit: { tif: params.tif } },
	});
}

interface TpSlOrderParams {
	assetId: number;
	isBuy: boolean;
	formattedSize: string;
	triggerPrice: number;
	tpsl: "tp" | "sl";
}

function buildTpSlOrder(orders: ExchangeOrder[], params: TpSlOrderParams): void {
	const triggerPx = formatPriceForOrder(params.triggerPrice);
	orders.push({
		a: params.assetId,
		b: params.isBuy,
		p: triggerPx,
		s: params.formattedSize,
		r: true,
		t: { trigger: { isMarket: true, triggerPx, tpsl: params.tpsl } },
	});
}

function extractResponseError(status: unknown): string | null {
	if (status && typeof status === "object" && "error" in status && typeof status.error === "string") {
		return status.error;
	}
	return null;
}

export function throwIfResponseError(status: unknown): void {
	const error = extractResponseError(status);
	if (error) throw new Error(error);
}

export function throwIfAnyResponseError(statuses: unknown[] | undefined): void {
	if (!statuses) return;
	for (const status of statuses) {
		throwIfResponseError(status);
	}
}

export function getDefaultLeverage(maxLeverage: number): number {
	if (maxLeverage <= DEFAULT_LEVERAGE_FALLBACK) return maxLeverage;
	return Math.floor(maxLeverage / 2);
}

/**
 * Format price according to Hyperliquid's tick size rules.
 * Prices must have at most 5 significant figures.
 * The number of decimal places depends on the price magnitude.
 */
export function formatPriceForOrder(price: number): string {
	if (!Number.isFinite(price) || price <= 0) return "0";

	const log10Price = Math.log10(price);
	const integerDigits = Math.floor(log10Price) + 1;

	let decimals: number;
	if (price >= 1) {
		decimals = Math.max(0, HL_PRICE_MAX_SIG_FIGS - integerDigits);
	} else {
		decimals = HL_PRICE_MAX_SIG_FIGS - integerDigits;
	}

	decimals = Math.min(decimals, HL_PRICE_MAX_DECIMALS);

	const multiplier = 10 ** decimals;
	const rounded = Math.round(price * multiplier) / multiplier;

	if (decimals === 0) {
		return rounded.toFixed(0);
	}

	return rounded
		.toFixed(decimals)
		.replace(/(\.\d*?)0+$/, "$1")
		.replace(/\.$/, "");
}

export function formatSizeForOrder(size: string | number, szDecimals: number): string {
	return formatDecimalFloor(size, szDecimals);
}
