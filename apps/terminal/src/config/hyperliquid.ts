import type { BuilderConfig } from "@/lib/hyperliquid";

/**
 * Builder code attached to live orders (the exchange `builder` param). Fees are
 * strictly opt-in: with no `VITE_BUILDER_ADDRESS` set — the default for self-hosted
 * installs — no builder code is attached, no fee is paid, and no "Builder Fee" row
 * appears in the order summaries. Preview (paper) orders are simulated locally and
 * never carry one either.
 *
 * `fee` uses Hyperliquid's builder units as displayed by bpsToPercentage (10 = 0.01%),
 * clamped to the exchange maximum for perps (100).
 */
export function resolveBuilderConfig(env: { address?: string; fee?: string }): BuilderConfig {
	const address = env.address?.trim();
	if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) return undefined;

	const parsed = env.fee !== undefined && env.fee !== "" ? Number.parseInt(env.fee, 10) : Number.NaN;
	const fee = Number.isFinite(parsed) && parsed >= 0 ? Math.min(parsed, 100) : 10;
	return { b: address, f: fee };
}

export const DEFAULT_BUILDER_CONFIG: BuilderConfig = resolveBuilderConfig({
	address: import.meta.env.VITE_BUILDER_ADDRESS,
	fee: import.meta.env.VITE_BUILDER_FEE,
});
