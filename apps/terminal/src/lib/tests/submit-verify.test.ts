import { describe, expect, it } from "vitest";
import { isAmbiguousSubmitError, matchesSubmittedOrder } from "@/lib/trade/submit-verify";

describe("ambiguous live submit errors", () => {
	it("flags transport failures as unknown-outcome, not hard failures", () => {
		expect(isAmbiguousSubmitError(new Error("Unknown HTTP request error: TimeoutError: signal timed out"))).toBe(true);
		expect(isAmbiguousSubmitError(new Error("signal SIGABRT"))).toBe(false);
		expect(isAmbiguousSubmitError(new Error("Insufficient margin"))).toBe(false);
		expect(isAmbiguousSubmitError(new Error("User rejected the request"))).toBe(false);
	});

	it("recognises our order in the book (incl. a partial fill)", () => {
		const fp = { coin: "xyz:XYZ100", isBuy: true, size: 0.0004, price: 30141 };
		expect(matchesSubmittedOrder({ coin: "xyz:XYZ100", side: "B", sz: "0.0004", limitPx: "30141" }, fp)).toBe(true);
		// partially filled already
		expect(matchesSubmittedOrder({ coin: "xyz:XYZ100", side: "B", sz: "0.0002", limitPx: "30141" }, fp)).toBe(true);
		// rested better than typed (a marketable buy) still counts as ours
		expect(matchesSubmittedOrder({ coin: "xyz:XYZ100", side: "B", sz: "0.0004", limitPx: "30100" }, fp)).toBe(true);
		// different order entirely
		expect(matchesSubmittedOrder({ coin: "xyz:XYZ100", side: "A", sz: "0.0004", limitPx: "30141" }, fp)).toBe(false);
		expect(matchesSubmittedOrder({ coin: "xyz:XYZ100", side: "B", sz: "1", limitPx: "30141" }, fp)).toBe(false);
		expect(matchesSubmittedOrder({ coin: "BTC", side: "B", sz: "0.0004", limitPx: "30141" }, fp)).toBe(false);
		// triggers are never the entry we submitted
		expect(
			matchesSubmittedOrder({ coin: "xyz:XYZ100", side: "B", sz: "0.0004", limitPx: "30141", isTrigger: true }, fp),
		).toBe(false);
	});
});
