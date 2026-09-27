import { describe, expect, it } from "vitest";
import {
	CHASE_MODIFY_INTERVAL_MS,
	CHASE_TIMEOUT_MS,
	CHASE_TRACK_GRACE_MS,
	chaseBehindMarkPrice,
	chaseBookTouch,
	chasePlacementPrice,
	findChaseOrder,
	isPostOnlyRaceError,
	nextCloseChaseAction,
	shouldCancelChase,
	shouldWaitForOrderSnapshot,
} from "@/domain/trade/order/chase";

describe("chase cadence constants", () => {
	it("re-prices every 750ms and cancels after 30s", () => {
		// Faster than the1-2s you might hand-pick: safe against rate limits (one chase
		// at a time, no-ops when already at the touch) while staying glued to the book.
		expect(CHASE_MODIFY_INTERVAL_MS).toBe(750);
		expect(CHASE_TIMEOUT_MS).toBe(30_000);
	});
});

describe("chaseBehindMarkPrice", () => {
	it("places a buy one tick behind the mark and a sell one tick ahead", () => {
		// szDecimals 2 → price decimals 4 → tick 0.0001
		expect(chaseBehindMarkPrice("buy", 100, 2)).toBeCloseTo(99.9999, 6);
		expect(chaseBehindMarkPrice("sell", 100, 2)).toBeCloseTo(100.0001, 6);
	});

	it("never produces a non-positive price", () => {
		expect(chaseBehindMarkPrice("buy", 0, 4)).toBeGreaterThan(0);
		expect(chaseBehindMarkPrice("sell", Number.NaN, 4)).toBeGreaterThan(0);
	});
});

describe("findChaseOrder", () => {
	const entry = {
		coin: "BTC",
		side: "buy" as const,
		sizeText: "0.5",
		reduceOnly: false,
		startedAt: 1,
	};

	it("matches the resting chase order by coin, side, size, and reduce flag", () => {
		const target = {
			coin: "BTC",
			side: "B",
			origSz: "0.5",
			isTrigger: false,
			reduceOnly: false,
			oid: 7,
		};
		expect(findChaseOrder([target], entry)).toBe(target);
	});

	it("rejects look-alikes: triggers, other sizes, the wrong side, reduce mismatch", () => {
		const base = { coin: "BTC", side: "B", origSz: "0.5", isTrigger: false, reduceOnly: false };
		expect(findChaseOrder([{ ...base, isTrigger: true }], entry)).toBeUndefined();
		expect(findChaseOrder([{ ...base, origSz: "1" }], entry)).toBeUndefined();
		expect(findChaseOrder([{ ...base, side: "A" }], entry)).toBeUndefined();
		expect(findChaseOrder([{ ...base, reduceOnly: true }], entry)).toBeUndefined();
		expect(findChaseOrder([{ ...base, coin: "ETH" }], entry)).toBeUndefined();
	});
});

describe("shouldCancelChase", () => {
	it("fires exactly at the timeout", () => {
		expect(shouldCancelChase(1_000, 1_000 + 29_999, CHASE_TIMEOUT_MS)).toBe(false);
		expect(shouldCancelChase(1_000, 1_000 + CHASE_TIMEOUT_MS, CHASE_TIMEOUT_MS)).toBe(true);
		expect(shouldCancelChase(1_000, 1_000 + 60_000, CHASE_TIMEOUT_MS)).toBe(true);
	});
});

describe("shouldWaitForOrderSnapshot", () => {
	it("waits while the placement snapshot is in flight and gives up at the grace deadline", () => {
		expect(shouldWaitForOrderSnapshot(1_000, 1_000)).toBe(true);
		expect(shouldWaitForOrderSnapshot(1_000, 1_000 + CHASE_TRACK_GRACE_MS - 1)).toBe(true);
		expect(shouldWaitForOrderSnapshot(1_000, 1_000 + CHASE_TRACK_GRACE_MS)).toBe(false);
		expect(shouldWaitForOrderSnapshot(1_000, 1_000 + 30_000)).toBe(false);
	});
});

describe("chaseBookTouch", () => {
	const levels = [
		[{ px: "100" }, { px: "99" }],
		[{ px: "101" }, { px: "102" }],
	] as const;

	it("reads the best bid for buys and the best ask for sells", () => {
		expect(chaseBookTouch("buy", levels)).toBe(100);
		expect(chaseBookTouch("sell", levels)).toBe(101);
	});

	it("returns null when the snapshot is missing, empty, or malformed", () => {
		expect(chaseBookTouch("buy", undefined)).toBeNull();
		expect(chaseBookTouch("buy", null)).toBeNull();
		expect(chaseBookTouch("buy", [[], [{ px: "101" }]])).toBeNull();
		expect(chaseBookTouch("buy", [[{ px: undefined }], []])).toBeNull();
		expect(chaseBookTouch("buy", [[{ px: "NaN" }], [{ px: "101" }]])).toBeNull();
	});
});

describe("chasePlacementPrice", () => {
	const levels = [[{ px: "100" }], [{ px: "101" }]] as const;

	it("prefers the book touch for both tifs (non-marketable by construction)", () => {
		expect(chasePlacementPrice("buy", levels, 999, 0, "Alo")).toBe(100);
		expect(chasePlacementPrice("sell", levels, 999, 0, "Alo")).toBe(101);
		expect(chasePlacementPrice("buy", levels, 999, 0, "Gtc")).toBe(100);
	});

	it("refuses to guess a post-only price without a book", () => {
		expect(chasePlacementPrice("buy", undefined, 999, 0, "Alo")).toBeNull();
		expect(chasePlacementPrice("buy", [[], []], 999, 0, "Alo")).toBeNull();
	});

	it("falls back to mark − tick for Gtc when no book is available", () => {
		expect(chasePlacementPrice("buy", undefined, 999, 0, "Gtc")).toBe(chaseBehindMarkPrice("buy", 999, 0));
		expect(chasePlacementPrice("sell", undefined, 999, 0, "Gtc")).toBe(chaseBehindMarkPrice("sell", 999, 0));
	});
});

describe("isPostOnlyRaceError", () => {
	it("matches Hyperliquid's benign crossing rejection and nothing else", () => {
		expect(
			isPostOnlyRaceError("Order 0: Post only order would have immediately matched, bbo was 84441@84442. asset=0"),
		).toBe(true);
		expect(isPostOnlyRaceError("Insufficient margin to place order")).toBe(false);
		expect(isPostOnlyRaceError(undefined)).toBe(false);
		expect(isPostOnlyRaceError("")).toBe(false);
	});
});

/**
 * A close chase must ride until the position is flat. The regression these guard:
 * an unknown position (snapshot in flight) was read as flat, which cancelled the
 * resting order and retired the chase as "completed" — the phone chase stopped
 * after ~40s with the position still open.
 */
describe("nextCloseChaseAction", () => {
	it("waits when the position is not known yet (never treats unknown as flat)", () => {
		expect(nextCloseChaseAction({ remaining: null, markPx: 84_000 })).toBe("wait");
	});

	it("re-posts when the order is gone but the position is still open", () => {
		expect(nextCloseChaseAction({ remaining: { szi: 2.5, closeable: "2.5" }, markPx: 84_000 })).toBe("replace");
	});

	it("completes only when the position is genuinely flat", () => {
		expect(nextCloseChaseAction({ remaining: { szi: 0, closeable: "0" }, markPx: 84_000 })).toBe("completed");
	});

	it("reports dust for a remainder no order can fill", () => {
		// $5 of notional is under Hyperliquid's $10 minimum order size.
		expect(nextCloseChaseAction({ remaining: { szi: 0.5, closeable: "0.5" }, markPx: 10 })).toBe("dust");
		// Formats to zero at the market's size precision.
		expect(nextCloseChaseAction({ remaining: { szi: 1, closeable: "0" }, markPx: 84_000 })).toBe("dust");
	});
});
