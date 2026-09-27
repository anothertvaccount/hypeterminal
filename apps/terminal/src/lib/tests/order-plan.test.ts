import { describe, expect, it } from "vitest";
import { getExecutedPrice } from "@/domain/trade/order/price";
import { buildOrderPlan } from "@/domain/trade/order-intent";
import { buildOrders, canPreviewScale, getScaleLevelPrices } from "@/domain/trade/orders";
import { interpretOrderStatuses, NO_EXCHANGE_RESPONSE } from "@/lib/trade/extract-order-status";

const ENTRY_BASE = {
	kind: "entry" as const,
	assetId: 0,
	side: "buy" as const,
	orderType: "market" as const,
	sizeValue: 1.5,
	szDecimals: 3,
	markPx: 100,
	price: 100,
	slippageBps: 50,
	reduceOnly: false,
	tif: "Gtc" as const,
	limitPriceInput: "",
	triggerPriceInput: "",
	scaleStartPriceInput: "",
	scaleEndPriceInput: "",
	scaleLevelsNum: null,
	tpSlEnabled: false,
	canUseTpSl: false,
	tpPriceNum: null,
	slPriceNum: null,
};

describe("getExecutedPrice (characterization)", () => {
	it("applies positive slippage for market buy", () => {
		expect(getExecutedPrice("market", "buy", 100, 50, 100)).toBe(100.5);
	});
	it("applies negative slippage for market sell", () => {
		expect(getExecutedPrice("market", "sell", 100, 50, 100)).toBe(99.5);
	});
	it("returns the limit price unchanged for non-market orders", () => {
		expect(getExecutedPrice("limit", "buy", 100, 50, 105)).toBe(105);
		expect(getExecutedPrice("limit", "sell", 100, 50, 105)).toBe(105);
	});
	it("returns mark price when slippage is zero", () => {
		expect(getExecutedPrice("market", "buy", 100, 0, 100)).toBe(100);
	});
});

describe("buildOrderPlan entry (characterization)", () => {
	it("builds a market buy with FrontendMarket tif and slippage-adjusted price", () => {
		const plan = buildOrderPlan(ENTRY_BASE);
		expect(plan).toEqual({
			orders: [{ a: 0, b: true, p: "100.5", s: "1.5", r: false, t: { limit: { tif: "FrontendMarket" } } }],
			grouping: "na",
			errors: [],
			warnings: [],
		});
	});

	it("builds a limit sell at the exact limit price with the chosen tif", () => {
		const plan = buildOrderPlan({ ...ENTRY_BASE, side: "sell", orderType: "limit", price: 105, tif: "Gtc" });
		expect(plan.orders).toEqual([{ a: 0, b: false, p: "105", s: "1.5", r: false, t: { limit: { tif: "Gtc" } } }]);
		expect(plan.grouping).toBe("na");
	});

	it("builds a chase limit with the chosen tif (post-only placement is book-priced)", () => {
		const postOnly = buildOrderPlan({ ...ENTRY_BASE, orderType: "chaseLimit", price: 99, tif: "Alo" });
		expect(postOnly.orders).toEqual([{ a: 0, b: true, p: "99", s: "1.5", r: false, t: { limit: { tif: "Alo" } } }]);
		expect(postOnly.grouping).toBe("na");
		const gtc = buildOrderPlan({ ...ENTRY_BASE, orderType: "chaseLimit", price: 99, tif: "Gtc" });
		expect(gtc.orders[0].t).toEqual({ limit: { tif: "Gtc" } });
	});

	it("attaches a reduce-only tp trigger and switches grouping to normalTpsl", () => {
		const plan = buildOrderPlan({ ...ENTRY_BASE, tpSlEnabled: true, canUseTpSl: true, tpPriceNum: 110 });
		expect(plan.orders).toEqual([
			{ a: 0, b: true, p: "100.5", s: "1.5", r: false, t: { limit: { tif: "FrontendMarket" } } },
			{ a: 0, b: false, p: "110", s: "1.5", r: true, t: { trigger: { isMarket: true, triggerPx: "110", tpsl: "tp" } } },
		]);
		expect(plan.grouping).toBe("normalTpsl");
	});

	it("scale entries attach shared TP/SL triggers after the ladder (normalTpsl)", () => {
		const plan = buildOrderPlan({
			...ENTRY_BASE,
			orderType: "scale",
			sizeValue: 3,
			scaleStartPriceInput: "100",
			scaleEndPriceInput: "110",
			scaleLevelsNum: 3,
			tpSlEnabled: true,
			canUseTpSl: true,
			tpPriceNum: 120,
			slPriceNum: 90,
		});
		expect(plan.grouping).toBe("normalTpsl");
		// Ladder mains first (size1 each), then FULL-size (3) reduce-only triggers.
		expect(plan.orders.map((o) => o.p)).toEqual(["100", "105", "110", "120", "90"]);
		expect(plan.orders[3].s).toBe("3");
		expect(plan.orders[3].b).toBe(false);
		expect(plan.orders.slice(3).map((o) => o.t)).toEqual([
			{ trigger: { isMarket: true, triggerPx: "120", tpsl: "tp" } },
			{ trigger: { isMarket: true, triggerPx: "90", tpsl: "sl" } },
		]);
		expect(plan.orders.slice(3).every((o) => o.r)).toBe(true);
	});

	it("canUseTpSl allows scale — and still refuses triggers and twap", async () => {
		const { canUseTpSl } = await import("@/lib/trade/order-types");
		expect(canUseTpSl("scale")).toBe(true);
		expect(canUseTpSl("market")).toBe(true);
		expect(canUseTpSl("limit")).toBe(true);
		expect(canUseTpSl("stopMarket")).toBe(false);
		expect(canUseTpSl("twap")).toBe(false);
	});

	it("builds scale orders evenly spaced across the price range", () => {
		const plan = buildOrderPlan({
			...ENTRY_BASE,
			orderType: "scale",
			sizeValue: 3,
			scaleStartPriceInput: "100",
			scaleEndPriceInput: "110",
			scaleLevelsNum: 3,
		});
		expect(plan.orders.map((o) => o.p)).toEqual(["100", "105", "110"]);
		expect(plan.orders.every((o) => o.s === "1")).toBe(true);
		expect(plan.grouping).toBe("na");
	});

	it("scale previews land on the exact prices buildScaleOrders would submit", () => {
		const plan = buildOrderPlan({
			...ENTRY_BASE,
			orderType: "scale",
			sizeValue: 3,
			scaleStartPriceInput: "83000",
			scaleEndPriceInput: "85000",
			scaleLevelsNum: 4,
		});
		const preview = getScaleLevelPrices("83000", "85000", 4);
		expect(preview).toEqual(["83000", "83667", "84333", "85000"]);
		expect(preview).toEqual(plan.orders.map((o) => o.p));
	});

	it("canPreviewScale gates on usable start/end prices and level count", () => {
		expect(canPreviewScale("83000", "85000", 4)).toBe(true);
		expect(canPreviewScale("", "85000", 4)).toBe(false);
		expect(canPreviewScale("83000", "0", 4)).toBe(false);
		expect(canPreviewScale("83000", "abc", 4)).toBe(false);
		expect(canPreviewScale("83000", "85000", 1)).toBe(false);
		expect(canPreviewScale("83000", "85000", 21)).toBe(false);
	});

	it("builds a stop-market trigger with isMarket and sl tpsl", () => {
		const plan = buildOrderPlan({
			...ENTRY_BASE,
			orderType: "stopMarket",
			triggerPriceInput: "95",
		});
		expect(plan.orders).toEqual([
			{ a: 0, b: true, p: "95", s: "1.5", r: true, t: { trigger: { isMarket: true, triggerPx: "95", tpsl: "sl" } } },
		]);
	});

	it("builds a stop-limit trigger at the limit price (not market)", () => {
		const plan = buildOrderPlan({
			...ENTRY_BASE,
			orderType: "stopLimit",
			triggerPriceInput: "95",
			limitPriceInput: "96",
		});
		expect(plan.orders).toEqual([
			{ a: 0, b: true, p: "96", s: "1.5", r: true, t: { trigger: { isMarket: false, triggerPx: "95", tpsl: "sl" } } },
		]);
	});

	it("builds a take-profit-market trigger with tp tpsl", () => {
		const plan = buildOrderPlan({ ...ENTRY_BASE, orderType: "takeProfitMarket", triggerPriceInput: "110" });
		expect(plan.orders).toEqual([
			{ a: 0, b: true, p: "110", s: "1.5", r: true, t: { trigger: { isMarket: true, triggerPx: "110", tpsl: "tp" } } },
		]);
	});

	it("builds a take-profit-limit trigger at the limit price with tp tpsl", () => {
		const plan = buildOrderPlan({
			...ENTRY_BASE,
			orderType: "takeProfitLimit",
			triggerPriceInput: "110",
			limitPriceInput: "109",
		});
		expect(plan.orders).toEqual([
			{ a: 0, b: true, p: "109", s: "1.5", r: true, t: { trigger: { isMarket: false, triggerPx: "110", tpsl: "tp" } } },
		]);
	});

	it("attaches both tp and sl legs on the opposite side with normalTpsl grouping", () => {
		const plan = buildOrderPlan({
			...ENTRY_BASE,
			tpSlEnabled: true,
			canUseTpSl: true,
			tpPriceNum: 110,
			slPriceNum: 90,
		});
		expect(plan.orders).toEqual([
			{ a: 0, b: true, p: "100.5", s: "1.5", r: false, t: { limit: { tif: "FrontendMarket" } } },
			{ a: 0, b: false, p: "110", s: "1.5", r: true, t: { trigger: { isMarket: true, triggerPx: "110", tpsl: "tp" } } },
			{ a: 0, b: false, p: "90", s: "1.5", r: true, t: { trigger: { isMarket: true, triggerPx: "90", tpsl: "sl" } } },
		]);
		expect(plan.grouping).toBe("normalTpsl");
	});

	it("propagates the chosen tif and reduceOnly to every scale level", () => {
		const plan = buildOrderPlan({
			...ENTRY_BASE,
			orderType: "scale",
			sizeValue: 3,
			scaleStartPriceInput: "100",
			scaleEndPriceInput: "110",
			scaleLevelsNum: 3,
			tif: "Alo",
			reduceOnly: true,
		});
		expect(plan.orders.every((o) => o.r === true)).toBe(true);
		expect(plan.orders.every((o) => JSON.stringify(o.t) === JSON.stringify({ limit: { tif: "Alo" } }))).toBe(true);
	});

	it("formats sub-1 prices to 5 significant figures", () => {
		const plan = buildOrderPlan({ ...ENTRY_BASE, orderType: "limit", side: "sell", price: 0.012345 });
		expect(plan.orders[0].p).toBe("0.012345");
	});

	it("formats a zero price as '0'", () => {
		const plan = buildOrderPlan({ ...ENTRY_BASE, orderType: "limit", price: 0 });
		expect(plan.orders[0].p).toBe("0");
	});
});

describe("buildOrderPlan swap (characterization — byte-exact spot swap math)", () => {
	const SWAP_BASE = {
		kind: "swap" as const,
		assetId: 0,
		isBuy: true,
		sizeValue: 1.5,
		szDecimals: 3,
		markPx: 100,
		slippageBps: 100,
	};

	it("prices a buy at markPx * (1 + bps/10000)", () => {
		const plan = buildOrderPlan(SWAP_BASE);
		expect(plan.orders).toEqual([
			{ a: 0, b: true, p: "101", s: "1.5", r: false, t: { limit: { tif: "FrontendMarket" } } },
		]);
		expect(plan.grouping).toBe("na");
	});

	it("prices a sell at markPx / (1 + bps/10000) — not the symmetric getExecutedPrice formula", () => {
		const plan = buildOrderPlan({ ...SWAP_BASE, isBuy: false });
		expect(plan.orders[0]).toEqual({
			a: 0,
			b: false,
			p: "99.01",
			s: "1.5",
			r: false,
			t: { limit: { tif: "FrontendMarket" } },
		});
	});
});

describe("buildOrderPlan close/reverse/tpsl (characterization)", () => {
	it("market-closes a long as a reduce-only sell at slippage-adjusted price", () => {
		const plan = buildOrderPlan({
			kind: "marketClose",
			assetId: 0,
			size: 1.5,
			szDecimals: 3,
			isLong: true,
			markPx: 100,
			slippageBps: 50,
		});
		expect(plan.orders).toEqual([
			{ a: 0, b: false, p: "99.5", s: "1.5", r: true, t: { limit: { tif: "FrontendMarket" } } },
		]);
		expect(plan.grouping).toBe("na");
	});

	it("reverses a long by doubling size with reduceOnly false", () => {
		const plan = buildOrderPlan({
			kind: "reverse",
			assetId: 0,
			size: 1.5,
			szDecimals: 3,
			isLong: true,
			markPx: 100,
			slippageBps: 50,
		});
		expect(plan.orders).toEqual([
			{ a: 0, b: false, p: "99.5", s: "3", r: false, t: { limit: { tif: "FrontendMarket" } } },
		]);
	});

	it("limit-closes a short as a reduce-only buy at Gtc", () => {
		const plan = buildOrderPlan({
			kind: "limitClose",
			assetId: 0,
			size: 1.5,
			szDecimals: 3,
			isLong: false,
			price: 100,
		});
		expect(plan.orders).toEqual([{ a: 0, b: true, p: "100", s: "1.5", r: true, t: { limit: { tif: "Gtc" } } }]);
	});

	it("builds position tp+sl triggers with zero size and positionTpsl grouping", () => {
		const plan = buildOrderPlan({
			kind: "positionTpsl",
			assetId: 0,
			isLong: true,
			tpPriceNum: 110,
			slPriceNum: 90,
		});
		expect(plan.orders).toEqual([
			{ a: 0, b: false, p: "110", s: "0", r: true, t: { trigger: { isMarket: true, triggerPx: "110", tpsl: "tp" } } },
			{ a: 0, b: false, p: "90", s: "0", r: true, t: { trigger: { isMarket: true, triggerPx: "90", tpsl: "sl" } } },
		]);
		expect(plan.grouping).toBe("positionTpsl");
	});

	it("position-trigger plans (dragged TP/SL) always use positionTpsl, never normalTpsl", async () => {
		// Hyperliquid rejects a trigger-only batch under normalTpsl with
		// "Main order cannot be trigger order" — this exact plan is what the
		// position-line drag / axis menu / chart hotkeys submit live.
		const { buildTpSlExchangeOrder, buildPositionTriggerPlan } = await import("@/domain/trade/order/chart-labels");
		const trigger = buildTpSlExchangeOrder({
			assetId: 0,
			isBuy: false,
			size: "0.00017",
			triggerPrice: 82855,
			tpsl: "sl",
		});
		const plan = buildPositionTriggerPlan(trigger);
		expect(plan.grouping).toBe("positionTpsl");
		expect(plan.orders).toEqual([trigger]);
		expect(plan.orders[0].r).toBe(true);
		expect(plan.orders[0].t).toEqual({ trigger: { isMarket: true, triggerPx: "82855", tpsl: "sl" } });
	});

	it("reports an error when position tpsl has no prices", () => {
		const plan = buildOrderPlan({ kind: "positionTpsl", assetId: 0, isLong: true, tpPriceNum: null, slPriceNum: null });
		expect(plan.orders).toEqual([]);
		expect(plan.errors.length).toBeGreaterThan(0);
	});
});

describe("interpretOrderStatuses (unified result handling)", () => {
	it("treats a status-level error as a failure (the positions-tab bug this fixes)", () => {
		expect(interpretOrderStatuses([{ error: "Insufficient margin" }])).toEqual({
			ok: false,
			error: "Insufficient margin",
		});
	});

	it("joins multiple status errors", () => {
		expect(interpretOrderStatuses([{ error: "a" }, { error: "b" }])).toEqual({ ok: false, error: "a; b" });
	});

	it("fails an empty response instead of reporting silent success", () => {
		expect(interpretOrderStatuses([])).toEqual({ ok: false, error: NO_EXCHANGE_RESPONSE });
	});

	it("reports filled and resting outcomes", () => {
		expect(interpretOrderStatuses([{ filled: { totalSz: "1" } }])).toEqual({ ok: true, outcome: "filled" });
		expect(interpretOrderStatuses([{ resting: { oid: 1 } }])).toEqual({ ok: true, outcome: "resting" });
		expect(interpretOrderStatuses(["waitingForFill"])).toEqual({ ok: true, outcome: "resting" });
		expect(interpretOrderStatuses(["waitingForTrigger"])).toEqual({ ok: true, outcome: "triggerSet" });
	});

	it("lets any error win over a resting sibling", () => {
		expect(interpretOrderStatuses([{ resting: { oid: 1 } }, { error: "rejected" }])).toEqual({
			ok: false,
			error: "rejected",
		});
	});
});

describe("buildOrders grouping (characterization)", () => {
	it("returns na grouping for a plain market order", () => {
		const result = buildOrders({
			assetId: 0,
			side: "buy",
			orderType: "market",
			sizeValue: 1.5,
			szDecimals: 3,
			markPx: 100,
			price: 100,
			slippageBps: 50,
			reduceOnly: false,
			tif: "Gtc",
			limitPriceInput: "",
			triggerPriceInput: "",
			scaleStartPriceInput: "",
			scaleEndPriceInput: "",
			scaleLevelsNum: null,
			tpSlEnabled: false,
			canUseTpSl: false,
			tpPriceNum: null,
			slPriceNum: null,
		});
		expect(result.grouping).toBe("na");
		expect(result.orders).toHaveLength(1);
	});
});

describe("chartSymbolFromMarket", () => {
	it("qualifies HIP-3 builder markets so the chart datafeed can resolve them", async () => {
		const { chartSymbolFromMarket } = await import("@/lib/hyperliquid/markets/helper");
		expect(chartSymbolFromMarket("SP500", "xyz")).toBe("xyz:SP500");
		expect(chartSymbolFromMarket("xyz:SP500", "xyz")).toBe("xyz:SP500");
		expect(chartSymbolFromMarket("BTC", undefined)).toBe("BTC");
		expect(chartSymbolFromMarket("BTC", "")).toBe("BTC");
	});
});
