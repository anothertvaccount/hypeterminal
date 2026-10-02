// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperOpenOrder, PaperPosition } from "@/lib/paper-trading";
import { collectPaperFills } from "@/lib/paper-trading";
import { usePaperTradingStore } from "@/stores/use-paper-store";
import type { TpSlOrigin } from "@/stores/use-tpsl-origin-store";

vi.mock("@/lib/fill-sound", () => ({ playActionSound: vi.fn() }));
vi.mock("@/stores/use-fill-notifications-store", () => ({ emitFillNotifications: vi.fn() }));
const position: PaperPosition = {
	assetId: 0,
	coin: "BTC",
	szi: 0.02,
	entryPx: 80000,
	leverage: 10,
	marginMode: "cross",
};
const order: PaperOpenOrder = {
	oid: 42,
	assetId: 0,
	coin: "BTC",
	isBuy: false,
	size: 0,
	limitPx: 90000,
	reduceOnly: true,
	leverage: 10,
	marginMode: "cross",
	tif: "Gtc",
	placedAt: 0,
	isTrigger: true,
	triggerPx: 90000,
	tpsl: "tp",
	isMarketTrigger: true,
	isPositionTpsl: true,
};
const origin: TpSlOrigin = {
	scope: "paper:mainnet:none",
	oid: 42,
	coin: "BTC",
	side: "A",
	cloid: null,
	tpsl: "tp",
	fullPosition: true,
	positionTpsl: true,
};
beforeEach(() => usePaperTradingStore.setState({ positions: [position], openOrders: [order], realizedUsd: 0 }));
describe("paper TP/SL conversion", () => {
	it.each(["Alo", "Gtc"] as const)("resolves full-position size for %s and restores the market trigger", (mode) => {
		const actions = usePaperTradingStore.getState().actions;
		const limit = actions.convertTpSl(42, mode, 90000, origin);
		expect(limit).toMatchObject({ isTrigger: false, reduceOnly: true, sz: "0.02", tif: mode });
		const restored = actions.convertTpSl(42, "TriggerMarket", 91000, origin);
		expect(restored).toMatchObject({
			isTrigger: true,
			sz: "0",
			origSz: "0",
			triggerPx: "91000",
			orderType: "Take Profit Market",
			isPositionTpsl: true,
		});
	});
	it("closes the actual position when a restored zero-size trigger fires", () => {
		const result = collectPaperFills([position], [order], { BTC: "90001" });
		expect(result.positions).toHaveLength(0);
		expect(result.filled[0].size).toBe(0.02);
	});
	it("keeps full-position protection untouched when the position direction changed", () => {
		usePaperTradingStore.setState({ positions: [{ ...position, szi: -0.02 }] });
		expect(() => usePaperTradingStore.getState().actions.convertTpSl(42, "Gtc", 90000, origin)).toThrow("No position");
		expect(usePaperTradingStore.getState().openOrders).toEqual([order]);
	});
});
