import { afterEach, describe, expect, it, vi } from "vitest";
import { failedMoveSegments, pendingMoveSegments } from "@/lib/chart/order-move-label";
import type { OpenOrder } from "@/lib/trade/open-orders";
import { mergeChartOrderMoves, useOrderMoveStore } from "@/stores/use-order-move-store";

const order = {
	oid: 42,
	coin: "BTC",
	side: "B",
	limitPx: "84000",
	sz: "0.02",
	tif: "Gtc",
	isTrigger: false,
} as OpenOrder;
afterEach(() => {
	const state = useOrderMoveStore.getState();
	for (const id of Object.keys(state.moves)) state.drop(Number(id));
	vi.useRealTimers();
});
describe("chart-only move placeholders", () => {
	it("retains a non-actionable failure marker through an empty book, then expires it", async () => {
		vi.useFakeTimers();
		const state = useOrderMoveStore.getState();
		state.begin(order, "83000");
		state.fail(42, "No replacement sent; check Open Orders");
		expect(mergeChartOrderMoves([], useOrderMoveStore.getState().moves)).toHaveLength(1);
		expect(state.isMoving(42)).toBe(true);
		expect(state.begin(order, "82000")).toBe(false);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(state.isMoving(42)).toBe(false);
	});
	it("replaces the main content and omits TIF/cancel actions on failed markers", () => {
		expect(pendingMoveSegments("up").map((segment) => segment.text)).toEqual(["Moving…", "…"]);
		expect(pendingMoveSegments("up", "type").map((segment) => segment.text)).toEqual(["Changing…", "…"]);
		expect(failedMoveSegments("up").map((segment) => segment.text)).toEqual(["Unconfirmed", "!"]);
		expect(failedMoveSegments("up").every((segment) => !segment.key)).toBe(true);
	});
	it("moves immediately without changing authoritative account data", () => {
		const raw = [order];
		const state = useOrderMoveStore.getState();
		state.begin(order, "83000");
		expect(mergeChartOrderMoves(raw, useOrderMoveStore.getState().moves)[0].limitPx).toBe("83000");
		expect(raw[0].limitPx).toBe("84000");
		expect(state.isMoving(42)).toBe(true);
	});
	it("never goes blank when the cancel websocket removes the old order", () => {
		const state = useOrderMoveStore.getState();
		state.begin(order, "83000");
		expect(mergeChartOrderMoves([], useOrderMoveStore.getState().moves)).toHaveLength(1);
	});
	it("does not duplicate the old/new exchange IDs during placement and confirmation", () => {
		const state = useOrderMoveStore.getState();
		state.begin(order, "83000");
		const next = { ...order, oid: 99, limitPx: "83000" };
		state.track(42, next);
		expect(mergeChartOrderMoves([order, next], useOrderMoveStore.getState().moves)).toEqual([next]);
		expect(state.isMoving(42)).toBe(true);
		expect(state.isMoving(99)).toBe(true);
		state.settle(42, next);
		expect(state.isMoving(99)).toBe(false);
		expect(mergeChartOrderMoves([], useOrderMoveStore.getState().moves)).toEqual([next]);
	});
	it("removes uncertainty placeholders on failure/fill", () => {
		const state = useOrderMoveStore.getState();
		state.begin(order, "83000");
		state.drop(42);
		expect(mergeChartOrderMoves([], useOrderMoveStore.getState().moves)).toEqual([]);
	});
	it("prevents parallel jobs for the same original/replacement oid", () => {
		const state = useOrderMoveStore.getState();
		expect(state.begin(order, "83000")).toBe(true);
		expect(state.begin(order, "82000")).toBe(false);
		state.track(42, { ...order, oid: 99 });
		expect(state.begin({ ...order, oid: 99 }, "82000")).toBe(false);
	});
});
