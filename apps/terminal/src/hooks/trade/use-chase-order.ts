import { useEffect, useRef } from "react";
import { HL_ALL_DEXS } from "@/config/app";
import { PAPER_TRADE } from "@/config/paper";
import type { ChaseEntry } from "@/domain/trade/order/chase";
import {
	CHASE_MODIFY_INTERVAL_MS,
	CHASE_TIMEOUT_MS,
	chaseBehindMarkPrice,
	findChaseOrder,
	isPostOnlyRaceError,
	nextCloseChaseAction,
	resolveChaseOutcome,
	shouldCancelChase,
	shouldWaitForOrderSnapshot,
} from "@/domain/trade/order/chase";
import { formatPriceForOrder, formatSizeForOrder, throwIfResponseError } from "@/domain/trade/orders";
import { useCancelOpenOrders } from "@/hooks/trade/use-cancel-open-orders";
import { useExchange, useMarkets, useSubscription, useTradingSession, useUserPositions } from "@/lib/hyperliquid";
import type { OpenOrder } from "@/lib/trade/open-orders";
import { useChaseOrderStore } from "@/stores/use-chase-order-store";
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
 * out — they ride the touch until the position is flat, and stop with an explicit
 * message when the remainder drops below what an order can even express (Hyperliquid's
 * $10 minimum / the market's size step) instead of stranding dust silently.
 * The first re-price runs immediately to shrink the window before the book is known.
 */
export function useChaseOrderEngine(): void {
	const { address, isActive } = useTradingSession();
	const markets = useMarkets();
	// `positionsLoaded` matters: a lookup that returns null because the snapshot is
	// still in flight is NOT the same as a flat position, and treating it as flat
	// cancelled a live close chase and retired it as "completed".
	const { getPosition, isLoading: positionsLoading } = useUserPositions();
	// useSubmitPlan returns a FRESH closure every render, and the position
	// accessors are bound per render. Listing either in this effect's deps re-ran
	// the effect on every render — and its cleanup cancels the resting order, so a
	// cancel/re-post storm ended in React's "maximum update depth" crash. Keep them
	// in refs instead (like the order/book/entry refs) so the tick always reads the
	// latest values while the effect stays stable.
	const getPositionRef = useRef(getPosition);
	getPositionRef.current = getPosition;
	const positionsLoadingRef = useRef(positionsLoading);
	positionsLoadingRef.current = positionsLoading;
	const cancelOpenOrders = useCancelOpenOrders();
	const { addOrder } = useOrderQueueActions();
	const { mutateAsync: batchModify } = useExchange("batchModify");
	const entry = useChaseOrderStore((state) => state.entry);
	const paperRows = usePaperOpenOrderRows();
	const paperActions = usePaperActions();

	const { data: openOrdersEvent } = useSubscription(
		"openOrders",
		{ user: address ?? "0x0", dex: HL_ALL_DEXS },
		{ enabled: !PAPER_TRADE && isActive },
	);
	const { data: bookEvent } = useSubscription("l2Book", { coin: entry?.coin ?? "" }, { enabled: entry !== null });
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
	const lastSentRef = useRef(0);
	/** Last seen resting order — oid + price feed the history record. */
	const lastOrderRef = useRef<{ oid: number; price: string } | null>(null);
	/** True once this entry recorded its own outcome (timeout/fill/cancel). */
	const retiredRef = useRef(false);
	/** One queue row per chase for re-price failures — retries stay silent. */
	const modifyErrorLoggedRef = useRef(false);
	useEffect(() => {
		lastSentRef.current = 0;
		lastOrderRef.current = null;
		retiredRef.current = false;
		modifyErrorLoggedRef.current = false;
		if (!entry) return;

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

		/**
		 * Any resting reduce-only order for this coin on the chase's side, regardless of
		 * remaining size. Partial fills shrink the order, so the entry's original size
		 * no longer matches and an exact lookup would treat our own order as gone.
		 */
		function findRestingCloseOrder(orders: readonly OpenOrder[], entry: ChaseEntry): OpenOrder | undefined {
			const wantedSide = entry.side === "buy" ? "B" : "A";
			return orders.find(
				(order) =>
					order.coin === entry.coin &&
					order.side === wantedSide &&
					!order.isTrigger &&
					order.reduceOnly === entry.reduceOnly &&
					Number(order.sz) > 0,
			);
		}

		function remainingToClose(entry: ChaseEntry): { size: string; szi: number } | null {
			if (positionsLoadingRef.current) return null;
			const short = entry.coin.includes(":") ? entry.coin.slice(entry.coin.indexOf(":") + 1) : entry.coin;
			const pos = getPositionRef.current(entry.coin, entry.dex) ?? getPositionRef.current(short, entry.dex);
			if (!pos) return { size: "0", szi: 0 };
			const szi = Number(pos.szi);
			if (!Number.isFinite(szi) || szi === 0) return { size: "0", szi: 0 };
			return { size: formatSizeForOrder(Math.abs(szi), markets.getSzDecimals(entry.coin)), szi };
		}

		const tick = () => {
			const current = entryRef.current;
			if (!current) return;
			// Captured before the close branch narrows it, so the timeout guard below can
			// still read the mode as a plain value.
			const chaseMode: ChaseEntry["mode"] = current.mode;
			// A close chase's entry size is the ORIGINAL size, so once the order is
			// partially filled its remaining size no longer matches exactly — match on
			// coin/side/reduce-only instead, or the chase would re-post on top of its own
			// resting order.
			const order =
				current.mode === "close"
					? (findChaseOrder(ordersRef.current, current) ?? findRestingCloseOrder(ordersRef.current, current))
					: findChaseOrder(ordersRef.current, current);
			if (!order) {
				// A close chase's job is to get the position flat. If its order is not on
				// the book, the only honest options are "flat" or "re-post" — retiring as
				// completed/cancelled here is what stopped the phone chase ~40s in.
				if (current.mode === "close") {
					// A close chase keeps riding while its order rests, and only finishes on
					// a KNOWN position. An order missing from the snapshot for a moment (fill in
					// flight, re-price, snapshot race) must not be read as "gone" — that is what
					// stopped the phone chase with the position still open. (We deliberately do
					// NOT auto re-post here: a re-post that fires on a snapshot race stacks a
					// duplicate live order, which is worse than a missing convenience.)
					if (lastOrderRef.current === null && shouldWaitForOrderSnapshot(current.startedAt, Date.now())) {
						return;
					}
					const action = nextCloseChaseAction({
						remaining: toDecisionInput(remainingToClose(current)),
						markPx: markRef.current ?? Number.NaN,
					});
					if (action === "wait") return;
					if (action === "replace") return; // hold the entry; the order is in flight
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
				// Close chases run until the position is flat — or until the remainder
				// can't fill an order anymore (sub-minimum notional or below the market's
				// size step): stop with an explicit explanation instead of stranding dust.
				// A missing position row while the snapshot is still in flight is NOT flat:
				// treating it as flat cancelled a live close and retired it as completed.
				const remaining = remainingToClose(current);
				const action = nextCloseChaseAction({
					remaining: toDecisionInput(remaining),
					markPx: markRef.current ?? Number.NaN,
				});
				if (action === "wait") return;
				if (action === "replace") return;
				// Action is "completed" (flat) or "dust" (a remainder no order can fill).
				const szi = remaining?.szi ?? 0;
				const mark = markRef.current ?? Number(order.limitPx);
				const closeable = remaining?.size ?? "0";
				const dust = action === "dust";
				const orphan = findChaseOrder(ordersRef.current, current);
				if (orphan) void cancelOpenOrders([orphan]);
				useChaseOrderStore.getState().actions.pushHistory({
					coin: current.coin,
					side: current.side,
					size: current.sizeText,
					reduceOnly: current.reduceOnly,
					startedAt: current.startedAt,
					endedAt: now,
					outcome: dust ? "error" : "completed",
					price: order.limitPx,
				});
				lastOrderRef.current = null;
				retiredRef.current = true;
				if (dust) {
					addOrder({
						market: current.coin,
						side: current.side,
						size: closeable,
						price: order.limitPx,
						orderType: "limit",
						status: "failed",
						error: `$${(Math.abs(szi) * mark).toFixed(2)} of ${current.coin} remains — below Hyperliquid's $10 minimum order size, so no order can close it`,
						completedAt: Date.now(),
					});
				}
				useChaseOrderStore.getState().actions.clear();
				return;
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
			if (lastSentRef.current !== 0 && now - lastSentRef.current < CHASE_MODIFY_INTERVAL_MS) return;

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
					target = formatPriceForOrder(chaseBehindMarkPrice(current.side, mark, markets.getSzDecimals(current.coin)));
				}
			}
			if (target === null) return;
			if (target === order.limitPx) {
				lastSentRef.current = now;
				return;
			}

			if (PAPER_TRADE) {
				// Preview: the simulated book IS the book — re-price locally, never
				// touch the exchange (there is no agent wallet to sign with).
				paperActions.repriceOrder(order.oid, Number(target));
				lastSentRef.current = now;
				return;
			}
			const assetId = markets.getAssetId(current.coin);
			if (typeof assetId !== "number") {
				useChaseOrderStore.getState().actions.clear();
				return;
			}
			batchModify({
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
					throwIfResponseError(result.response?.data?.statuses);
				})
				.catch((error: unknown) => {
					const message = error instanceof Error ? error.message : "Chase reprice failed";
					if (isPostOnlyRaceError(message)) {
						// Expected post-only race: the book moved between our snapshot and
						// the exchange. Re-price next tick with a fresh book — not a failure.
						return;
					}
					// A rejected re-price must not kill the chase: log the first failure as
					// an order-queue row, then keep ticking — the next tick re-reads the
					// book (if the order filled mid-send, findChaseOrder retires it
					// truthfully as filled/completed) and the timeout still cancels any
					// orphan, so a persistent failure can never outlive the30s promise.
					if (!modifyErrorLoggedRef.current) {
						modifyErrorLoggedRef.current = true;
						addOrder({
							market: current.coin,
							side: current.side,
							size: order.sz,
							price: order.limitPx,
							orderType: "limit",
							status: "failed",
							error: message,
							completedAt: Date.now(),
						});
					}
				});
			lastSentRef.current = now;
		};

		tick(); // first re-price fires immediately — shrinks the pre-book window
		const interval = setInterval(tick, CHASE_MODIFY_INTERVAL_MS);
		return () => {
			clearInterval(interval);
			// Whatever stops this entry managing its order (replaced by a newer chase,
			// timeout, fill, error, unmount) must never leave an unmanaged order
			// resting: cancel it if it is still on the book — a no-op once filled.
			const stale = entry;
			if (!stale) return;
			const orphan = findChaseOrder(ordersRef.current, stale);
			if (!orphan) return;
			cancelOpenOrders([orphan]);
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
					price: cached?.price ?? orphan.limitPx,
				});
			}
		};
	}, [entry, cancelOpenOrders, markets, batchModify, addOrder, paperActions]);
}
