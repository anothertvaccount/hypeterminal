import { describe, expect, it, vi } from "vitest";
import { type PerpOrderContext, validatePerpOrder } from "@/lib/errors/stacks/perp-order";

vi.mock("@lingui/core/macro", () => ({
	t: (strings: TemplateStringsArray, ...values: unknown[]) =>
		strings.reduce((message, part, index) => message + part + (index < values.length ? String(values[index]) : ""), ""),
}));

const ready: PerpOrderContext = {
	isConnected: true,
	isWalletLoading: false,
	isReadyToTrade: true,
	needsAgentApproval: false,
	availableBalance: 1000,
	hasMarket: true,
	hasAssetIndex: true,
	orderType: "chaseLimit",
	side: "sell",
	reduceOnly: true,
	reduceOnlyPositionSzi: 1,
	price: 100,
	markPx: 100,
	sizeValue: 1,
	orderValue: 100,
	maxSize: 10,
	usesLimitPrice: false,
	usesTriggerPrice: false,
	triggerPriceNum: null,
	stopOrder: false,
	takeProfitOrder: false,
	scaleOrder: false,
	twapOrder: false,
	scaleStartPriceNum: null,
	scaleEndPriceNum: null,
	scaleLevelsNum: null,
	twapMinutesNum: null,
	tpSlEnabled: false,
	canUseTpSl: false,
	tpPriceNum: null,
	slPriceNum: null,
};

describe("reduce-only Chase form validation", () => {
	it("explains a flat position and blocks before sending, even with a positive balance max", () => {
		const result = validatePerpOrder({ ...ready, reduceOnlyPositionSzi: 0 });
		expect(result.canSubmit).toBe(false);
		expect(result.errors.map((error) => error.message)).toEqual([
			"Reduce Only needs an open position. Turn it off to open a trade.",
		]);
	});

	it.each([null, undefined, Number.NaN])("waits for unavailable position data (%s) without claiming flat", (size) => {
		const result = validatePerpOrder({ ...ready, reduceOnlyPositionSzi: size });
		expect(result.canSubmit).toBe(false);
		expect(result.errors[0].message).toBe("Waiting for position data to check Reduce Only");
	});

	it.each([
		[1, "sell"],
		[-1, "buy"],
	] as const)("allows reducing signed position %s with %s", (size, side) => {
		expect(validatePerpOrder({ ...ready, reduceOnlyPositionSzi: size, side }).canSubmit).toBe(true);
	});

	it.each([
		[1, "buy", "Sell", "long"],
		[-1, "sell", "Buy", "short"],
	] as const)("explains the wrong side for signed position %s", (size, side, choice, direction) => {
		const result = validatePerpOrder({ ...ready, reduceOnlyPositionSzi: size, side });
		expect(result.canSubmit).toBe(false);
		expect(result.errors[0].message).toBe(`Choose ${choice} to reduce your ${direction} position.`);
	});

	it("allows a new entry when Reduce Only is switched off", () => {
		expect(validatePerpOrder({ ...ready, reduceOnly: false, reduceOnlyPositionSzi: 0 }).canSubmit).toBe(true);
	});

	it.each(["limit", "market", "stopMarket", "takeProfitMarket"])("preserves existing %s validation", (orderType) => {
		expect(validatePerpOrder({ ...ready, orderType, reduceOnlyPositionSzi: 0 }).canSubmit).toBe(true);
	});
});
