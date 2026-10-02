import { t } from "@lingui/core/macro";
import { useCallback } from "react";
import { toast } from "sonner";
import type { Hex } from "viem";
import { PAPER_TRADE } from "@/config/paper";
import {
	CHART_TIF_OPTIONS,
	type ChartOrderMode,
	orderMode,
	TP_SL_MODE_OPTIONS,
	tifLabel,
} from "@/domain/trade/order/time-in-force";
import { throwIfAnyResponseError } from "@/domain/trade/orders";
import { useOrderEvidence } from "@/hooks/trade/use-order-evidence";
import {
	assertExchange,
	useHyperliquid,
	useHyperliquidClients,
	useMarkets,
	useTradingSession,
} from "@/lib/hyperliquid";
import type { OpenOrder } from "@/lib/trade/open-orders";
import {
	cancellationEvidence,
	matchingOrderIdentity,
	orderEvidence,
	readCurrentOpenOrder,
} from "@/lib/trade/order-evidence";
import { orderOperationLock } from "@/lib/trade/order-operation-lock";
import { matchesReplacement, replacementRow, sameOrderExecution } from "@/lib/trade/tpsl-conversion";
import { useOrderMoveStore } from "@/stores/use-order-move-store";
import { useOrderQueueActions } from "@/stores/use-order-queue-store";
import { usePaperActions } from "@/stores/use-paper-store";
import { useTifOverrideStore } from "@/stores/use-tif-override-store";
import { findTpSlOrigin, tpSlScope, triggerOrigin, useTpSlOriginStore } from "@/stores/use-tpsl-origin-store";

export {
	CHART_TIF_OPTIONS,
	type ChartOrderMode,
	type ChartOrderTif,
	tifLabel,
} from "@/domain/trade/order/time-in-force";
export function canSwitchOrderTif(order: Pick<OpenOrder, "isTrigger"> & Partial<OpenOrder>): boolean {
	return (
		order.isTrigger !== true || (order.reduceOnly === true && /^(Take Profit|Stop) Market$/.test(order.orderType ?? ""))
	);
}
export interface ReplacementFailure {
	cancellationAttempted: boolean;
	cancellationAcknowledged: boolean;
	cancelled: boolean;
	replacementOid?: number;
	message: string;
}

/** Never retry writes. Stream events and independent live-book reads supplement lagging history. */
export function useReplaceOrderTif(onApplied?: (order: OpenOrder, nextTif: ChartOrderMode) => void) {
	const { info, builderConfig } = useHyperliquid();
	const { trading } = useHyperliquidClients();
	const { address } = useTradingSession();
	const { scope: evidenceScope, updatesReady } = useOrderEvidence();
	const markets = useMarkets();
	const paperActions = usePaperActions();
	const { addOrder } = useOrderQueueActions();
	const overrides = useTifOverrideStore((state) => state.overrides);
	const origins = useTpSlOriginStore((state) => state.origins);
	const originScope = tpSlScope(address);
	const optionsForOrder = useCallback(
		(order: OpenOrder) =>
			triggerOrigin(order, originScope) || findTpSlOrigin(order, originScope, origins)
				? TP_SL_MODE_OPTIONS
				: CHART_TIF_OPTIONS,
		[origins, originScope],
	);
	const effectiveTif = useCallback((order: OpenOrder) => overrides[order.oid] ?? orderMode(order), [overrides]);
	const replaceOrderTif = useCallback(
		async (
			order: OpenOrder,
			nextTif: ChartOrderMode,
			nextPrice = order.isTrigger ? order.triggerPx : order.limitPx,
			onResting?: (row: OpenOrder, confirmed: boolean) => void,
			verifiedSource = false,
			onFailure?: (outcome: ReplacementFailure) => void,
			inheritedLock?: symbol,
		): Promise<boolean> => {
			const repricing = Number(nextPrice) !== Number(order.limitPx);
			const store = useTifOverrideStore.getState();
			const origin = triggerOrigin(order, originScope) ?? findTpSlOrigin(order, originScope);
			const originStore = useTpSlOriginStore.getState();
			if (!Number.isFinite(Number(nextPrice)) || Number(nextPrice) <= 0) return false;
			if (!canSwitchOrderTif(order)) {
				toast.error(t`Only reduce-only TP/SL triggers can become active limits`);
				return false;
			}
			if (store.pending[order.oid]) return false;
			if (nextTif === "TriggerMarket" && !origin) return false;
			if (origin && nextTif === "Ioc") return false;
			if (!repricing && (store.overrides[order.oid] ?? orderMode(order)) === nextTif) return true;
			if (PAPER_TRADE) {
				const lock = orderOperationLock.acquire(originScope, order.oid);
				if (!lock) return false;
				try {
					if (nextTif === "Ioc") {
						toast(t`IOC orders do not rest, so this order stays ${tifLabel(order.tif)}`);
						return false;
					}
					try {
						if (origin) {
							originStore.remember(origin, order);
							const row = paperActions.convertTpSl(order.oid, nextTif, Number(nextPrice), origin);
							originStore.remember(origin, row);
						} else {
							if (repricing) paperActions.repriceOrder(order.oid, Number(nextPrice));
							if (nextTif !== "TriggerMarket") paperActions.setRestingTif([order.oid], nextTif);
						}
					} catch (error) {
						toast.error(error instanceof Error ? error.message : t`Could not change TP/SL`);
						return false;
					}
					store.drop(order.oid);
					onApplied?.(order, nextTif);
					toast.success(t`${order.coin} order is now ${tifLabel(nextTif)}`);
					return true;
				} finally {
					orderOperationLock.release(originScope, order.oid, lock);
				}
			}
			const assetId = markets.getAssetId(order.coin);
			if (typeof assetId !== "number" || !address) {
				const message = !address ? t`No trading account selected` : t`Could not resolve ${order.coin}`;
				store.fail(order.oid, message);
				toast.error(message);
				return false;
			}
			const lock =
				inheritedLock && orderOperationLock.owns(originScope, order.oid, inheritedLock)
					? inheritedLock
					: !inheritedLock
						? orderOperationLock.acquire(originScope, order.oid)
						: undefined;
			if (!lock) return false;
			let replacementOid = order.oid;
			let cancellationAttempted = false;
			let cancellationAcknowledged = false;
			let cancelled = false;
			let restingAcknowledged = false;
			let remainingSize = order.sz;
			const moves = useOrderMoveStore.getState();
			let placeholderStarted = false;
			try {
				if (!repricing && !order.isTrigger && (nextTif === "Gtc" || nextTif === "Alo")) {
					placeholderStarted = moves.begin(order, nextPrice, address, "type");
					if (!placeholderStarted) return false;
				}
				store.setOverride(order.oid, nextTif);
				onApplied?.(order, nextTif);
				const exchange = trading;
				assertExchange(exchange);
				let fresh = order;
				if (!verifiedSource) {
					fresh = await readCurrentOpenOrder(info, address, order.oid, order.coin, evidenceScope);
				}
				if (
					fresh.oid !== order.oid ||
					fresh.coin !== order.coin ||
					fresh.side !== order.side ||
					!sameOrderExecution(fresh, order) ||
					fresh.reduceOnly !== order.reduceOnly ||
					Number(fresh.limitPx) !== Number(order.limitPx)
				)
					throw new Error(t`Order changed since the chart snapshot. Refresh Open Orders before retrying.`);
				if (repricing && !origin && fresh.tif !== nextTif)
					throw new Error(t`Order type changed before repricing. Nothing canceled; refresh Open Orders.`);
				if (!repricing && orderMode(fresh) === nextTif) {
					store.confirm(order.oid, nextTif);
					toast.success(t`${order.coin} order #${order.oid} confirmed ${tifLabel(nextTif)} by exchange`);
					return true;
				}
				if (fresh.children.length > 0)
					throw new Error(t`This limit has attached TP/SL. Reposting could remove them; nothing canceled.`);
				const fullPosition = fresh.isTrigger && origin?.fullPosition === true;
				if (!fullPosition && (!(Number(fresh.sz) > 0) || Number(fresh.sz) > Number(order.sz)))
					throw new Error(t`Order size changed. Refresh Open Orders before retrying.`);
				if (fresh.isTrigger) {
					const rows = await info.frontendOpenOrders(
						{ user: address, dex: fresh.coin.includes(":") ? fresh.coin.split(":")[0] : "" },
						AbortSignal.timeout(2500),
					);
					if (
						rows.some((parent) =>
							parent.children.some(
								(child) => child !== null && typeof child === "object" && "oid" in child && child.oid === fresh.oid,
							),
						)
					)
						throw new Error(t`This TP/SL is attached to an open entry order. Nothing canceled.`);
				}
				const positionSize = async () => {
					const state = await info.clearinghouseState(
						{ user: address, dex: fresh.coin.includes(":") ? fresh.coin.split(":")[0] : "" },
						AbortSignal.timeout(2500),
					);
					const signedSize = Number(state.assetPositions.find((row) => row.position.coin === fresh.coin)?.position.szi);
					if (!Number.isFinite(signedSize) || signedSize === 0 || signedSize > 0 !== (fresh.side === "A"))
						throw new Error(t`Could not verify a position for this TP/SL. No replacement sent.`);
					return Math.abs(signedSize);
				};
				const initialPositionSize = origin?.fullPosition ? await positionSize() : undefined;
				if (origin) originStore.remember(origin, fresh); // Verify persistence before canceling protection.
				// Do not remove an order before the dedicated cancellation-event listener is attached.
				if (!updatesReady())
					throw new Error(
						t`Live order-update stream is not ready. Nothing canceled. Wait for connection before retrying.`,
					);
				if (orderEvidence.terminal(evidenceScope, order.oid))
					throw new Error(t`Order #${order.oid} is no longer open. Nothing canceled.`);
				const cloid = `0x${crypto.randomUUID().replaceAll("-", "")}` as Hex;
				const cancelCursor = orderEvidence.cursor();
				cancellationAttempted = true;
				const cancelResult = await exchange.cancel({ cancels: [{ a: assetId, o: order.oid }] });
				throwIfAnyResponseError(cancelResult.response?.data?.statuses);
				if (cancelResult.response?.data?.statuses[0] !== "success")
					throw new Error(t`Cancellation was not acknowledged. No replacement sent.`);
				cancellationAcknowledged = true;
				const deadline = Date.now() + 15_000;
				let lastStatus = "no matching cancellation update";
				for (const delay of [0, 100, 200, 400, 800, 1500, 2500, 4000, 4000, 2000]) {
					if (delay) await new Promise((r) => setTimeout(r, Math.min(delay, Math.max(0, deadline - Date.now()))));
					if (Date.now() >= deadline) break;
					let outcome = cancellationEvidence(evidenceScope, fresh, cancelCursor);
					if (!outcome) {
						const snapshot = await info
							.orderStatus(
								{ user: address, oid: order.oid },
								AbortSignal.timeout(Math.max(1, Math.min(1500, deadline - Date.now()))),
							)
							.catch((error: unknown) => {
								lastStatus = error instanceof Error ? error.message : "read timeout/error";
								return null;
							});
						if (snapshot) lastStatus = snapshot.status === "order" ? snapshot.order.status : snapshot.status;
						// Check again AFTER the read: a stream event can arrive while history is stale.
						outcome = cancellationEvidence(evidenceScope, fresh, cancelCursor);
						if (
							!outcome &&
							snapshot?.status === "order" &&
							(snapshot.order.status === "canceled" || snapshot.order.status === "filled")
						)
							outcome = { status: snapshot.order.status, order: snapshot.order.order };
					}
					if (!outcome) continue;
					if (
						!matchingOrderIdentity(outcome.order, fresh, fresh.limitPx, fresh.cloid ?? undefined) ||
						!sameOrderExecution(outcome.order, fresh) ||
						outcome.order.children.length > 0
					)
						throw new Error(t`Order changed during cancellation. No replacement sent.`);
					if (outcome.status === "filled") {
						store.drop(order.oid);
						toast(t`${order.coin} order filled during cancellation. Nothing reposted.`);
						return true;
					}
					cancelled = true;
					const final = outcome.order;
					if (
						final.oid !== order.oid ||
						final.coin !== order.coin ||
						final.side !== order.side ||
						!sameOrderExecution(final, fresh) ||
						final.reduceOnly !== order.reduceOnly ||
						Number(final.limitPx) !== Number(order.limitPx)
					)
						throw new Error(t`Order changed during cancellation. No replacement sent.`);
					remainingSize = final.sz;
					break;
				}
				if (!cancelled)
					throw new Error(
						t`Order #${order.oid}: cancellation not confirmed; last exchange status: ${lastStatus}. Check Open Orders.`,
					);
				let fullPositionSize = 0;
				if (origin?.fullPosition) {
					const currentSize = await positionSize();
					fullPositionSize = currentSize;
					if (fullPosition) remainingSize = String(Math.min(initialPositionSize ?? 0, currentSize));
				}
				if (
					!Number.isFinite(Number(remainingSize)) ||
					Number(remainingSize) <= 0 ||
					(!fullPosition && Number(remainingSize) > Number(fresh.sz))
				)
					throw new Error(t`Could not verify the final remaining size. No replacement sent.`);
				const postedSize = nextTif === "TriggerMarket" && origin?.fullPosition ? "0" : remainingSize;
				const targetType =
					nextTif === "TriggerMarket"
						? origin && { trigger: { isMarket: true, triggerPx: nextPrice, tpsl: origin.tpsl } }
						: { limit: { tif: nextTif } };
				if (!targetType) throw new Error(t`Missing original TP/SL details. No replacement sent.`);
				const cloidRow = { ...replacementRow(fresh, nextTif, nextPrice, postedSize, origin), cloid };
				if (origin) originStore.remember(origin, cloidRow); // CLOID also recovers an accepted order after a lost response.
				const placeCursor = orderEvidence.cursor();
				const result = await exchange.order({
					orders: [
						{
							a: assetId,
							b: order.side === "B",
							p: nextPrice,
							s: postedSize,
							r: order.reduceOnly,
							t: targetType,
							c: cloid,
						},
					],
					grouping: nextTif === "TriggerMarket" && origin?.positionTpsl ? "positionTpsl" : "na",
					...(builderConfig ? { builder: builderConfig } : {}),
				});
				const statuses = result.response?.data?.statuses;
				throwIfAnyResponseError(statuses);
				const status = statuses?.[0];
				if (status && typeof status === "object" && "filled" in status) {
					store.drop(order.oid);
					toast.success(
						nextTif === "Ioc"
							? t`${order.coin} IOC filled ${status.filled.totalSz}; any remainder canceled`
							: t`${order.coin} ${tifLabel(nextTif)} replacement filled`,
					);
					return true;
				}
				if (!status || typeof status !== "object" || !("resting" in status))
					throw new Error(t`Exchange did not confirm a resting replacement. Check Open Orders before retrying.`);
				replacementOid = status.resting.oid;
				restingAcknowledged = true;
				const expected = { ...cloidRow, oid: replacementOid };
				if (origin) originStore.remember(origin, expected);
				store.setOverride(replacementOid, nextTif);
				if (placeholderStarted) moves.track(order.oid, expected);
				onResting?.(expected, false);
				const checkTerminal = () => {
					const update = orderEvidence.updateAfter(evidenceScope, replacementOid, placeCursor);
					if (!update || update.status === "open") return false;
					if (!matchingOrderIdentity(update.order, expected, nextPrice, cloid))
						throw new Error(
							t`Replacement #${replacementOid}: order-update identity does not match. Check Open Orders.`,
						);
					if (update.status !== "filled")
						throw new Error(t`Replacement #${replacementOid}: exchange reports ${update.status}. Check Open Orders.`);
					store.drop(order.oid);
					store.drop(replacementOid);
					toast.success(t`${order.coin} replacement order filled`);
					return true;
				};
				const accept = (row: OpenOrder) => {
					if (checkTerminal()) return true;
					if (placeholderStarted) moves.settle(order.oid, row);
					onResting?.(row, true);
					store.confirm(order.oid, nextTif);
					store.confirm(replacementOid, nextTif);
					onApplied?.(order, nextTif);
					toast.success(
						repricing
							? t`${order.coin} order #${replacementOid} repriced to ${nextPrice}, confirmed ${tifLabel(orderMode(row))} by exchange`
							: t`${order.coin} order #${replacementOid} confirmed ${tifLabel(orderMode(row))} by exchange`,
					);
					return true;
				};
				let confirmationError = t`Replacement #${replacementOid} was acknowledged resting, but price/TIF is not verified. Check Open Orders before recreating it.`;
				for (const delay of [0, 400, 1200]) {
					if (delay) await new Promise((r) => setTimeout(r, delay));
					if (checkTerminal()) return true;
					const live = orderEvidence.openFresh(evidenceScope, replacementOid);
					if (matchesReplacement(live, expected, nextTif, postedSize, cloid, fullPositionSize)) return accept(live);
					let snapshot: Awaited<ReturnType<typeof info.orderStatus>> | undefined;
					try {
						snapshot = await info.orderStatus({ user: address, oid: replacementOid }, AbortSignal.timeout(1500));
					} catch (error) {
						confirmationError = t`Replacement #${replacementOid}: ${error instanceof Error ? error.message : "read-back failed"}. Check Open Orders before recreating it.`;
					}
					if (checkTerminal()) return true;
					if (snapshot) {
						if (snapshot.status !== "order")
							confirmationError = t`Replacement #${replacementOid}: orderStatus reports ${snapshot.status}. Check Open Orders before recreating it.`;
						else {
							if (snapshot.order.status !== "open") {
								if (
									snapshot.order.status === "filled" &&
									matchingOrderIdentity(snapshot.order.order, expected, nextPrice, cloid)
								) {
									store.drop(order.oid);
									store.drop(replacementOid);
									toast.success(t`${order.coin} replacement order filled`);
									return true;
								}
								throw new Error(
									t`Order #${replacementOid}: exchange reports ${snapshot.order.status}. Check Open Orders.`,
								);
							}
							if (
								snapshot.order.status === "open" &&
								matchesReplacement(snapshot.order.order, expected, nextTif, postedSize, cloid, fullPositionSize)
							)
								return accept(snapshot.order.order);
							confirmationError =
								snapshot.order.status === "open"
									? repricing
										? t`Order #${replacementOid}: exchange reports ${tifLabel(snapshot.order.order.tif)} at ${snapshot.order.order.limitPx}, expected ${tifLabel(nextTif)} at ${nextPrice}. Reprice not confirmed.`
										: t`Order #${replacementOid}: exchange still reports ${tifLabel(snapshot.order.order.tif)}, not ${tifLabel(nextTif)}. Type change not confirmed.`
									: t`Order #${replacementOid}: exchange reports ${snapshot.order.status}. Check Open Orders.`;
						}
					}
					let row: OpenOrder | undefined;
					try {
						const rows = await info.frontendOpenOrders(
							{ user: address, dex: fresh.coin.includes(":") ? fresh.coin.split(":")[0] : "" },
							AbortSignal.timeout(1500),
						);
						row = rows.find((candidate) => candidate.oid === replacementOid);
					} catch {
						/* Failed independent read is NOT permission to place again. */
					}
					if (checkTerminal()) return true;
					if (matchesReplacement(row, expected, nextTif, postedSize, cloid, fullPositionSize)) return accept(row);
				}
				throw new Error(confirmationError);
			} catch (error) {
				const detail = error instanceof Error ? error.message : t`Could not change the order type`;
				if (cancelled && nextTif === "Ioc" && /Order could not immediately match|iocCancelRejected/i.test(detail)) {
					store.drop(order.oid);
					toast(t`${order.coin} IOC found no immediate match. Original order canceled; nothing rests.`);
					return true;
				}
				const message = restingAcknowledged
					? t`Original order canceled. Replacement #${replacementOid} was accepted resting, but confirmation is incomplete: ${detail} Do not place a duplicate.`
					: cancelled
						? t`Original order canceled. Replacement failed or unconfirmed: ${detail}`
						: cancellationAcknowledged
							? t`Cancellation outcome unconfirmed. No replacement sent: ${detail}`
							: detail;
				store.fail(order.oid, message);
				if (placeholderStarted && cancellationAttempted) moves.fail(order.oid, message);
				if (replacementOid !== order.oid) store.fail(replacementOid, message);
				onFailure?.({
					cancellationAttempted,
					cancellationAcknowledged,
					cancelled,
					replacementOid: restingAcknowledged ? replacementOid : undefined,
					message,
				});
				if (cancellationAcknowledged)
					addOrder({
						market: order.coin,
						side: order.side === "B" ? "buy" : "sell",
						size: remainingSize,
						price: nextPrice,
						orderType: "limit",
						status: "failed",
						error: message,
						completedAt: Date.now(),
					});
				toast.error(message, { duration: 10000 });
				return false;
			} finally {
				if (placeholderStarted && useOrderMoveStore.getState().moves[order.oid]?.pending) moves.drop(order.oid);
				if (!inheritedLock) orderOperationLock.release(originScope, order.oid, lock);
			}
		},
		[
			address,
			addOrder,
			builderConfig,
			info,
			markets,
			onApplied,
			paperActions,
			trading,
			evidenceScope,
			updatesReady,
			originScope,
		],
	);
	return { replaceOrderTif, effectiveTif, optionsForOrder, overrides, evidenceScope, originScope };
}
