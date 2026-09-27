/**
 * Live submits that die on a transport timeout are AMBIGUOUS: the exchange may
 * have accepted the order and the response was simply lost (network blip, proxy,
 * or — like Hyperliquid's scheduled upgrades — a node restart mid-request). A
 * blind retry doubles the position, so before declaring failure we check whether
 * the order actually landed.
 */

/** Transport-level failures where "did it land?" is genuinely unknown. */
export function isAmbiguousSubmitError(error: unknown): boolean {
	const message = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase();
	if (message.includes("user rejected") || message.includes("user denied")) return false;
	return (
		message.includes("timed out") ||
		message.includes("timeout") ||
		message.includes("http request error") ||
		message.includes("network error") ||
		message.includes("failed to fetch") ||
		message.includes("fetch failed") ||
		message.includes("econnreset") ||
		message.includes("socket hang up")
	);
}

export interface SubmittedOrderFingerprint {
	coin: string;
	isBuy: boolean;
	size: number;
	price: number;
}

/** True when a resting order matches what we tried to submit (price may improve). */
export function matchesSubmittedOrder(
	order: {
		coin?: string;
		side?: string;
		origSz?: string | number;
		sz?: string | number;
		limitPx?: string | number;
		isTrigger?: boolean;
	},
	fingerprint: SubmittedOrderFingerprint,
): boolean {
	if (order.isTrigger) return false;
	if ((order.coin ?? "").toUpperCase() !== fingerprint.coin.toUpperCase()) return false;
	const side = order.side === "B" || order.side === "b";
	if (side !== fingerprint.isBuy) return false;
	const remaining = Number(order.sz ?? order.origSz ?? 0);
	const submitted = Number(fingerprint.size);
	if (!(remaining > 0) || !(submitted > 0)) return false;
	// A partial fill still means the order landed — accept anything up to the size sent.
	if (remaining > submitted * 1.0001) return false;
	const price = Number(order.limitPx ?? 0);
	if (!(price > 0)) return false;
	// Marketable limits may rest better than typed; allow a small improvement window.
	const tolerance = Math.max(fingerprint.price * 0.001, fingerprint.price * 0.0005);
	return price <= fingerprint.price * (1 + 0.0001) + tolerance || fingerprint.price <= 0;
}
