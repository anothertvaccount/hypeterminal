// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { STORAGE_KEYS } from "@/config/app";
import { DEFAULT_LIMIT_SIZE_USD } from "@/config/trade";
import { useGlobalSettingsStore } from "@/stores/use-global-settings-store";
import { useOrderEntryStore } from "@/stores/use-order-entry-store";

/**
 * Default limit size (Settings → Default size, $100 USDC out of the box):
 * switching to the Limit tab with an EMPTY size prefills it — quote mode stores
 * the USD amount, base mode converts at the reference price. A typed/sticky size
 * is never overwritten.
 */
describe("default limit size prefill", () => {
	beforeEach(() => {
		useGlobalSettingsStore.setState({ defaultLimitSizeUsd: DEFAULT_LIMIT_SIZE_USD });
		useOrderEntryStore.setState({
			side: "buy",
			orderType: "market",
			sizeMode: "base",
			size: "",
			limitPrice: "",
			tif: "Alo",
		});
	});

	it("defaults to $100 and prefills quote mode exactly", () => {
		expect(DEFAULT_LIMIT_SIZE_USD).toBe(100);
		const { actions } = useOrderEntryStore.getState();
		actions.setSizeMode("quote");
		actions.setOrderType("limit", { price: 84000, szDecimals: 5 });
		expect(useOrderEntryStore.getState().size).toBe("100");
	});

	it("converts to base units at the reference price in base mode", () => {
		const { actions } = useOrderEntryStore.getState();
		actions.setOrderType("limit", { price: 84000, szDecimals: 5 });
		// 100 / 84000 = 0.001190… → floored at BTC's 5 size decimals.
		expect(useOrderEntryStore.getState().size).toBe("0.00119");
	});

	it("never overwrites a size the user typed (sticky wins)", () => {
		const { actions } = useOrderEntryStore.getState();
		actions.setSize("0.5");
		actions.setOrderType("limit", { price: 84000, szDecimals: 5 });
		expect(useOrderEntryStore.getState().size).toBe("0.5");
	});

	it("does not prefill without a reference price, or for non-limit types", () => {
		const { actions } = useOrderEntryStore.getState();
		actions.setOrderType("limit");
		expect(useOrderEntryStore.getState().size).toBe("");
		actions.setOrderType("scale", { price: 84000, szDecimals: 5 });
		expect(useOrderEntryStore.getState().size).toBe("");
	});

	it("uses the configured amount and ignores invalid settings values", () => {
		const { actions: settings } = useGlobalSettingsStore.getState();
		settings.setDefaultLimitSizeUsd(250);
		const { actions } = useOrderEntryStore.getState();
		actions.setSizeMode("quote");
		actions.setOrderType("limit", { price: 84000, szDecimals: 5 });
		expect(useOrderEntryStore.getState().size).toBe("250");

		settings.setDefaultLimitSizeUsd(0);
		settings.setDefaultLimitSizeUsd(-5);
		settings.setDefaultLimitSizeUsd(Number.NaN);
		expect(useGlobalSettingsStore.getState().defaultLimitSizeUsd).toBe(250);
	});

	it("skips the prefill when the converted size rounds to zero at the market's precision", () => {
		const { actions } = useOrderEntryStore.getState();
		// $100 at $84,000 with integer size precision → 0.001… → "0" → leave empty.
		actions.setOrderType("limit", { price: 84000, szDecimals: 0 });
		expect(useOrderEntryStore.getState().size).toBe("");
	});
});

describe("size memory (last size used, across reloads)", () => {
	beforeEach(() => {
		useGlobalSettingsStore.setState({ defaultLimitSizeUsd: DEFAULT_LIMIT_SIZE_USD });
		useOrderEntryStore.setState({
			side: "buy",
			orderType: "market",
			sizeMode: "base",
			size: "",
			limitPrice: "",
			tif: "Alo",
		});
	});

	it("persists the last used size to storage", () => {
		useOrderEntryStore.getState().actions.setSize("0.0042");
		const raw = localStorage.getItem(STORAGE_KEYS.ORDER_ENTRY);
		const parsed = JSON.parse(raw ?? "{}") as { state?: { size?: string } };
		expect(parsed.state?.size).toBe("0.0042");
	});

	it("restores the last size on reload — neither the default nor a tab switch overwrites it", async () => {
		localStorage.setItem(
			STORAGE_KEYS.ORDER_ENTRY,
			JSON.stringify({ state: { side: "buy", orderType: "limit", sizeMode: "base", size: "0.0042" }, version: 2 }),
		);
		await useOrderEntryStore.persist.rehydrate();
		expect(useOrderEntryStore.getState().size).toBe("0.0042");
		// Even a Market → Limit transition (the default-size prefill path) must not clobber it.
		const { actions } = useOrderEntryStore.getState();
		actions.setOrderType("market");
		actions.setOrderType("limit", { price: 84000, szDecimals: 5 });
		expect(useOrderEntryStore.getState().size).toBe("0.0042");
	});

	it("seeds the default when the size was never used", async () => {
		localStorage.setItem(
			STORAGE_KEYS.ORDER_ENTRY,
			JSON.stringify({ state: { side: "buy", orderType: "limit", sizeMode: "quote" }, version: 2 }),
		);
		await useOrderEntryStore.persist.rehydrate();
		// Empty size on boot: the trade panel's boot effect re-enters setOrderType to seed.
		expect(useOrderEntryStore.getState().size).toBe("");
		useOrderEntryStore.getState().actions.setOrderType("limit");
		expect(useOrderEntryStore.getState().size).toBe("100");
	});
});
