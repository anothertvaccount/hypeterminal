import { describe, expect, it } from "vitest";
import type { ExchangeOrder } from "@/config/trade";
import {
	applyPaperFill,
	buildPaperUserPositions,
	closedUnitsRemoved,
	collectPaperFills,
	derivePaperResult,
	hasPaperLimitCrossed,
	type PaperFill,
	type PaperMarketResolver,
	type PaperOpenOrder,
	type PaperPosition,
	paperAvailableUsdc,
	paperRealizedForFill,
	resetPaperOidCounter,
	seedPaperOid,
	splitPaperPlan,
	sumPaperMarginUsed,
	toOpenOrder,
	withPaperQuoteToken,
} from "@/lib/paper-trading";
import { NO_EXCHANGE_RESPONSE } from "@/lib/trade/extract-order-status";

const LONG: PaperPosition = {
	assetId: 0,
	coin: "BTC",
	dex: "",
	szi: 1,
	entryPx: 100,
	leverage: 10,
	marginMode: "cross",
};

const RESOLVE: PaperMarketResolver = (assetId) => (assetId < 10_000 ? { coin: "BTC", dex: "" } : { coin: "@SPOT" });

function fill(overrides: Partial<PaperFill> = {}): PaperFill {
	return {
		assetId: 0,
		coin: "BTC",
		dex: "",
		isBuy: true,
		size: 1,
		price: 100,
		reduceOnly: false,
		isTrigger: false,
		leverage: 10,
		marginMode: "cross",
		...overrides,
	};
}

function limitOrder(tif: "Gtc" | "FrontendMarket" = "Gtc", overrides: Partial<ExchangeOrder> = {}): ExchangeOrder {
	return {
		a: 0,
		b: true,
		p: "100",
		s: "1",
		r: false,
		t: { limit: { tif } },
		...overrides,
	} as ExchangeOrder;
}

function triggerOrder(overrides: Partial<ExchangeOrder> = {}): ExchangeOrder {
	return {
		a: 0,
		b: false,
		p: "90",
		s: "1",
		r: true,
		t: { trigger: { isMarket: true, triggerPx: "90", tpsl: "sl" } },
		...overrides,
	} as ExchangeOrder;
}

function restingOrder(overrides: Partial<PaperOpenOrder> = {}): PaperOpenOrder {
	return {
		oid: 42,
		assetId: 0,
		coin: "BTC",
		dex: "",
		isBuy: true,
		size: 1,
		limitPx: 90,
		reduceOnly: false,
		leverage: 10,
		marginMode: "cross",
		tif: "Gtc",
		placedAt: 1,
		...overrides,
	};
}

describe("applyPaperFill", () => {
	it("opens a new long position", () => {
		const next = applyPaperFill([], fill({ size: 2, price: 100 }));
		expect(next).toHaveLength(1);
		expect(next[0]).toMatchObject({ coin: "BTC", szi: 2, entryPx: 100, leverage: 10 });
	});

	it("opens a new short position when selling", () => {
		const next = applyPaperFill([], fill({ isBuy: false, size: 3, price: 50 }));
		expect(next[0].szi).toBe(-3);
		expect(next[0].entryPx).toBe(50);
	});

	it("skips a reduce-only fill when no position exists", () => {
		expect(applyPaperFill([], fill({ reduceOnly: true }))).toHaveLength(0);
	});

	it("never moves positions for trigger orders (stop entries, TP/SL)", () => {
		expect(applyPaperFill([LONG], fill({ isBuy: false, reduceOnly: true, isTrigger: true, size: 1 }))[0].szi).toBe(1);
		expect(applyPaperFill([], fill({ isTrigger: true, reduceOnly: true, size: 1 }))).toHaveLength(0);
	});

	it("skips fills with a missing coin when no position exists", () => {
		expect(applyPaperFill([], fill({ coin: "" }))).toHaveLength(0);
	});

	it("adds to the same side with a weighted average entry", () => {
		const next = applyPaperFill([LONG], fill({ size: 1, price: 200 }));
		expect(next[0].szi).toBe(2);
		expect(next[0].entryPx).toBeCloseTo(150, 10);
	});

	it("reduces but keeps the entry price when partially closing", () => {
		const next = applyPaperFill([LONG], fill({ isBuy: false, size: 0.5, price: 90, reduceOnly: true }));
		expect(next[0].szi).toBeCloseTo(0.5, 10);
		expect(next[0].entryPx).toBe(100);
	});

	it("removes the position on a full reduce-only close", () => {
		const next = applyPaperFill([LONG], fill({ isBuy: false, size: 1, price: 120, reduceOnly: true }));
		expect(next).toHaveLength(0);
	});

	it("clamps an overshooting reduce-only close instead of flipping", () => {
		const next = applyPaperFill([LONG], fill({ isBuy: false, size: 5, price: 120, reduceOnly: true }));
		expect(next).toHaveLength(0);
	});

	it("flips through zero on a non-reduce-only reverse and re-enters at the fill price", () => {
		const next = applyPaperFill([LONG], fill({ isBuy: false, size: 3, price: 110 }));
		expect(next).toHaveLength(1);
		expect(next[0].szi).toBeCloseTo(-2, 10);
		expect(next[0].entryPx).toBe(110);
	});

	it("ignores non-finite sizes and prices", () => {
		expect(applyPaperFill([LONG], fill({ size: Number.NaN }))[0].szi).toBe(1);
		expect(applyPaperFill([LONG], fill({ price: 0 })).length).toBe(1);
	});
});

describe("closedUnitsRemoved", () => {
	it("reports long closes and short covers, and ignores adds", () => {
		expect(closedUnitsRemoved(2, 1.5)).toBe(0.5); // partial long close
		expect(closedUnitsRemoved(-3, -1)).toBe(-2); // partial cover
		expect(closedUnitsRemoved(1, 0)).toBe(1); // full close
		expect(closedUnitsRemoved(-2, 0)).toBe(-2); // full cover
		expect(closedUnitsRemoved(1, 3)).toBe(0); // add — nothing left the book
		expect(closedUnitsRemoved(0, 2)).toBe(0); // open from flat
		expect(closedUnitsRemoved(1, -1)).toBe(1); // flip: only the original unit closed
	});
});

describe("paperRealizedForFill", () => {
	it("credits a profitable long close and a profitable cover", () => {
		const before = [LONG]; // long 1 @ 100
		const closeFill = fill({ isBuy: false, size: 0.5, price: 120, reduceOnly: true });
		expect(paperRealizedForFill(before, applyPaperFill(before, closeFill), closeFill)).toBeCloseTo(10, 10);

		const short: PaperPosition = { ...LONG, szi: -1 };
		const coverFill = fill({ isBuy: true, size: 1, price: 90, reduceOnly: true });
		expect(paperRealizedForFill([short], applyPaperFill([short], coverFill), coverFill)).toBeCloseTo(10, 10);
	});

	it("realizes nothing on opens and adds", () => {
		const openFill = fill({ size: 2, price: 100 });
		expect(paperRealizedForFill([], applyPaperFill([], openFill), openFill)).toBe(0);
		const addFill = fill({ size: 1, price: 150 });
		expect(paperRealizedForFill([LONG], applyPaperFill([LONG], addFill), addFill)).toBe(0);
	});
});

describe("splitPaperPlan", () => {
	it("rests Gtc limits on the book and fills market legs immediately", () => {
		const split = splitPaperPlan(
			[limitOrder("Gtc"), limitOrder("FrontendMarket")],
			{ leverage: 5, marginMode: "isolated" },
			RESOLVE,
		);

		expect(split.resting).toHaveLength(1);
		expect(split.resting[0]).toMatchObject({
			coin: "BTC",
			dex: "",
			isBuy: true,
			size: 1,
			limitPx: 100,
			tif: "Gtc",
			leverage: 5,
			marginMode: "isolated",
		});
		expect(split.resting[0].oid).toBeGreaterThan(1_000_000_000);
		expect(split.fills).toHaveLength(1);
		expect(split.fills[0].isTrigger).toBe(false);
		expect(split.fills[0].coin).toBe("BTC");
	});

	it("prefers meta coin over the resolved market (entry flows carry the market)", () => {
		const split = splitPaperPlan([limitOrder("Gtc")], { coin: "ETH", leverage: 20 }, RESOLVE);
		expect(split.resting[0].coin).toBe("ETH");
		expect(split.resting[0].leverage).toBe(20);
	});

	it("resolves coin for callers without meta (close modal flows)", () => {
		const split = splitPaperPlan([limitOrder("Gtc", { b: false, r: true })], undefined, RESOLVE);
		expect(split.resting[0]).toMatchObject({ coin: "BTC", isBuy: false, reduceOnly: true, leverage: 10 });
	});

	it("rests perp trigger legs on the book so the chart can draw and fire them", () => {
		const split = splitPaperPlan([triggerOrder()], { coin: "BTC" }, RESOLVE);
		expect(split.fills).toHaveLength(0);
		expect(split.resting).toHaveLength(1);
		expect(split.resting[0]).toMatchObject({
			coin: "BTC",
			isBuy: false,
			size: 1,
			limitPx: 90,
			triggerPx: 90,
			tpsl: "sl",
			isTrigger: true,
			isMarketTrigger: true,
			reduceOnly: true,
		});
		expect(split.resting[0].oid).toBeGreaterThan(1_000_000_000);
	});

	it("keeps spot trigger legs acknowledged-only (preview spot balances are static)", () => {
		const split = splitPaperPlan([triggerOrder({ a: 10_004 })], undefined, RESOLVE);
		expect(split.resting).toHaveLength(0);
		expect(split.fills).toHaveLength(1);
		expect(split.fills[0].isTrigger).toBe(true);
	});

	it("rests spot limits for the chart but drops executable spot legs", () => {
		const split = splitPaperPlan(
			[limitOrder("Gtc", { a: 10_004 }), limitOrder("FrontendMarket", { a: 10_004 })],
			undefined,
			RESOLVE,
		);
		expect(split.resting).toHaveLength(1);
		expect(split.resting[0]).toMatchObject({ assetId: 10_004, coin: "@SPOT" });
		expect(split.fills).toHaveLength(0);
	});

	it("skips resting orders when no coin can be resolved", () => {
		const split = splitPaperPlan([limitOrder("Gtc")], undefined, () => undefined);
		expect(split.resting).toHaveLength(0);
		expect(split.fills).toHaveLength(0);
	});
});

describe("derivePaperResult", () => {
	it("fails on an empty plan like the real exchange path", () => {
		expect(derivePaperResult([], { fills: [], resting: [] })).toEqual({
			ok: false,
			error: NO_EXCHANGE_RESPONSE,
		});
	});

	it("reports filled when an executable leg fills", () => {
		const split = splitPaperPlan([limitOrder("FrontendMarket"), triggerOrder()], { coin: "BTC" }, RESOLVE);
		expect(derivePaperResult([limitOrder("FrontendMarket")], split)).toEqual({ ok: true, outcome: "filled" });
	});

	it("reports resting when only Gtc limits hit the book", () => {
		const orders = [limitOrder("Gtc"), triggerOrder()];
		expect(derivePaperResult(orders, splitPaperPlan(orders, { coin: "BTC" }, RESOLVE))).toEqual({
			ok: true,
			outcome: "resting",
		});
	});

	it("reports triggerSet for trigger-only plans (pure TP/SL)", () => {
		const orders = [triggerOrder()];
		expect(derivePaperResult(orders, splitPaperPlan(orders, { coin: "BTC" }, RESOLVE))).toEqual({
			ok: true,
			outcome: "triggerSet",
		});
	});
});

describe("hasPaperLimitCrossed", () => {
	const buy = { isBuy: true, limitPx: 100, coin: "BTC" };
	const sell = { isBuy: false, limitPx: 100, coin: "BTC" };

	it("fills a buy when the mark trades down through the limit", () => {
		expect(hasPaperLimitCrossed(buy, { BTC: "99.5" })).toBe(true);
		expect(hasPaperLimitCrossed(buy, { BTC: "100" })).toBe(true);
		expect(hasPaperLimitCrossed(buy, { BTC: "100.5" })).toBe(false);
	});

	it("fills a sell when the mark trades up through the limit", () => {
		expect(hasPaperLimitCrossed(sell, { BTC: "100.5" })).toBe(true);
		expect(hasPaperLimitCrossed(sell, { BTC: "100" })).toBe(true);
		expect(hasPaperLimitCrossed(sell, { BTC: "99.5" })).toBe(false);
	});

	it("ignores missing and invalid marks", () => {
		expect(hasPaperLimitCrossed(buy, {})).toBe(false);
		expect(hasPaperLimitCrossed(buy, { BTC: "NaN" })).toBe(false);
		expect(hasPaperLimitCrossed(buy, { BTC: "0" })).toBe(false);
	});

	it("fires a long's take-profit when the mark rises into it", () => {
		const tp = { isBuy: false, limitPx: 120, triggerPx: 120, tpsl: "tp" as const, isTrigger: true, coin: "BTC" };
		expect(hasPaperLimitCrossed(tp, { BTC: "121" })).toBe(true);
		expect(hasPaperLimitCrossed(tp, { BTC: "119" })).toBe(false);
	});

	it("fires a long's stop when the mark falls into it", () => {
		const sl = { isBuy: false, limitPx: 80, triggerPx: 80, tpsl: "sl" as const, isTrigger: true, coin: "BTC" };
		expect(hasPaperLimitCrossed(sl, { BTC: "79" })).toBe(true);
		expect(hasPaperLimitCrossed(sl, { BTC: "81" })).toBe(false);
	});

	it("fires a short's take-profit when the mark falls into it", () => {
		const tp = { isBuy: true, limitPx: 80, triggerPx: 80, tpsl: "tp" as const, isTrigger: true, coin: "BTC" };
		expect(hasPaperLimitCrossed(tp, { BTC: "79" })).toBe(true);
		expect(hasPaperLimitCrossed(tp, { BTC: "81" })).toBe(false);
	});

	it("fires a short's stop when the mark rises into it", () => {
		const sl = { isBuy: true, limitPx: 120, triggerPx: 120, tpsl: "sl" as const, isTrigger: true, coin: "BTC" };
		expect(hasPaperLimitCrossed(sl, { BTC: "121" })).toBe(true);
		expect(hasPaperLimitCrossed(sl, { BTC: "119" })).toBe(false);
	});
});

describe("collectPaperFills", () => {
	it("moves a crossed perp limit off the book into a position", () => {
		const result = collectPaperFills([], [restingOrder({ limitPx: 90 })], { BTC: "90" });
		expect(result.filled).toHaveLength(1);
		expect(result.remaining).toHaveLength(0);
		expect(result.positions).toHaveLength(1);
		expect(result.positions[0]).toMatchObject({ coin: "BTC", szi: 1, entryPx: 90 });
	});

	it("executes a fired trigger at its trigger price through the netting rules", () => {
		// Stop-buy resting trigger: display value 95, trigger 90 — the position must
		// open at 90 once the mark rises into the trigger.
		const entry = restingOrder({ isBuy: true, limitPx: 95, triggerPx: 90, tpsl: "sl", isTrigger: true });
		const result = collectPaperFills([], [entry], { BTC: "91" });
		expect(result.filled).toHaveLength(1);
		expect(result.remaining).toHaveLength(0);
		expect(result.positions[0]).toMatchObject({ coin: "BTC", szi: 1, entryPx: 90 });
	});

	it("closes a position when a resting trigger stop fires", () => {
		const stop = restingOrder({
			isBuy: false,
			limitPx: 95,
			triggerPx: 90,
			tpsl: "sl",
			isTrigger: true,
			reduceOnly: true,
		});
		const result = collectPaperFills([LONG], [stop], { BTC: "89.5" });
		expect(result.filled).toHaveLength(1);
		expect(result.positions).toHaveLength(0);
	});

	it("reports realized PnL when a resting reduce-only fill closes into profit", () => {
		const result = collectPaperFills([LONG], [restingOrder({ isBuy: false, limitPx: 110, reduceOnly: true })], {
			BTC: "110",
		});
		expect(result.realized).toBeCloseTo(10, 10); // 1 × (110 − 100)
	});

	it("fills a marketable buy at the current mark, not the worse dragged limit", () => {
		// Dragged a buy limit to 86,000 while the market sits at 85,400: a real book
		// fills immediately at the market, never at your (better-than-nothing) limit.
		const result = collectPaperFills([], [restingOrder({ isBuy: true, limitPx: 86_000 })], { BTC: "85400" });
		expect(result.filled).toHaveLength(1);
		expect(result.positions[0]).toMatchObject({ szi: 1, entryPx: 85_400 });
	});

	it("fills a marketable sell at the current mark", () => {
		const result = collectPaperFills([LONG], [restingOrder({ isBuy: false, limitPx: 83_000, reduceOnly: true })], {
			BTC: "84000",
		});
		expect(result.filled).toHaveLength(1);
		// Closed at the market (84,000): realized 1 × (84,000 − 100).
		expect(result.realized).toBeCloseTo(83_900, 10);
	});

	it("leaves orders that have not crossed on the book", () => {
		const result = collectPaperFills([], [restingOrder({ limitPx: 90 })], { BTC: "95" });
		expect(result.filled).toHaveLength(0);
		expect(result.remaining).toHaveLength(1);
		expect(result.positions).toHaveLength(0);
	});

	it("closes an existing position when a resting sell limit crosses", () => {
		const result = collectPaperFills([LONG], [restingOrder({ isBuy: false, limitPx: 110, reduceOnly: true })], {
			BTC: "110",
		});
		expect(result.filled).toHaveLength(1);
		expect(result.positions).toHaveLength(0);
	});

	it("removes crossed spot limits without touching perp positions", () => {
		const spot = restingOrder({ assetId: 10_004, coin: "@SPOT", limitPx: 5 });
		const result = collectPaperFills([LONG], [spot], { "@SPOT": "5" });
		expect(result.filled).toHaveLength(1);
		expect(result.remaining).toHaveLength(0);
		expect(result.positions).toEqual([LONG]);
	});

	it("is idempotent for repeated ticks with the same marks", () => {
		const first = collectPaperFills([], [restingOrder({ limitPx: 90 })], { BTC: "90" });
		const second = collectPaperFills(first.positions, first.remaining, { BTC: "90" });
		expect(second.filled).toHaveLength(0);
		expect(second.positions).toHaveLength(1);
	});
});

describe("toOpenOrder", () => {
	it("maps a resting paper order into the SDK open-order shape", () => {
		const row = toOpenOrder(
			restingOrder({
				isBuy: false,
				limitPx: 123.5,
				size: 2,
				tif: "Alo",
				reduceOnly: true,
				oid: 7,
				placedAt: 1_700_000_000_000,
			}),
		);
		expect(row).toMatchObject({
			coin: "BTC",
			side: "A",
			limitPx: "123.5",
			sz: "2",
			origSz: "2",
			oid: 7,
			timestamp: 1_700_000_000_000,
			orderType: "Limit",
			tif: "Alo",
			reduceOnly: true,
			isTrigger: false,
			isPositionTpsl: false,
			triggerCondition: "",
			triggerPx: "0",
			cloid: null,
		});
		expect(Array.isArray(row.children)).toBe(true);
	});

	it("maps a resting trigger into the SDK trigger shape", () => {
		const row = toOpenOrder(
			restingOrder({
				isTrigger: true,
				triggerPx: 120,
				tpsl: "tp",
				isMarketTrigger: true,
				isBuy: false,
				limitPx: 120,
				reduceOnly: true,
			}),
		);
		expect(row).toMatchObject({
			isTrigger: true,
			triggerPx: "120",
			orderType: "Take Profit Market",
			triggerCondition: ">=",
			reduceOnly: true,
			isPositionTpsl: false,
		});
	});
});

describe("paper balances", () => {
	it("derives margin used and available balance from open positions", () => {
		// 1 BTC @ 100 at 10x → 10 USD margin.
		expect(sumPaperMarginUsed([LONG])).toBeCloseTo(10, 10);
		expect(paperAvailableUsdc([LONG])).toBeCloseTo(100_000 - 10, 10);
		expect(sumPaperMarginUsed([])).toBe(0);
	});

	it("adds realized PnL to the simulated balance", () => {
		expect(paperAvailableUsdc([LONG], 50)).toBeCloseTo(100_000 + 50 - 10, 10);
		expect(paperAvailableUsdc([], -25)).toBeCloseTo(99_975, 10);
	});

	it("adds a synthetic row for a non-USDC quote token and keeps USDC untouched", () => {
		const usdc = { coin: "USDC", token: 0, total: "100000", hold: "0", entryNtl: "100000" };
		const rows = withPaperQuoteToken([usdc], "@U");
		expect(rows.map((r) => r.coin)).toEqual(["USDC", "@U"]);
		expect(rows[1].total).toBe("100000");

		const replaced = withPaperQuoteToken([{ coin: "USDC", token: 0, total: "0", hold: "0", entryNtl: "0" }], "USDC");
		expect(replaced).toHaveLength(1);
		expect(replaced[0].total).toBe("100000");
	});
});

describe("buildPaperUserPositions", () => {
	it("computes live PnL and margin from marks", () => {
		const [position] = buildPaperUserPositions([LONG], { BTC: "110" }, 50);
		expect(position.coin).toBe("BTC");
		expect(position.szi).toBe("1");
		expect(Number(position.unrealizedPnl)).toBeCloseTo(10, 10); // (110 - 100) * 1
		expect(Number(position.positionValue)).toBeCloseTo(110, 10);
		expect(Number(position.marginUsed)).toBeCloseTo(10, 10); // 1 * 100 / 10
		expect(Number(position.returnOnEquity)).toBeCloseTo(1, 10); // 10 / 10
		expect(position.liquidationPx).toBeNull();
		expect(position.maxLeverage).toBe(50);
	});

	it("falls back to the entry price when a mark is missing", () => {
		const [position] = buildPaperUserPositions([LONG], undefined, 50);
		expect(Number(position.unrealizedPnl)).toBe(0);
	});

	it("emits an isolated leverage payload with rawUsd", () => {
		const isolated: PaperPosition = { ...LONG, marginMode: "isolated" };
		const [position] = buildPaperUserPositions([isolated], undefined, 50);
		expect(position.leverage).toEqual({ type: "isolated", value: 10, rawUsd: "10" });
	});
});

describe("resetPaperOidCounter", () => {
	it("allocates deterministic increasing oids after a reset", () => {
		resetPaperOidCounter();
		const first = splitPaperPlan([limitOrder("Gtc"), limitOrder("Gtc", { a: 1 })], { coin: "BTC" }, RESOLVE);
		resetPaperOidCounter();
		const second = splitPaperPlan([limitOrder("Gtc")], { coin: "BTC" }, RESOLVE);
		expect(first.resting[0].oid).toBe(second.resting[0].oid);
		expect(first.resting[1].oid).toBe(first.resting[0].oid + 1);
	});
});

describe("seedPaperOid", () => {
	it("never allocates below an oid restored from persistence", () => {
		resetPaperOidCounter();
		seedPaperOid(1_500_000_000);
		const split = splitPaperPlan([limitOrder("Gtc")], { coin: "BTC" }, RESOLVE);
		expect(split.resting[0].oid).toBeGreaterThan(1_500_000_000);
		resetPaperOidCounter(); // leave the counter deterministic for anything after
	});
});
