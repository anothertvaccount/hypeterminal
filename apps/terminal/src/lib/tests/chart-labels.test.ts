import { describe, expect, it } from "vitest";
import {
	buildPositionSegments,
	buildTpSlExchangeOrder,
	buildTpSlGhostSegments,
	type ChartLabelContext,
	type ChartOrder,
	chartOrderFromOpenOrder,
	formatSignedUsd,
	formatUsd,
	orderFlagsText,
	orderTypeWord,
	realizedIfHit,
} from "@/domain/trade/order/chart-labels";
import { buildOrderSegments, cumulativePnlAt } from "@/domain/trade/order/chart-risk";

// Inputs taken from the reference screenshot of the label layout:
// long 0.004 BTC @ 84,553.5 entry, mark 84,520.4, a reduce-only post-only sell limit
// of 0.003 @ 88,973.6 and a post-only buy limit of 0.009 @ 81,616.4.
const POSITION = { coin: "BTC", szi: 0.004, entryPx: 84_553.5 };
const MARK = 84_520.4;

const REDUCE_SELL: ChartOrder = {
	side: "A",
	price: 88_973.6,
	size: 0.003,
	reduceOnly: true,
	tif: "Alo",
	isTrigger: false,
	tpsl: null,
};

const ADD_BUY: ChartOrder = {
	side: "B",
	price: 81_616.4,
	size: 0.009,
	reduceOnly: false,
	tif: "Alo",
	isTrigger: false,
	tpsl: null,
};

describe("realizedIfHit", () => {
	it("matches the screenshot: reduce-only sell realizes +13.26 USD vs entry", () => {
		expect(formatSignedUsd(realizedIfHit(REDUCE_SELL, POSITION))).toBe("+13.26 USD");
	});

	it("shows +0.00 USD for an opening order (nothing realizes)", () => {
		expect(formatSignedUsd(realizedIfHit(ADD_BUY, POSITION))).toBe("+0.00 USD");
	});

	it("realizes a TP trigger closing a long when price rises", () => {
		const tp: ChartOrder = { ...REDUCE_SELL, price: 120, size: 1 };
		// Closes 1 of 2 units at 120 from a 100 entry → +20.
		expect(realizedIfHit(tp, { szi: 2, entryPx: 100 })).toBeCloseTo(20, 10);
	});

	it("realizes a cover closing a short when price falls", () => {
		const cover: ChartOrder = {
			side: "B",
			price: 90,
			size: 1,
			reduceOnly: true,
			tif: "Gtc",
			isTrigger: true,
			tpsl: "tp",
		};
		// Covers 1 of 3 short units at 90 from a 100 entry → +10.
		expect(realizedIfHit(cover, { szi: -3, entryPx: 100 })).toBeCloseTo(10, 10);
	});

	it("returns 0 with no position", () => {
		expect(realizedIfHit(REDUCE_SELL, null)).toBe(0);
	});
});

describe("cumulativePnlAt", () => {
	it("matches the screenshot: +17.68 USD at the sell limit (position + that fill)", () => {
		const value = cumulativePnlAt(REDUCE_SELL.price, [REDUCE_SELL, ADD_BUY], POSITION, MARK);
		expect(value).not.toBeNull();
		expect(formatSignedUsd(value as number)).toBe("+17.68 USD");
	});

	it("matches the screenshot: -11.75 USD at the buy limit (position marked down there)", () => {
		const value = cumulativePnlAt(ADD_BUY.price, [REDUCE_SELL, ADD_BUY], POSITION, MARK);
		expect(value).not.toBeNull();
		expect(formatSignedUsd(value as number)).toBe("-11.75 USD");
	});

	it("accumulates a resting ladder without any position", () => {
		// Flat account: buys at 95 and 90 both fill on the way down to 90.
		const first: ChartOrder = {
			side: "B",
			price: 95,
			size: 1,
			reduceOnly: false,
			tif: "Gtc",
			isTrigger: false,
			tpsl: null,
		};
		const second: ChartOrder = {
			side: "B",
			price: 90,
			size: 2,
			reduceOnly: false,
			tif: "Gtc",
			isTrigger: false,
			tpsl: null,
		};
		const value = cumulativePnlAt(90, [first, second], null, 100);
		// 1 unit bought at 95 is worth 5 less at 90; the unit bought AT 90 is worth 0.
		expect(formatSignedUsd(value as number)).toBe("-5.00 USD");
	});

	it("excludes orders beyond the labeled level and on the other side of the mark", () => {
		const farBelow: ChartOrder = {
			side: "B",
			price: 80,
			size: 10,
			reduceOnly: false,
			tif: "Gtc",
			isTrigger: false,
			tpsl: null,
		};
		// Level 90 from mark 100: the 80 buy has not filled yet and must not count.
		const value = cumulativePnlAt(90, [farBelow], { szi: 1, entryPx: 95 }, 100);
		expect(formatSignedUsd(value as number)).toBe("-5.00 USD");
	});

	it("returns null without a mark", () => {
		expect(cumulativePnlAt(90, [], null, undefined)).toBeNull();
	});
});

describe("order label segments", () => {
	const ctx: ChartLabelContext = { position: POSITION, orders: [REDUCE_SELL, ADD_BUY], mark: MARK };

	it("rebuilds the screenshot's reduce-only label exactly", () => {
		const { segments, isBuy } = buildOrderSegments(REDUCE_SELL, ctx);
		expect(isBuy).toBe(false);
		expect(segments).toHaveLength(3);
		expect(segments[0].text).toBe("Limit [+13.26 USD / +17.68 USD] [R, P]");
		expect(segments[1].text).toBe("266.92 USD");
		expect(segments[2]).toMatchObject({ text: "\u2715", key: "cancel" });
	});

	it("rebuilds the screenshot's buy-limit label exactly", () => {
		const { segments } = buildOrderSegments(ADD_BUY, ctx);
		expect(segments[0].text).toBe("Limit [+0.00 USD / -11.75 USD] [P]");
		expect(segments[1].text).toBe("734.55 USD");
	});

	it("omits the PnL numbers before the first mark tick", () => {
		const { segments } = buildOrderSegments(REDUCE_SELL, { ...ctx, mark: undefined });
		expect(segments[0].text).toBe("Limit [R, P]");
	});

	it("labels triggers TP/SL and derives flags from tif/reduceOnly", () => {
		const tp: ChartOrder = { ...REDUCE_SELL, price: 120, isTrigger: true, tpsl: "tp", tif: "Gtc" };
		expect(orderTypeWord(tp)).toBe("TP");
		expect(orderFlagsText(tp)).toBe(" [R, GTC]");
		const sl: ChartOrder = { ...tp, tpsl: "sl" };
		expect(orderTypeWord(sl)).toBe("SL");
	});

	it("spells out the time-in-force: GTC, IOC, and P for post-only", () => {
		const base: Omit<ChartOrder, "tif"> = {
			side: "B",
			price: 100,
			size: 1,
			reduceOnly: false,
			isTrigger: false,
			tpsl: null,
		};
		expect(orderFlagsText({ ...base, tif: "Gtc" })).toBe(" [GTC]");
		expect(orderFlagsText({ ...base, tif: "Ioc" })).toBe(" [IOC]");
		expect(orderFlagsText({ ...base, tif: "Alo" })).toBe(" [P]");
		expect(orderFlagsText({ ...base, tif: null })).toBe("");
		expect(orderFlagsText({ ...base, tif: "Gtc", reduceOnly: true })).toBe(" [R, GTC]");
	});
});

describe("position label segments", () => {
	it("shows Long, size at mark, live uPnL and the TP/SL buttons", () => {
		const { segments, isBuy } = buildPositionSegments(POSITION, MARK);
		expect(isBuy).toBe(true);
		expect(segments).toHaveLength(5);
		expect(segments[0]).toMatchObject({ text: "Long", filled: true });
		expect(segments[1].text).toBe("338.08 USD");
		expect(segments[2]).toMatchObject({ text: "-0.13 USD" });
		expect(segments[3]).toMatchObject({ text: "TP", key: "tp" });
		expect(segments[4]).toMatchObject({ text: "SL", key: "sl" });
	});

	it("colors a winning position up and a short Short", () => {
		const { segments } = buildPositionSegments({ szi: -2, entryPx: 100 }, 90);
		expect(segments[0].text).toBe("Short");
		expect(segments[2].tone).toBe("up");
	});
});

describe("buildTpSlGhostSegments", () => {
	it("matches the reference chip: pnl, TP/SL word, percent from entry", () => {
		const long = buildTpSlGhostSegments({ tpsl: "tp", entryPx: 100, szi: 1, price: 106 });
		expect(long.map((segment) => segment.text)).toEqual(["+6.00 USD", "TP", "+6.00%"]);
		expect(long[1]).toMatchObject({ filled: true });
	});

	it("keeps a short's take-profit percent positive below the entry", () => {
		const short = buildTpSlGhostSegments({ tpsl: "tp", entryPx: 100, szi: -1, price: 94 });
		expect(short.map((segment) => segment.text)).toEqual(["+6.00 USD", "TP", "+6.00%"]);
	});

	it("shows a losing stop with negative numbers and the sl tone", () => {
		const sl = buildTpSlGhostSegments({ tpsl: "sl", entryPx: 100, szi: 1, price: 94 });
		expect(sl.map((segment) => segment.text)).toEqual(["-6.00 USD", "SL", "-6.00%"]);
		expect(sl[0].tone).toBe("sl");
	});

	it("falls back to the bare word without a usable price or size", () => {
		expect(buildTpSlGhostSegments({ tpsl: "tp", entryPx: 100, szi: 0, price: 106 }).map((s) => s.text)).toEqual(["TP"]);
		expect(buildTpSlGhostSegments({ tpsl: "sl", entryPx: 0, szi: 1, price: 94 }).map((s) => s.text)).toEqual(["SL"]);
	});
});

describe("formatting", () => {
	it("always signs and rounds to cents", () => {
		expect(formatSignedUsd(0)).toBe("+0.00 USD");
		expect(formatSignedUsd(-0.001)).toBe("+0.00 USD");
		expect(formatSignedUsd(-11.748)).toBe("-11.75 USD");
		expect(formatSignedUsd(Number.NaN)).toBe("+0.00 USD");
		expect(formatUsd(266.9208)).toBe("266.92 USD");
	});
});

describe("chartOrderFromOpenOrder", () => {
	it("normalizes limits and triggers from the SDK shape", () => {
		const limit = chartOrderFromOpenOrder({
			coin: "BTC",
			side: "A",
			limitPx: "100",
			sz: "2",
			oid: 1,
			timestamp: 0,
			origSz: "2",
			triggerCondition: "",
			isTrigger: false,
			triggerPx: "0",
			children: [],
			isPositionTpsl: false,
			reduceOnly: true,
			orderType: "Limit",
			tif: "Alo",
			cloid: null,
		});
		expect(limit).toMatchObject({ side: "A", price: 100, size: 2, reduceOnly: true, tif: "Alo", tpsl: null });

		const trigger = chartOrderFromOpenOrder({
			...limit,
			isTrigger: true,
			triggerPx: "110",
			orderType: "Take Profit Market",
		} as never);
		expect(trigger).toMatchObject({ price: 110, isTrigger: true, tpsl: "tp" });
	});
});

describe("buildTpSlExchangeOrder", () => {
	it("builds a reduce-only market trigger in the exchange wire shape", () => {
		const order = buildTpSlExchangeOrder({ assetId: 42, isBuy: false, size: "0.5", triggerPrice: 123.456, tpsl: "tp" });
		expect(order).toMatchObject({
			a: 42,
			b: false,
			p: "123.46",
			s: "0.5",
			r: true,
			t: { trigger: { isMarket: true, triggerPx: "123.46", tpsl: "tp" } },
		});
	});
});
