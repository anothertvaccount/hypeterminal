import { describe, expect, it } from "vitest";
import { resolveBuilderConfig } from "@/config/hyperliquid";

const ADDRESS = "0x744e2f0b69456B42278B3e797a58Ff57e5180A7E";

describe("resolveBuilderConfig", () => {
	it("attaches no builder code when no address is configured (self-hosted default)", () => {
		expect(resolveBuilderConfig({})).toBeUndefined();
		expect(resolveBuilderConfig({ address: "" })).toBeUndefined();
		expect(resolveBuilderConfig({ address: "   " })).toBeUndefined();
	});

	it("rejects malformed addresses so a typo cannot break live orders", () => {
		expect(resolveBuilderConfig({ address: "not-an-address" })).toBeUndefined();
		expect(resolveBuilderConfig({ address: "0x1234" })).toBeUndefined();
	});

	it("defaults the fee to 10 (0.01%) when only an address is set", () => {
		expect(resolveBuilderConfig({ address: ADDRESS })).toEqual({ b: ADDRESS, f: 10 });
		expect(resolveBuilderConfig({ address: ADDRESS, fee: "" })).toEqual({ b: ADDRESS, f: 10 });
	});

	it("uses an explicit fee and clamps to the perps maximum", () => {
		expect(resolveBuilderConfig({ address: ADDRESS, fee: "25" })).toEqual({ b: ADDRESS, f: 25 });
		expect(resolveBuilderConfig({ address: ADDRESS, fee: "0" })).toEqual({ b: ADDRESS, f: 0 });
		expect(resolveBuilderConfig({ address: ADDRESS, fee: "9999" })).toEqual({ b: ADDRESS, f: 100 });
		expect(resolveBuilderConfig({ address: ADDRESS, fee: "-5" })).toEqual({ b: ADDRESS, f: 10 });
	});
});
