import { describe, expect, it } from "vitest";
import { getReduceOnlyMaxBase } from "@/domain/trade/order/reduce-only";

describe("getReduceOnlyMaxBase", () => {
	it("sizes to the current position when one exists", () => {
		expect(getReduceOnlyMaxBase({ positionSize: 0.75, openBuySize: 3 })).toBe(0.75);
	});

	it("sizes to resting buy limits when flat", () => {
		expect(getReduceOnlyMaxBase({ positionSize: 0, openBuySize: 1.25 })).toBe(1.25);
	});

	it("returns null when flat with no resting buys so callers keep balance-based sizing", () => {
		expect(getReduceOnlyMaxBase({ positionSize: 0, openBuySize: 0 })).toBeNull();
	});

	it("treats a signed position size as absolute", () => {
		expect(getReduceOnlyMaxBase({ positionSize: -2, openBuySize: 5 })).toBe(2);
	});
});
