export type ChartOrderTif = "Gtc" | "Ioc" | "Alo";
export type ChartOrderMode = ChartOrderTif | "TriggerMarket";

export const TP_SL_MODE_OPTIONS: { value: ChartOrderMode; label: string }[] = [
	{ value: "Alo", label: "Post Only" },
	{ value: "Gtc", label: "GTC" },
	{ value: "TriggerMarket", label: "Trigger Market" },
];

export function orderMode(order: { tif?: string | null; isTrigger?: boolean; orderType?: string }) {
	return order.isTrigger ? (order.orderType?.endsWith("Market") ? "TriggerMarket" : "TriggerLimit") : order.tif;
}

export const CHART_TIF_OPTIONS: { value: ChartOrderTif; label: string }[] = [
	{ value: "Alo", label: "Post Only" },
	{ value: "Gtc", label: "GTC" },
];

/** Missing exchange data is not evidence that an order is GTC. */
export function tifLabel(tif: string | null | undefined, compact = false): string {
	if (tif === "Alo") return compact ? "PO" : "Post Only";
	if (tif === "Gtc") return "GTC";
	if (tif === "Ioc" || tif === "FrontendMarket") return "IOC";
	if (tif === "TriggerMarket") return compact ? "MKT" : "Trigger Market";
	if (tif === "TriggerLimit") return compact ? "TRG" : "Trigger Limit";
	return "Unknown";
}
