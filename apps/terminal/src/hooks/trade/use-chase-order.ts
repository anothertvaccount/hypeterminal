import { ApiRequestError } from "@nktkas/hyperliquid";
import { useEffect, useRef } from "react";
import { HL_ALL_DEXS } from "@/config/app";
import { PAPER_TRADE } from "@/config/paper";
import type { ChaseEntry } from "@/domain/trade/order/chase";
import {
	CHASE_MODIFY_INTERVAL_MS,
	CHASE_TIMEOUT_MS,
	CHASE_TRACK_GRACE_MS,
	chaseBehindMarkPrice,
	chaseBookTouch,
	findActiveChaseOrder,
	isChaseOrderGoneError,
	isPostOnlyRaceError,
	nextCloseChaseAction,
	resolveChaseOutcome,
	shouldCancelChase,
	shouldWaitForOrderSnapshot,
} from "@/domain/trade/order/chase";
import { getExecutedPrice } from "@/domain/trade/order/price";
import { formatPriceForOrder, formatSizeForOrder, throwIfAnyResponseError } from "@/domain/trade/orders";
import { useCancelOpenOrders } from "@/hooks/trade/use-cancel-open-orders";
import { useChaseBook } from "@/hooks/trade/use-chase-book";
import { useSubmitPlan } from "@/hooks/trade/use-submit-plan";
import {
	getInfoClient,
	useExchange,
	useMarkets,
	useSubscription,
	useTradingSession,
	useUserPositions,
} from "@/lib/hyperliquid";
import type { OpenOrder } from "@/lib/trade/open-orders";
import { orderEvidenceScope } from "@/lib/trade/order-evidence";
import { orderOperationLock } from "@/lib/trade/order-operation-lock";
import { useChaseOrderStore } from "@/stores/use-chase-order-store";
import { useMarketOrderSlippageBps } from "@/stores/use-global-settings-store";
import { useOrderQueueActions } from "@/stores/use-order-queue-store";
import { usePaperActions, usePaperOpenOrderRows, usePaperTradingStore } from "@/stores/use-paper-store";

interface BookLevel {
	px?: string;
}

/**
 * The chase engine: while a chase limit is active it re-prices the resting order to
 * the top of the real book (both preview and live — the book is public either way)
 * every CHASE_MODIFY_INTERVAL_MS and retires the entry when the order disappears
 * (i.e. it filled — the fill chime already fired). Entry chases cancel after
 * CHASE_TIMEOUT_MS; CLOSE chases (mode "close", derived from reduceOnly) never time
 * out — they ride the touch until the position is flat. A representable sub-$10 tail
 * is closed with a reduce-only market order after its resting limit is verified gone.
 * A remainder below the market's size step is reported because it cannot be encoded.
 * The first re-price runs immediately to shrink the window before the book is known.
 */
export function useChaseOrderEngine(): void {
	const { address, isActive } = useTradingSession();
	const sessionRef = useRef({ address, isActive });
	sessionRef.current = { address, isActive };
	const markets = useMarkets();
	// `positionsLoaded` matters: a lookup that returns null because the snapshot is
	// still in flight is NOT the same as a flat position, and treating it as flat
	// cancelled a live close chase and retired it as "completed".
	const { getPosition, isLoading: positionsLoading, hasError: positionsError } = useUserPositions();
	// useSubmitPlan returns a FRESH closure every render, and the position
	// accessors are bound per render. Listing either in this effect's deps re-ran
	// the effect on every render — and its cleanup cancels the resting order, so a
	// cancel/re-post storm ended in React's "maximum update depth" crash. Keep them
	// in refs instead (like the order/book/entry refs) so the tick always reads the
	// latest values while the effect stays stable.
	const getPositionRef = useRef(getPosition);
	getPositionRef.current = getPosition;
	const positionsLoadingRef = useRef(positionsLoading);
	positionsLoadingRef.current = positionsLoading || positionsError;
	const cancelOpenOrders = useCancelOpenOrders();
	const cancelOpenOrdersRef = useRef(cancelOpenOrders);
	cancelOpenOrdersRef.current = cancelOpenOrders;
	const marketsRef = useRef(markets);
	marketsRef.current = markets;
	const { addOrder } = useOrderQueueActions();
	const { mutateAsync: batchModify } = useExchange("batchModify");
	const { mutateAsync: placeOrder } = useExchange("order");
	const marketSlippageBps = useMarketOrderSlippageBps();
	const marketSlippageBpsRef = useRef(marketSlippageBps);
	marketSlippageBpsRef.current = marketSlippageBps;
	const { submitPlan } = useSubmitPlan();
	const submitPlanRef = useRef(submitPlan);
	submitPlanRef.current = submitPlan;
	const entry = useChaseOrderStore((state) => state.entry);
	const entryOwnerRef = useRef({ entry, address });
	if (entryOwnerRef.current.entry !== entry) entryOwnerRef.current = { entry, address };
	const paperRows = usePaperOpenOrderRows();
	const paperActions = usePaperActions();

	const { data: openOrdersEvent } = useSubscription(
		"openOrders",
		{ user: address ?? "0x0", dex: HL_ALL_DEXS },
		{ enabled: !PAPER_TRADE && isActive },
	);
	const bookEvent = useChaseBook(entry?.coin);
	const { data: midsEvent } = useSubscription("allMids", { dex: HL_ALL_DEXS }, { enabled: entry !== null });

	const ordersRef = useRef<OpenOrder[]>([]);
	ordersRef.current = PAPER_TRADE ? paperRows : (openOrdersEvent?.orders ?? []);
	const entryRef = useRef(entry);
	entryRef.current = entry;
	const bookRef = useRef(bookEvent);
	bookRef.current = bookEvent;
	const markRef = useRef<number | undefined>(undefined);
	const rawMark = entry !== null ? midsEvent?.mids?.[entry.coin] : undefined;
	const parsedMark = rawMark !== undefined ? Number(rawMark) : Number.NaN;
	markRef.current = Number.isFinite(parsedMark) && parsedMark > 0 ? parsedMark : undefined;
	/** Last seen resting order — oid + price feed the history record. */
	const lastOrderRef = useRef<{ oid: number; price: string } | null>(null);
	/** True once this entry recorded its own outcome (timeout/fill/cancel). */
	const retiredRef = useRef(false);
	/** One queue row per chase for re-price failures — retries stay silent. */
	const modifyErrorLoggedRef = useRef(false);
	useEffect(() => {
		lastOrderRef.current = null;
		retiredRef.current = false;
		modifyErrorLoggedRef.current = false;
		if (!entry) return;
		let disposed = false;
		let pending: Promise<void> | undefined;
		let trackedOid = entry.oid;
		let neverPlaced = entry.placementPending === true && entry.mode === "close";
		let trackedCloid: string | undefined = entry.cloid;
		let trackedTif = entry.tif ?? "Alo";
		let acknowledgedOrder: OpenOrder | undefined;
		let knownOrder: OpenOrder | undefined;
		let acknowledgedAt = 0;
		let pendingCloid: `0x${string}` | undefined;
		let nextDustCloseAttemptAt = 0;
		const endedOids = new Set<number>();
		const isCurrent = () =>
			!disposed &&
			useChaseOrderStore.getState().entry === entry &&
			(PAPER_TRADE ||
				(sessionRef.current.isActive &&
					sessionRef.current.address === address &&
					entryOwnerRef.current.address === address));
		const remember = (order: OpenOrder, acknowledged = false) => {
			neverPlaced = false;
			knownOrder = order;
			trackedOid = order.oid;
			if (order.cloid) trackedCloid = order.cloid;
			if (order.tif === "Alo" || order.tif === "Gtc") trackedTif = order.tif;
			lastOrderRef.current = { oid: order.oid, price: order.limitPx };
			acknowledgedOrder = acknowledged ? order : undefined;
			acknowledgedAt = Date.now();
		};
		const recoveryOrder = (rows: OpenOrder[]) =>
			rows.find(
				(row) =>
					!endedOids.has(row.oid) &&
					row.coin === entry.coin &&
					row.side === (entry.side === "buy" ? "B" : "A") &&
					row.reduceOnly &&
					!row.isTrigger &&
					(row.oid === trackedOid || (!!trackedCloid && row.cloid === trackedCloid)),
			);
		const logFailure = (message: string, size = entry.sizeText, price = lastOrderRef.current?.price) => {
			if (!isCurrent() || modifyErrorLoggedRef.current) return;
			modifyErrorLoggedRef.current = true;
			addOrder({
				source: "chase",
				market: entry.coin,
				side: entry.side,
				size,
				price,
				orderType: "limit",
				status: "failed",
				error: message,
				completedAt: Date.now(),
			});
		};

		const timeoutMs =
			(import.meta.env.DEV ? (globalThis as { __chaseTimeoutMs?: number }).__chaseTimeoutMs : undefined) ??
			CHASE_TIMEOUT_MS;

		/**
		 * How much a close chase still has to place. `null` = not known yet (the
		 * positions snapshot is still in flight), which must never be read as flat.
		 */
		/** Adapt the position read to the decision helper's shape. */
		function toDecisionInput(
			remaining: { size: string; szi: number } | null,
		): { szi: number; closeable: string } | null {
			return remaining === null ? null : { szi: remaining.szi, closeable: remaining.size };
		}

		function remainingToClose(entry: ChaseEntry): { size: string; szi: number } | null {
			if (positionsLoadingRef.current) return null;
			const short = entry.coin.includes(":") ? entry.coin.slice(entry.coin.indexOf(":") + 1) : entry.coin;
			const pos = getPositionRef.current(entry.coin, entry.dex) ?? getPositionRef.current(short, entry.dex);
			if (!pos) return { size: "0", szi: 0 };
			const szi = Number(pos.szi);
			if (!Number.isFinite(szi) || szi === 0) return { size: "0", szi: 0 };
			return { size: formatSizeForOrder(Math.abs(szi), marketsRef.current.getSzDecimals(entry.coin)), szi };
		}

		function finishClose(
			current: ChaseEntry,
			remaining: { size: string; szi: number },
			unrepresentable: boolean,
			price: string,
		) {
			useChaseOrderStore.getState().actions.pushHistory({
				coin: current.coin,
				side: current.side,
				size: current.sizeText,
				reduceOnly: true,
				startedAt: current.startedAt,
				endedAt: Date.now(),
				outcome: unrepresentable ? "error" : "completed",
				price,
			});
			if (unrepresentable)
				logFailure(
					`${Math.abs(remaining.szi)} ${current.coin} remains — below this market's size precision, so it cannot be submitted as an order`,
					remaining.size,
					price,
				);
			lastOrderRef.current = null;
			retiredRef.current = true;
			useChaseOrderStore.getState().actions.clear();
		}

		async function recoverClose(current: ChaseEntry, restingDustOrder?: OpenOrder): Promise<void> {
			if (!PAPER_TRADE && (!address || !isActive)) return;
			const info = getInfoClient();
			const scope = orderEvidenceScope(info, address ?? "paper");
			const lockedOid = trackedOid;
			const token = lockedOid === undefined ? undefined : orderOperationLock.acquire(scope, lockedOid);
			if (lockedOid !== undefined && !token) return;
			let submitted = false;
			let definiteRejection = false;
			let dustMarketAttempt = false;
			try {
				if (restingDustOrder) {
					if (PAPER_TRADE) {
						paperActions.cancelOrders([restingDustOrder.oid]);
					} else {
						if (!address) return;
						const before = await info.orderStatus(
							{ user: address, oid: restingDustOrder.oid },
							AbortSignal.timeout(1500),
						);
						if (!isCurrent() || before.status !== "order") return;
						if (before.order.status === "open") {
							const result = await cancelOpenOrdersRef.current([restingDustOrder], {
								source: "chase",
								suppressExpectedMissing: true,
							});
							if (!isCurrent() || result.errors.length > 0) {
								if (result.errors.length > 0) logFailure(result.errors.join("; "));
								return;
							}
							const after = await info.orderStatus(
								{ user: address, oid: restingDustOrder.oid },
								AbortSignal.timeout(1500),
							);
							if (!isCurrent() || after.status !== "order" || after.order.status === "open") return;
						}
					}
					endedOids.add(restingDustOrder.oid);
				}
				let remaining: { size: string; szi: number } | null;
				if (PAPER_TRADE) {
					if (!neverPlaced && (trackedOid === undefined || !usePaperTradingStore.getState().outcomeByOid[trackedOid]))
						return;
					remaining = remainingToClose(current);
				} else {
					if (!address) return;
					// A lost placement response must be reconciled by its CLOID, never retried blindly.
					if (pendingCloid) {
						const status = await info.orderStatus({ user: address, oid: pendingCloid }, AbortSignal.timeout(1500));
						if (!isCurrent() || status.status !== "order") return;
						pendingCloid = undefined;
						trackedOid = status.order.order.oid;
						if (status.order.status === "open") {
							remember(status.order.order, true);
							return;
						}
						endedOids.add(trackedOid);
					}
					const dex = current.dex ?? (current.coin.includes(":") ? current.coin.split(":")[0] : "");
					const rows = await info.frontendOpenOrders({ user: address, dex }, AbortSignal.timeout(1500));
					if (!isCurrent()) return;
					const existing = recoveryOrder(rows);
					if (existing) {
						remember(existing, true);
						return;
					}
					// Older entries without a CLOID cannot identify a lost modify ACK.
					// Wait rather than take over another reduce-only order or duplicate it.
					if (
						!neverPlaced &&
						!trackedCloid &&
						findActiveChaseOrder(
							rows.filter((row) => !endedOids.has(row.oid)),
							current,
						)
					)
						return;
					if (trackedOid === undefined && !neverPlaced) return; // Unknown submissions need identity proof.
					if (trackedOid !== undefined) {
						const status = await info.orderStatus({ user: address, oid: trackedOid }, AbortSignal.timeout(1500));
						if (!isCurrent() || (status.status !== "order" && !endedOids.has(trackedOid))) return;
						if (status.status === "order" && status.order.status === "open" && !endedOids.has(trackedOid)) {
							remember(status.order.order, true);
							return;
						}
						endedOids.add(trackedOid);
					}
					// Terminal order proof precedes the fresh position read, so partial fills
					// cannot cause the original full size to be posted again.
					const state = await info.clearinghouseState({ user: address, dex }, AbortSignal.timeout(1500));
					const short = current.coin.split(":").at(-1);
					const position = state.assetPositions.find(
						({ position }) => position.coin === current.coin || position.coin === short,
					)?.position;
					const szi = Number(position?.szi ?? "0");
					if (!Number.isFinite(szi)) return;
					remaining = { szi, size: formatSizeForOrder(Math.abs(szi), marketsRef.current.getSzDecimals(current.coin)) };
					// Recheck for a replacement that arrived while the order/position reads ran.
					const fresh = await info.frontendOpenOrders({ user: address, dex }, AbortSignal.timeout(1500));
					if (!isCurrent()) return;
					const replacement = recoveryOrder(fresh);
					if (replacement) {
						remember(replacement, true);
						return;
					}
					if (
						!neverPlaced &&
						!trackedCloid &&
						findActiveChaseOrder(
							fresh.filter((row) => !endedOids.has(row.oid)),
							current,
						)
					)
						return;
				}
				if (!isCurrent() || remaining === null || positionsLoadingRef.current) return;
				const touch =
					chaseBookTouch(current.side, bookRef.current?.levels) ??
					(PAPER_TRADE && markRef.current !== undefined
						? chaseBehindMarkPrice(current.side, markRef.current, marketsRef.current.getSzDecimals(current.coin))
						: null);
				const priceReference = markRef.current ?? touch;
				if (priceReference === null || priceReference === undefined) return;
				if (remaining.szi !== 0 && remaining.szi > 0 !== (current.side === "sell")) {
					logFailure("Position changed side — Chase Close stopped");
					retiredRef.current = true;
					useChaseOrderStore.getState().actions.clear();
					return;
				}
				const action = nextCloseChaseAction({
					remaining: toDecisionInput(remaining),
					markPx: priceReference,
				});
				if (action === "completed") {
					finishClose(current, remaining, false, String(priceReference));
					return;
				}
				if (action !== "replace" && action !== "dust") return;
				if (action === "replace" && touch === null) return;
				if (action === "dust" && Number(remaining.size) <= 0) {
					finishClose(current, remaining, true, String(priceReference));
					return;
				}
				if (action === "dust" && Date.now() < nextDustCloseAttemptAt) return;
				const assetId = marketsRef.current.getAssetId(current.coin);
				if (typeof assetId !== "number") return;
				const cloid = `0x${crypto.randomUUID().replaceAll("-", "")}` as const;
				dustMarketAttempt = action === "dust";
				const price =
					action === "dust"
						? formatPriceForOrder(
								getExecutedPrice("market", current.side, priceReference, marketSlippageBpsRef.current, priceReference),
							)
						: String(touch);
				const order = {
					a: assetId,
					b: current.side === "buy",
					p: String(price),
					s: remaining.size,
					r: true,
					t: { limit: { tif: dustMarketAttempt ? ("FrontendMarket" as const) : trackedTif } },
					c: cloid,
				};
				pendingCloid = cloid;
				const initialPlacement = neverPlaced;
				neverPlaced = false;
				submitted = true;
				let oid: number | undefined;
				let resting = false;
				if (PAPER_TRADE) {
					const result = await submitPlanRef.current(
						{ orders: [order], grouping: "na" },
						{ coin: current.coin, dex: current.dex },
					);
					if (!result.ok) {
						definiteRejection = true;
						throw new Error(result.error);
					}
					oid = result.oid;
					resting = result.outcome === "resting";
				} else {
					const result = await placeOrder({ orders: [order], grouping: "na" });
					const statuses = result.response?.data?.statuses;
					definiteRejection = !!statuses?.some((status) => typeof status === "object" && "error" in status);
					throwIfAnyResponseError(statuses);
					const primary = statuses?.[0];
					if (!primary) throw new Error("No response from exchange");
					if (typeof primary === "object") {
						resting = "resting" in primary;
						oid = "resting" in primary ? primary.resting.oid : "filled" in primary ? primary.filled.oid : undefined;
					}
				}
				if (dustMarketAttempt) nextDustCloseAttemptAt = Date.now() + 5_000;
				if (initialPlacement && (oid !== undefined || PAPER_TRADE) && isCurrent()) {
					addOrder({
						source: "chase",
						market: current.coin,
						side: current.side,
						size: order.s,
						price: order.p,
						orderType: dustMarketAttempt ? "market" : "limit",
						status: "success",
						outcome: resting ? "resting" : "filled",
						completedAt: Date.now(),
					});
				}
				if (oid !== undefined || PAPER_TRADE) pendingCloid = undefined;
				if (oid !== undefined) {
					if (resting) {
						remember(
							{
								coin: current.coin,
								side: order.b ? "B" : "A",
								oid,
								limitPx: order.p,
								sz: order.s,
								origSz: order.s,
								timestamp: Date.now(),
								reduceOnly: true,
								isTrigger: false,
								triggerPx: "0",
								triggerCondition: "",
								children: [],
								isPositionTpsl: false,
								orderType: "Limit",
								tif: trackedTif,
								cloid,
							},
							true,
						);
					} else {
						trackedOid = oid;
						endedOids.add(oid);
						acknowledgedOrder = undefined;
					}
				}
			} catch (error) {
				if (!submitted) return; // Unavailable reads pause recovery; they never justify a new write.
				const message = error instanceof Error ? error.message : "Chase close recovery failed";
				if (dustMarketAttempt) nextDustCloseAttemptAt = Date.now() + 5_000;
				if (definiteRejection || error instanceof ApiRequestError || isPostOnlyRaceError(message)) {
					pendingCloid = undefined;
					if (trackedOid === undefined) neverPlaced = true;
				}
				if (!isPostOnlyRaceError(message)) logFailure(message);
			} finally {
				if (token && lockedOid !== undefined) orderOperationLock.release(scope, lockedOid, token);
			}
		}

		const tick = () => {
			const current = entryRef.current;
			if (!current || !isCurrent() || pending) return;
			// Captured before the close branch narrows it, so the timeout guard below can
			// still read the mode as a plain value.
			const chaseMode: ChaseEntry["mode"] = current.mode;
			// A close chase's entry size is the ORIGINAL size, so once the order is
			// partially filled its remaining size no longer matches exactly — match on
			// coin/side/reduce-only instead, or the chase would re-post on top of its own
			// resting order.
			const rows = ordersRef.current.filter((order) => !endedOids.has(order.oid));
			const snapshotOrder =
				neverPlaced || (pendingCloid && trackedOid === undefined)
					? undefined
					: trackedOid === undefined
						? findActiveChaseOrder(rows, current)
						: rows.find((order) => order.oid === trackedOid);
			const order =
				snapshotOrder ?? (Date.now() - acknowledgedAt < CHASE_TRACK_GRACE_MS ? acknowledgedOrder : undefined);
			if (snapshotOrder) remember(snapshotOrder);
			if (!order) {
				// A close chase's job is to get the position flat. If its order is not on
				// the book, the only honest options are "flat" or "re-post" — retiring as
				// completed/cancelled here is what stopped the phone chase ~40s in.
				if (current.mode === "close") {
					// A close chase keeps riding while its order rests, and only finishes on
					// a KNOWN position. Snapshot absence starts reconciliation, not a blind repost.
					if (
						!current.placementPending &&
						lastOrderRef.current === null &&
						shouldWaitForOrderSnapshot(current.startedAt, Date.now())
					) {
						return;
					}
					const action = nextCloseChaseAction({
						remaining: toDecisionInput(remainingToClose(current)),
						markPx: markRef.current ?? Number.NaN,
					});
					if (action === "wait") return;
					if (action === "replace" || action === "dust") {
						pending = recoverClose(current).finally(() => {
							pending = undefined;
						});
						return;
					}
					const remaining = remainingToClose(current);
					if (remaining)
						finishClose(current, remaining, false, lastOrderRef.current?.price ?? String(markRef.current ?? 0));
					return;
				}
				const cached = lastOrderRef.current;
				if (cached === null) {
					// Never spotted the resting order yet: live openOrders snapshots only
					// arrive after the placement ACK (the first tick races them; preview is
					// synchronous), so keep the chase — and its timer bar — alive while the
					// snapshot is in flight instead of retiring it as "completed" at t=0.
					if (shouldWaitForOrderSnapshot(current.startedAt, Date.now())) return;
					// Grace expired: the placement was ACKed but the order never showed up
					// in a snapshot. No oid was ever known, so it cannot be cancelled from
					// here — surface an actionable failure instead of a false "completed".
					if (import.meta.env.DEV) {
						console.warn("[chase] tracking grace expired without a snapshot", {
							coin: current.coin,
							wanted: { side: current.side, size: current.sizeText, reduceOnly: current.reduceOnly },
							seen: ordersRef.current
								.filter((o) => o.coin === current.coin)
								.map((o) => ({ side: o.side, origSz: o.origSz, reduceOnly: o.reduceOnly })),
						});
					}
					addOrder({
						source: "chase",
						market: current.coin,
						side: current.side,
						size: current.sizeText,
						price: markRef.current !== undefined ? formatPriceForOrder(markRef.current) : undefined,
						orderType: "limit",
						status: "failed",
						error:
							"Chase could not track its resting order — check Open Orders and cancel it there if it is still resting",
						completedAt: Date.now(),
					});
					useChaseOrderStore.getState().actions.pushHistory({
						coin: current.coin,
						side: current.side,
						size: current.sizeText,
						reduceOnly: current.reduceOnly,
						startedAt: current.startedAt,
						endedAt: Date.now(),
						outcome: "error",
					});
					lastOrderRef.current = null;
					retiredRef.current = true;
					useChaseOrderStore.getState().actions.clear();
					return;
				}
				// Had seen it and it's gone from a fresh snapshot = it filled (the fill
				// chime already played; preview records the exact outcome by oid, live
				// can only report neutral "completed").
				const outcome = PAPER_TRADE
					? resolveChaseOutcome(usePaperTradingStore.getState().outcomeByOid, cached.oid)
					: "completed";
				useChaseOrderStore.getState().actions.pushHistory({
					coin: current.coin,
					side: current.side,
					size: current.sizeText,
					reduceOnly: current.reduceOnly,
					startedAt: current.startedAt,
					endedAt: Date.now(),
					outcome,
					price: cached.price,
				});
				lastOrderRef.current = null;
				retiredRef.current = true;
				useChaseOrderStore.getState().actions.clear();
				return;
			}
			lastOrderRef.current = { oid: order.oid, price: order.limitPx };
			const now = Date.now();
			if (current.mode === "close") {
				// Close chases run until the position is flat. A representable sub-$10
				// remainder is canceled and closed with a reduce-only market order.
				// A missing position row while the snapshot is still in flight is NOT flat:
				// treating it as flat cancelled a live close and retired it as completed.
				const remaining = remainingToClose(current);
				const action = nextCloseChaseAction({
					remaining: toDecisionInput(remaining),
					markPx: markRef.current ?? Number.NaN,
				});
				if (action === "wait") return;
				if (action === "completed") {
					if (remaining) finishClose(current, remaining, false, order.limitPx);
					return;
				}
				// A maker order can be partially filled below the minimum notional for a
				// replacement. Cancel the resting tail, verify that it is gone, then use
				// the market-close path instead of leaving a stale order behind.
				if (action === "dust") {
					pending = recoverClose(current, order).finally(() => {
						pending = undefined;
					});
					return;
				}
			}
			// Entry chases time out; close chases keep riding the touch (no cancel).
			if (chaseMode !== "close" && shouldCancelChase(current.startedAt, now, timeoutMs)) {
				useChaseOrderStore.getState().actions.pushHistory({
					coin: current.coin,
					side: current.side,
					size: current.sizeText,
					reduceOnly: current.reduceOnly,
					startedAt: current.startedAt,
					endedAt: now,
					outcome: "timeout",
					price: order.limitPx,
				});
				lastOrderRef.current = null;
				// Cancelling happens in the effect cleanup so an orphan is never left
				// on the book — this entry is retired either way.
				retiredRef.current = true;
				useChaseOrderStore.getState().actions.clear();
				return;
			}
			// The interval sets the cadence. A second wall-clock throttle can skip a
			// slightly early callback and turn a 750 ms chase into a 1,500 ms chase.

			// Preserve the placement's tif (post-only chases stay post-only — maker
			// fees); anything unexpected falls back to GTC so a re-price can never
			// reject-cross unexpectedly.
			const tif =
				order.tif === "Alo" || order.tif === "Gtc" || order.tif === "Ioc" || order.tif === "FrontendMarket"
					? order.tif
					: "Gtc";
			// Target: the real top of book. A post-only re-price MUST come from the
			// book — the mark fallback could cross the opposite side and get rejected
			// (mark − tick sits above the live ask whenever the local book lags) — so
			// wait for the snapshot instead.
			const levels = bookRef.current?.levels;
			const topLevels = current.side === "buy" ? levels?.[0] : levels?.[1];
			const best = Array.isArray(topLevels) ? (topLevels[0] as BookLevel | undefined) : undefined;
			const bestPx = Number(best?.px);
			let target: string | null = null;
			if (best?.px && Number.isFinite(bestPx) && bestPx > 0) {
				target = String(best.px);
			} else if (tif === "Alo") {
				return;
			} else {
				const mark = markRef.current;
				if (mark !== undefined) {
					target = formatPriceForOrder(
						chaseBehindMarkPrice(current.side, mark, marketsRef.current.getSzDecimals(current.coin)),
					);
				}
			}
			if (target === null) return;
			if (target === order.limitPx) {
				return;
			}

			if (PAPER_TRADE) {
				// Preview: the simulated book IS the book — re-price locally, never
				// touch the exchange (there is no agent wallet to sign with).
				paperActions.repriceOrder(order.oid, Number(target));
				return;
			}
			const assetId = marketsRef.current.getAssetId(current.coin);
			if (typeof assetId !== "number") {
				useChaseOrderStore.getState().actions.clear();
				return;
			}
			const scope = orderEvidenceScope(getInfoClient(), address ?? "paper");
			const token = orderOperationLock.acquire(scope, order.oid);
			if (!token) return;
			pending = batchModify({
				modifies: [
					{
						oid: order.oid,
						order: {
							a: assetId,
							b: order.side === "B",
							p: target,
							s: order.sz,
							r: order.reduceOnly,
							t: { limit: { tif } },
							...(order.cloid ? { c: order.cloid } : {}),
						},
					},
				],
			})
				.then((result) => {
					const statuses = result.response?.data?.statuses;
					throwIfAnyResponseError(statuses);
					const primary = statuses?.[0];
					if (!primary) throw new Error("No response from exchange");
					if (typeof primary === "object" && "resting" in primary) {
						endedOids.add(order.oid);
						endedOids.delete(primary.resting.oid);
						remember({ ...order, oid: primary.resting.oid, limitPx: target, origSz: order.sz }, true);
					} else if (typeof primary === "object" && "filled" in primary) {
						trackedOid = primary.filled.oid;
						endedOids.add(order.oid);
						endedOids.add(trackedOid);
						acknowledgedOrder = undefined;
					}
				})
				.catch((error: unknown) => {
					const message = error instanceof Error ? error.message : "Chase reprice failed";
					if (isPostOnlyRaceError(message)) {
						// Expected post-only race: the book moved between our snapshot and
						// the exchange. Re-price next tick with a fresh book — not a failure.
						return;
					}
					if (isChaseOrderGoneError(message)) {
						endedOids.add(order.oid);
						acknowledgedOrder = undefined;
						return;
					}
					logFailure(message, order.sz, order.limitPx);
				})
				.finally(() => {
					orderOperationLock.release(scope, order.oid, token);
					pending = undefined;
				});
		};

		tick(); // first re-price fires immediately — shrinks the pre-book window
		const interval = setInterval(tick, CHASE_MODIFY_INTERVAL_MS);
		return () => {
			disposed = true;
			clearInterval(interval);
			// Whatever stops this entry managing its order (replaced by a newer chase,
			// timeout, fill, error, unmount) must never leave an unmanaged order
			// resting: cancel it if it is still on the book — a no-op once filled.
			const stale = entry;
			if (!stale) return;
			const cancelManaged = async () => {
				if (!PAPER_TRADE && sessionRef.current.address !== address) return;
				if (pendingCloid && address) {
					try {
						const status = await getInfoClient().orderStatus(
							{ user: address, oid: pendingCloid },
							AbortSignal.timeout(1500),
						);
						if (status.status === "order" && status.order.status === "open") remember(status.order.order, true);
					} catch {
						/* The original transport failure remains visible; never repost here. */
					}
				}
				if (!knownOrder && trackedOid !== undefined && address && !PAPER_TRADE) {
					try {
						const status = await getInfoClient().orderStatus(
							{ user: address, oid: trackedOid },
							AbortSignal.timeout(1500),
						);
						if (status.status === "order" && status.order.status === "open") remember(status.order.order, true);
					} catch {
						/* Acknowledged identity is retained; absence is never cancellation proof. */
					}
				}
				const orphan =
					acknowledgedOrder ??
					(trackedOid === undefined && !stale.placementPending
						? findActiveChaseOrder(ordersRef.current, stale)
						: ordersRef.current.find((order) => order.oid === trackedOid)) ??
					knownOrder;
				if (orphan && !endedOids.has(orphan.oid))
					void cancelOpenOrdersRef.current([orphan], { source: "chase", suppressExpectedMissing: true });
			};
			if (pending) void pending.then(cancelManaged);
			else cancelManaged();
			if (!retiredRef.current) {
				// Stopped managing without its own outcome (superseded / navigated away).
				const cached = lastOrderRef.current;
				useChaseOrderStore.getState().actions.pushHistory({
					coin: stale.coin,
					side: stale.side,
					size: stale.sizeText,
					reduceOnly: stale.reduceOnly,
					startedAt: stale.startedAt,
					endedAt: Date.now(),
					outcome: "cancelled",
					price: cached?.price,
				});
			}
		};
	}, [entry, batchModify, placeOrder, addOrder, paperActions, address, isActive]);
}
