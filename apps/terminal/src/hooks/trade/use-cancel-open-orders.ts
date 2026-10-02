import { useCallback } from "react";
import { PAPER_TRADE } from "@/config/paper";
import { playActionSound } from "@/lib/fill-sound";
import { useExchange, useMarkets } from "@/lib/hyperliquid";
import type { OpenOrder } from "@/lib/trade/open-orders";
import { useOrderQueueActions } from "@/stores/use-order-queue-store";
import { usePaperActions } from "@/stores/use-paper-store";

export interface CancelOpenOrdersResult {
	/** Orders the exchange confirmed cancelled (local removals in preview). */
	cancelled: number;
	/** Cancel failures — the SDK throws when any status in the batch errors. */
	errors: string[];
}

export interface CancelOpenOrdersOptions {
	source?: "chase";
	/** Hide Hyperliquid's expected missing-order race when a caller will reconcile it. */
	suppressExpectedMissing?: boolean;
}

/**
 * Cancels resting orders — one path shared by the chart's ✕ buttons, the
 * X/U/I/O/P hotkeys, and the nuke. Preview: local store removal. Live: one exchange
 * cancel batch (per-market asset ids are resolved from the order coins). Failures
 * surface both as an order-queue row and in the returned result so callers that
 * report counts (the nuke dialog) stay truthful.
 */
export function useCancelOpenOrders(): (
	orders: readonly OpenOrder[],
	options?: CancelOpenOrdersOptions,
) => Promise<CancelOpenOrdersResult> {
	const paperActions = usePaperActions();
	const markets = useMarkets();
	const { mutateAsync: cancelExchange } = useExchange("cancel");
	const { addOrder } = useOrderQueueActions();

	return useCallback(
		async (orders: readonly OpenOrder[], options?: CancelOpenOrdersOptions): Promise<CancelOpenOrdersResult> => {
			if (orders.length === 0) return { cancelled: 0, errors: [] };
			if (PAPER_TRADE) {
				paperActions.cancelOrders(orders.map((order) => order.oid));
				return { cancelled: orders.length, errors: [] };
			}
			const cancels = orders.flatMap((order) => {
				const assetId = markets.getAssetId(order.coin);
				return typeof assetId === "number" ? [{ a: assetId, o: order.oid }] : [];
			});
			if (cancels.length === 0) return { cancelled: 0, errors: [] };
			const skipped = orders.length - cancels.length;
			const errors = skipped > 0 ? [`${skipped} order(s) skipped (unknown market)`] : [];
			try {
				// The SDK throws when any status in the batch errors (including benign
				// races like "order already filled") — treat the batch as failed.
				await cancelExchange({ cancels });
				playActionSound();
				return { cancelled: cancels.length, errors };
			} catch (error) {
				const message = error instanceof Error ? error.message : "Failed to cancel order";
				if (options?.suppressExpectedMissing && /order was never placed, already canceled, or filled/i.test(message))
					return { cancelled: 0, errors };
				const first = orders[0];
				addOrder({
					source: options?.source,
					market: first.coin,
					side: first.side === "B" ? "buy" : "sell",
					size: first.sz,
					price: first.limitPx,
					orderType: "limit",
					status: "failed",
					error: message,
					completedAt: Date.now(),
				});
				return { cancelled: 0, errors: [...errors, message] };
			}
		},
		[paperActions, markets, cancelExchange, addOrder],
	);
}
