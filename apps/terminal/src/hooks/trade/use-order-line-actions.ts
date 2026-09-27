import { useCallback, useState } from "react";
import { PAPER_TRADE } from "@/config/paper";
import type { ExchangeOrder } from "@/config/trade";
import { formatPriceForOrder, throwIfResponseError } from "@/domain/trade/orders";
import { useCancelOpenOrders } from "@/hooks/trade/use-cancel-open-orders";
import { playActionSound } from "@/lib/fill-sound";
import { useExchange, useMarkets } from "@/lib/hyperliquid";
import type { OpenOrder } from "@/lib/trade/open-orders";
import { isTakeProfitOrder } from "@/lib/trade/open-orders";
import { useOrderQueueActions } from "@/stores/use-order-queue-store";
import { usePaperActions } from "@/stores/use-paper-store";

type LimitTifForModify = "Gtc" | "Ioc" | "Alo" | "FrontendMarket";

function toLimitTif(tif: OpenOrder["tif"]): LimitTifForModify {
	if (tif && tif !== "LiquidationMarket") return tif;
	return "Gtc";
}

export interface OrderLineActions {
	/** Drag release on an order line: reprices it (preview: local; live: batchModify). Resolves true on success. */
	repriceOrder: (order: OpenOrder, rawValue: number) => Promise<boolean>;
	/** The ✕ box: cancel (shared with the hotkeys' cancel-all path). */
	cancelOrder: (order: OpenOrder) => Promise<void>;
	/**
	 * Oids with a cancel in flight. The exchange round-trip takes ~a second, so the
	 * row shows a spinner immediately instead of looking unresponsive.
	 */
	pendingCancels: ReadonlySet<string>;
	isCancelling: (oid: number | string) => boolean;
}

/**
 * Order-line actions shared by BOTH canvas variants: chart drags, ✕ clicks, and
 * failure rows in the order queue behave identically whether the chart is
 * klinecharts or the TradingView widget.
 */
export function useOrderLineActions(): OrderLineActions {
	const paperActions = usePaperActions();
	const markets = useMarkets();
	const { mutateAsync: batchModify } = useExchange("batchModify");
	const cancelOpenOrders = useCancelOpenOrders();
	const { addOrder } = useOrderQueueActions();
	const [pendingCancels, setPendingCancels] = useState<ReadonlySet<string>>(() => new Set());

	const repriceOrder = useCallback(
		async (order: OpenOrder, rawValue: number): Promise<boolean> => {
			const price = Number(formatPriceForOrder(rawValue));
			if (!Number.isFinite(price) || price <= 0) return false;
			const current = Number(order.isTrigger ? order.triggerPx : order.limitPx);
			if (!Number.isFinite(current) || price === current) return true;

			if (PAPER_TRADE) {
				paperActions.repriceOrder(order.oid, price);
				return true;
			}

			const assetId = markets.getAssetId(order.coin);
			if (typeof assetId !== "number") return false;

			const priceText = formatPriceForOrder(price);
			const orderType: ExchangeOrder["t"] = order.isTrigger
				? {
						trigger: {
							isMarket: order.orderType.endsWith("Market"),
							triggerPx: priceText,
							tpsl: isTakeProfitOrder(order) ? ("tp" as const) : ("sl" as const),
						},
					}
				: { limit: { tif: toLimitTif(order.tif) } };

			try {
				const result = await batchModify({
					modifies: [
						{
							oid: order.oid,
							order: {
								a: assetId,
								b: order.side === "B",
								p: priceText,
								s: order.sz,
								r: order.reduceOnly,
								t: orderType,
								...(order.cloid ? { c: order.cloid } : {}),
							},
						},
					],
				});
				throwIfResponseError(result.response?.data?.statuses);
				// Confirms the move right away; the row follows on the next tick.
				playActionSound();
				return true;
			} catch (error) {
				addOrder({
					market: order.coin,
					side: order.side === "B" ? "buy" : "sell",
					size: order.sz,
					price: priceText,
					orderType: "limit",
					status: "failed",
					error: error instanceof Error ? error.message : "Failed to reprice order",
					completedAt: Date.now(),
				});
				return false;
			}
		},
		[paperActions, markets, batchModify, addOrder],
	);

	const cancelOrder = useCallback(
		async (order: OpenOrder): Promise<void> => {
			const key = String(order.oid);
			// Optimistic: the chart row reflects the press on the same frame. If the
			// exchange refuses, the row comes back with the failure queued.
			setPendingCancels((prev) => {
				const next = new Set(prev);
				next.add(key);
				return next;
			});
			try {
				await cancelOpenOrders([order]);
			} finally {
				setPendingCancels((prev) => {
					const next = new Set(prev);
					next.delete(key);
					return next;
				});
			}
		},
		[cancelOpenOrders],
	);

	const isCancelling = useCallback((oid: number | string) => pendingCancels.has(String(oid)), [pendingCancels]);
	if (import.meta.env.DEV) {
		(globalThis as { __hlPendingCancels?: ReadonlySet<string> }).__hlPendingCancels = pendingCancels;
	}

	return { repriceOrder, cancelOrder, pendingCancels, isCancelling };
}
