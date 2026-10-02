import { t } from "@lingui/core/macro";
import { useCallback, useState } from "react";
import { PAPER_TRADE } from "@/config/paper";
import { formatPriceForOrder, throwIfAnyResponseError } from "@/domain/trade/orders";
import { useCancelOpenOrders } from "@/hooks/trade/use-cancel-open-orders";
import { useReplaceOrderTif } from "@/hooks/trade/use-replace-order-tif";
import { playActionSound } from "@/lib/fill-sound";
import {
	assertExchange,
	useHyperliquid,
	useHyperliquidClients,
	useMarkets,
	useTradingSession,
} from "@/lib/hyperliquid";
import type { OpenOrder } from "@/lib/trade/open-orders";
import { isTakeProfitOrder } from "@/lib/trade/open-orders";
import { readCurrentOpenOrder } from "@/lib/trade/order-evidence";
import { orderOperationLock } from "@/lib/trade/order-operation-lock";
import { useOrderMoveStore } from "@/stores/use-order-move-store";
import { useOrderQueueActions } from "@/stores/use-order-queue-store";
import { usePaperActions } from "@/stores/use-paper-store";
import { useTifOverrideStore } from "@/stores/use-tif-override-store";
import { useTpSlOriginStore } from "@/stores/use-tpsl-origin-store";

export interface OrderLineActions {
	/** Immediate Moving preview; verified Post Only modifies natively, GTC safely replaces. */
	repriceOrder: (order: OpenOrder, rawValue: number) => Promise<boolean>;
	cancelOrder: (order: OpenOrder) => Promise<void>;
	pendingCancels: ReadonlySet<string>;
	isCancelling: (oid: number | string) => boolean;
}

/** Shared by both charts. batchModify does NOT reliably preserve GTC on live limits. */
export function useOrderLineActions(): OrderLineActions {
	const paperActions = usePaperActions();
	const markets = useMarkets();
	const { info } = useHyperliquid();
	const { trading } = useHyperliquidClients();
	const { address } = useTradingSession();
	const { replaceOrderTif, evidenceScope, originScope } = useReplaceOrderTif();
	const cancelOpenOrders = useCancelOpenOrders();
	const { addOrder } = useOrderQueueActions();
	const [pendingCancels, setPendingCancels] = useState<ReadonlySet<string>>(() => new Set());

	const repriceOrder = useCallback(
		async (order: OpenOrder, rawValue: number): Promise<boolean> => {
			const priceText = formatPriceForOrder(rawValue);
			const price = Number(priceText);
			if (!Number.isFinite(price) || price <= 0) return false;
			const current = Number(order.isTrigger ? order.triggerPx : order.limitPx);
			if (!Number.isFinite(current)) return false;
			if (price === current) return true;
			const lock = orderOperationLock.acquire(originScope, order.oid);
			if (!lock) return false;
			if (PAPER_TRADE) {
				try {
					if (price !== current) paperActions.repriceOrder(order.oid, price);
					return true;
				} finally {
					orderOperationLock.release(originScope, order.oid, lock);
				}
			}
			let source = order;
			let resultOid = order.oid;
			let started = false;
			const moves = useOrderMoveStore.getState();
			try {
				if (useTifOverrideStore.getState().pending[order.oid])
					throw new Error(t`Order is changing. Wait before dragging it.`);
				if (!order.isTrigger) {
					if (useTifOverrideStore.getState().pending[order.oid])
						throw new Error(t`Order is changing. Wait before dragging it.`);
					if (moves.isMoving(order.oid)) return false;
					if (!address) throw new Error(t`No trading account selected`);
					started = moves.begin(order, priceText, address);
					if (!started) return false;
					source = await readCurrentOpenOrder(info, address, order.oid, order.coin, evidenceScope);
					if (
						source.oid !== order.oid ||
						source.coin !== order.coin ||
						source.side !== order.side ||
						source.isTrigger ||
						source.reduceOnly !== order.reduceOnly
					)
						throw new Error(t`Order changed since the chart snapshot. Refresh Open Orders before dragging.`);
					if (source.tif !== "Gtc" && source.tif !== "Alo" && source.tif !== "Ioc")
						throw new Error(t`Could not verify the current order type. No price change sent.`);
					if (!Number.isFinite(Number(source.sz)) || Number(source.sz) <= 0)
						throw new Error(t`Could not verify the remaining size. No price change sent.`);
					if (useTifOverrideStore.getState().pending[order.oid])
						throw new Error(t`Order is changing. Wait before dragging it.`);
					if (price === Number(source.limitPx)) {
						useTifOverrideStore.getState().confirm(order.oid, source.tif);
						return true;
					}
					// Native modification is safe for verified Post Only; the observed reset
					// to Alo cannot change its type. GTC MUST use the replacement workflow.
					if (source.tif === "Alo") {
						const exchange = trading;
						assertExchange(exchange);
						const assetId = markets.getAssetId(source.coin);
						if (typeof assetId !== "number") throw new Error(t`Could not resolve ${source.coin}`);
						const result = await exchange.batchModify({
							modifies: [
								{
									oid: source.oid,
									order: {
										a: assetId,
										b: source.side === "B",
										p: priceText,
										s: source.sz,
										r: source.reduceOnly,
										t: { limit: { tif: "Alo" } },
										...(source.cloid ? { c: source.cloid } : {}),
									},
								},
							],
						});
						const statuses = result.response?.data?.statuses;
						throwIfAnyResponseError(statuses);
						const status = statuses?.[0];
						if (status && typeof status === "object" && "filled" in status) {
							playActionSound();
							return true;
						}
						if (!status || typeof status !== "object" || !("resting" in status))
							throw new Error(t`Exchange did not confirm the repriced order. Check Open Orders.`);
						const oid = status.resting.oid;
						useTpSlOriginStore.getState().transfer(originScope, source, { ...source, oid, limitPx: priceText });
						resultOid = oid;
						moves.track(order.oid, { ...source, oid, limitPx: priceText });
						for (const delay of [0, 400, 1200]) {
							if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
							try {
								const readback = await info.orderStatus({ user: address, oid }, AbortSignal.timeout(2500));
								if (readback.status !== "order") continue;
								if (readback.order.status === "filled") {
									playActionSound();
									return true;
								}
								if (
									readback.order.status === "open" &&
									readback.order.order.tif === "Alo" &&
									Number(readback.order.order.limitPx) === price
								) {
									moves.settle(order.oid, readback.order.order);
									useTifOverrideStore.getState().confirm(oid, "Alo");
									playActionSound();
									return true;
								}
							} catch {
								/* Retry verification reads only. */
							}
						}
						throw new Error(t`Could not verify the new price and Post Only type. Check Open Orders.`);
					}
					// Reuse the already-authoritative source instead of reading it twice.
					const applied = await replaceOrderTif(
						source,
						source.tif,
						priceText,
						(row, confirmed) => {
							if (confirmed) moves.settle(order.oid, row);
							else moves.track(order.oid, row);
						},
						true,
						(outcome) => {
							if (outcome.cancellationAttempted) moves.fail(order.oid, outcome.message);
						},
						lock,
					);
					if (applied) playActionSound();
					return applied;
				}

				// Trigger repricing keeps its execution type.
				if (price === current) return true;
				const exchange = trading;
				assertExchange(exchange);
				const assetId = markets.getAssetId(order.coin);
				if (typeof assetId !== "number") throw new Error(t`Could not resolve ${order.coin}`);
				const result = await exchange.batchModify({
					modifies: [
						{
							oid: order.oid,
							order: {
								a: assetId,
								b: order.side === "B",
								p: priceText,
								s: order.sz,
								r: order.reduceOnly,
								t: {
									trigger: {
										isMarket: order.orderType.endsWith("Market"),
										triggerPx: priceText,
										tpsl: isTakeProfitOrder(order) ? "tp" : "sl",
									},
								},
								...(order.cloid ? { c: order.cloid } : {}),
							},
						},
					],
				});
				throwIfAnyResponseError(result.response?.data?.statuses);
				playActionSound();
				return true;
			} catch (error) {
				const message = error instanceof Error ? error.message : t`Failed to reprice order`;
				if (!order.isTrigger && !useTifOverrideStore.getState().pending[order.oid]) {
					useTifOverrideStore.getState().fail(order.oid, message);
					if (resultOid !== order.oid) useTifOverrideStore.getState().fail(resultOid, message);
				}
				addOrder({
					market: source.coin,
					side: source.side === "B" ? "buy" : "sell",
					size: source.sz,
					price: priceText,
					orderType: source.isTrigger ? "trigger" : "limit",
					status: "failed",
					error: message,
					completedAt: Date.now(),
				});
				return false;
			} finally {
				orderOperationLock.release(originScope, order.oid, lock);
				if (started && useOrderMoveStore.getState().moves[order.oid]?.pending) moves.drop(order.oid);
			}
		},
		[address, paperActions, markets, trading, info, addOrder, replaceOrderTif, evidenceScope, originScope],
	);

	const cancelOrder = useCallback(
		async (order: OpenOrder): Promise<void> => {
			if (useTifOverrideStore.getState().pending[order.oid]) return;
			if (useOrderMoveStore.getState().isMoving(order.oid)) return;
			const lock = orderOperationLock.acquire(originScope, order.oid);
			if (!lock) return;
			const key = String(order.oid);
			setPendingCancels((prev) => new Set([...prev, key]));
			try {
				await cancelOpenOrders([order]);
			} finally {
				orderOperationLock.release(originScope, order.oid, lock);
				setPendingCancels((prev) => {
					const next = new Set(prev);
					next.delete(key);
					return next;
				});
			}
		},
		[cancelOpenOrders, originScope],
	);
	const isCancelling = useCallback((oid: number | string) => pendingCancels.has(String(oid)), [pendingCancels]);
	if (import.meta.env.DEV)
		(globalThis as { __hlPendingCancels?: ReadonlySet<string> }).__hlPendingCancels = pendingCancels;
	return { repriceOrder, cancelOrder, pendingCancels, isCancelling };
}
