// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { calculateDefaultTpSl, DEFAULT_TP_SL_PERCENT } from "@/lib/trade/tpsl";
import { useOrderEntryStore } from "@/stores/use-order-entry-store";

/**
 * Toggling TP/SL seeds fresh ±2% defaults (side-aware) so the fields — and the
 * chart's PREVIEW lines — always show a sensible limit/TP/SL trio. Disabling
 * clears the fields so the next enable re-seeds deterministically.
 */
describe("default TP/SL seeds", () => {
	it("defaults to ±2%, side-aware", () => {
		expect(DEFAULT_TP_SL_PERCENT).toBe(2);
		expect(calculateDefaultTpSl(100, "buy", 2)).toEqual({ tp: "102.00", sl: "98.00" });
		expect(calculateDefaultTpSl(100, "sell", 2)).toEqual({ tp: "98.00", sl: "102.00" });
		expect(calculateDefaultTpSl(84000, "buy", 1)).toEqual({ tp: "85680.0", sl: "82320.0" });
	});

	it("refuses an unusable reference instead of guessing", () => {
		expect(calculateDefaultTpSl(0, "buy", 2)).toBeNull();
		expect(calculateDefaultTpSl(-1, "buy", 2)).toBeNull();
	});
});

describe("setTpSlEnabled seeding", () => {
	beforeEach(() => {
		useOrderEntryStore.setState({ side: "buy", tpSlEnabled: false, tpPrice: "", slPrice: "" });
	});

	it("seeds ±2% off the reference on enable and clears the fields on disable", () => {
		const { actions } = useOrderEntryStore.getState();
		actions.setTpSlEnabled(true, { base: 84000, priceDecimals: 1 });
		expect(useOrderEntryStore.getState().tpSlEnabled).toBe(true);
		expect(Number(useOrderEntryStore.getState().tpPrice)).toBe(85680);
		expect(Number(useOrderEntryStore.getState().slPrice)).toBe(82320);

		actions.setTpSlEnabled(false);
		expect(useOrderEntryStore.getState().tpSlEnabled).toBe(false);
		expect(useOrderEntryStore.getState().tpPrice).toBe("");
		expect(useOrderEntryStore.getState().slPrice).toBe("");
	});

	it("re-seeds direction-aware when the side flipped while disabled", () => {
		const { actions } = useOrderEntryStore.getState();
		actions.setTpSlEnabled(true, { base: 84000, priceDecimals: 1 });
		actions.setTpSlEnabled(false);
		actions.setSide("sell");
		actions.setTpSlEnabled(true, { base: 84000, priceDecimals: 1 });
		expect(Number(useOrderEntryStore.getState().tpPrice)).toBe(82320);
		expect(Number(useOrderEntryStore.getState().slPrice)).toBe(85680);
	});

	it("enables with empty fields when no usable base is available", () => {
		useOrderEntryStore.getState().actions.setTpSlEnabled(true, { base: 0 });
		expect(useOrderEntryStore.getState().tpSlEnabled).toBe(true);
		expect(useOrderEntryStore.getState().tpPrice).toBe("");
		expect(useOrderEntryStore.getState().slPrice).toBe("");
	});
});
