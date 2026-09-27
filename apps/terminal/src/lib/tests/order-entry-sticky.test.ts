// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STORAGE_KEYS } from "@/config/app";
import { useOrderEntryStore } from "@/stores/use-order-entry-store";

/**
 * Reduce Only is a sticky preference: the user sets it and it stays until they
 * change it — across order submission (resetForm), across order-type switches
 * between non-trigger types, and across page reloads (persisted slice). It is
 * remembered **per side**: toggling it on long must not change short's memory.
 */
describe("reduce-only stickiness", () => {
	beforeEach(() => {
		useOrderEntryStore.setState({
			side: "buy",
			reduceOnly: false,
			reduceOnlyBySide: { buy: false, sell: false },
			size: "",
			limitPrice: "",
		});
	});

	it("survives resetForm — what every submitted order triggers", () => {
		const { actions } = useOrderEntryStore.getState();
		useOrderEntryStore.setState({ reduceOnly: true, size: "0.5", limitPrice: "100" });
		actions.resetForm();
		expect(useOrderEntryStore.getState().reduceOnly).toBe(true);
		// Size is sticky too (typed values survive), transient prices still clear:
		expect(useOrderEntryStore.getState().size).toBe("0.5");
		expect(useOrderEntryStore.getState().limitPrice).toBe("");
	});

	it("stays off after a reset if it was off", () => {
		const { actions } = useOrderEntryStore.getState();
		useOrderEntryStore.setState({ reduceOnly: false, size: "1" });
		actions.resetForm();
		expect(useOrderEntryStore.getState().reduceOnly).toBe(false);
	});

	it("survives order-type switches between non-trigger types", () => {
		const { actions } = useOrderEntryStore.getState();
		useOrderEntryStore.setState({ reduceOnly: true });
		actions.setOrderType("limit");
		expect(useOrderEntryStore.getState().reduceOnly).toBe(true);
		actions.setOrderType("market");
		expect(useOrderEntryStore.getState().reduceOnly).toBe(true);
	});

	it("persists to localStorage so it survives a reload", () => {
		useOrderEntryStore.getState().actions.setReduceOnly(true);
		const raw = localStorage.getItem(STORAGE_KEYS.ORDER_ENTRY);
		expect(raw).not.toBeNull();
		const parsed = JSON.parse(raw ?? "{}") as {
			state?: { reduceOnly?: boolean; reduceOnlyBySide?: { buy?: boolean; sell?: boolean } };
		};
		expect(parsed.state?.reduceOnly).toBe(true);
		expect(parsed.state?.reduceOnlyBySide).toEqual({ buy: true, sell: false });
	});
});

describe("per-side reduce-only memory", () => {
	beforeEach(() => {
		useOrderEntryStore.setState({
			side: "buy",
			orderType: "market",
			reduceOnly: false,
			reduceOnlyBySide: { buy: false, sell: false },
		});
	});

	it("toggling it on long leaves the short's memory off", () => {
		const { actions } = useOrderEntryStore.getState();
		actions.setSide("buy");
		actions.setReduceOnly(true);
		expect(useOrderEntryStore.getState().reduceOnly).toBe(true);
		actions.setSide("sell");
		expect(useOrderEntryStore.getState().reduceOnly).toBe(false);
		actions.setSide("buy");
		expect(useOrderEntryStore.getState().reduceOnly).toBe(true);
	});

	it("stays independent in both directions", () => {
		const { actions } = useOrderEntryStore.getState();
		actions.setReduceOnly(true); // long on
		actions.setSide("sell");
		actions.setReduceOnly(true); // short on
		actions.setSide("buy");
		actions.setReduceOnly(false); // long off — short must stay on
		actions.setSide("sell");
		expect(useOrderEntryStore.getState().reduceOnly).toBe(true);
		actions.setSide("buy");
		expect(useOrderEntryStore.getState().reduceOnly).toBe(false);
	});

	it("switching sides under a trigger type keeps reduce-only on (triggers always are)", () => {
		const { actions } = useOrderEntryStore.getState();
		actions.setOrderType("stopMarket");
		expect(useOrderEntryStore.getState().reduceOnly).toBe(true);
		actions.setSide("sell");
		expect(useOrderEntryStore.getState().reduceOnly).toBe(true);
		// …and the forced value never poisons either side's memory:
		expect(useOrderEntryStore.getState().reduceOnlyBySide).toEqual({ buy: false, sell: false });
	});
	afterEach(() => {
		localStorage.removeItem(STORAGE_KEYS.ORDER_ENTRY);
	});
});

describe("reduce-only persistence migration", () => {
	afterEach(() => {
		localStorage.removeItem(STORAGE_KEYS.ORDER_ENTRY);
	});

	it("migrates a pre-split save (single reduceOnly) into both sides", async () => {
		localStorage.setItem(
			STORAGE_KEYS.ORDER_ENTRY,
			JSON.stringify({ state: { side: "sell", orderType: "market", sizeMode: "base", reduceOnly: true }, version: 2 }),
		);
		await useOrderEntryStore.persist.rehydrate();
		const state = useOrderEntryStore.getState();
		expect(state.reduceOnlyBySide).toEqual({ buy: true, sell: true });
		expect(state.reduceOnly).toBe(true); // selected side (sell) shows its slot
	});

	it("rehydrating into a trigger type forces reduce-only on without touching memory", async () => {
		localStorage.setItem(
			STORAGE_KEYS.ORDER_ENTRY,
			JSON.stringify({
				state: {
					side: "buy",
					orderType: "stopMarket",
					sizeMode: "base",
					reduceOnly: false,
					reduceOnlyBySide: { buy: false, sell: false },
				},
				version: 2,
			}),
		);
		await useOrderEntryStore.persist.rehydrate();
		const state = useOrderEntryStore.getState();
		expect(state.reduceOnly).toBe(true);
		expect(state.reduceOnlyBySide).toEqual({ buy: false, sell: false });
	});
});

describe("scale auto-preview", () => {
	beforeEach(() => {
		useOrderEntryStore.setState({
			orderType: "market",
			scaleStart: "",
			scaleEnd: "",
			scaleLevels: 4,
			scalePreview: false,
		});
	});

	it("turns on as soon as a scale price exists (lone start is enough)", () => {
		const { actions } = useOrderEntryStore.getState();
		actions.setScaleStart("83000");
		expect(useOrderEntryStore.getState().scalePreview).toBe(false); // not scale mode yet
		actions.setOrderType("scale");
		expect(useOrderEntryStore.getState().scalePreview).toBe(true);
	});

	it("does not turn on without any scale price", () => {
		const { actions } = useOrderEntryStore.getState();
		actions.setOrderType("scale");
		expect(useOrderEntryStore.getState().scalePreview).toBe(false);
	});

	it("manual hides win until the next price edit (a chart pick must show its result)", () => {
		const { actions } = useOrderEntryStore.getState();
		actions.setOrderType("scale");
		actions.setScaleStart("83000");
		actions.setScalePreview(false);
		expect(useOrderEntryStore.getState().scalePreview).toBe(false);
		actions.setScaleEnd("85000");
		expect(useOrderEntryStore.getState().scalePreview).toBe(true);
	});

	it("explicit toggles are never overridden", () => {
		const { actions } = useOrderEntryStore.getState();
		actions.setOrderType("scale");
		actions.setScaleStart("83000");
		actions.setScalePreview(false);
		actions.setScaleLevels(6); // no price change → stays hidden
		expect(useOrderEntryStore.getState().scalePreview).toBe(false);
	});
});

describe("scale preview toggle lifecycle", () => {
	it("clears with resetForm like the other scale fields", () => {
		const { actions } = useOrderEntryStore.getState();
		actions.setScalePreview(true);
		actions.setScaleStart("100");
		actions.resetForm();
		expect(useOrderEntryStore.getState().scalePreview).toBe(false);
		expect(useOrderEntryStore.getState().scaleStart).toBe("");
		// …and it is transient: never part of the persisted slice.
		const parsed = JSON.parse(localStorage.getItem(STORAGE_KEYS.ORDER_ENTRY) ?? "{}") as {
			state?: Record<string, unknown>;
		};
		expect(parsed.state && "scalePreview" in parsed.state).toBeFalsy();
	});
});

describe("size stickiness after submission", () => {
	beforeEach(() => {
		useOrderEntryStore.setState({ size: "", limitPrice: "", tpPrice: "" });
	});

	it("keeps the last typed size through resetForm", () => {
		const { actions } = useOrderEntryStore.getState();
		actions.setSize("0.75");
		actions.setLimitPrice("100");
		actions.setTpPrice("120");
		actions.resetForm();
		expect(useOrderEntryStore.getState().size).toBe("0.75");
	});

	it("still clears the transient prices in the same reset", () => {
		const { actions } = useOrderEntryStore.getState();
		actions.setSize("1");
		actions.setLimitPrice("100");
		actions.setTriggerPrice("90");
		actions.setTpPrice("120");
		actions.setSlPrice("80");
		actions.resetForm();
		const state = useOrderEntryStore.getState();
		expect(state.size).toBe("1");
		expect(state.limitPrice).toBe("");
		expect(state.triggerPrice).toBe("");
		expect(state.tpPrice).toBe("");
		expect(state.slPrice).toBe("");
	});
});
