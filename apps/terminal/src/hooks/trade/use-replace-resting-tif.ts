import { t } from "@lingui/core/macro";
import { useCallback } from "react";
import { toast } from "sonner";
import { HL_ALL_DEXS } from "@/config/app";
import { PAPER_TRADE } from "@/config/paper";
import { restingOrdersForTifSwitch } from "@/domain/trade/order/chart-labels";
import { useExchange, useSubscription, useTradingSession } from "@/lib/hyperliquid";
import type { OpenOrder } from "@/lib/trade/open-orders";
import { usePaperActions, usePaperOpenOrderRows } from "@/stores/use-paper-store";

/**
 * Time-in-force values an order can rest with. FrontendMarket is a market order
 * and never appears on a resting order, so it is not part of this.
 */
export type RestingTif = "Gtc" | "Ioc" | "Alo";

interface ReplaceRestingTifParams {
	/** The TIF to switch the resting orders TO. */
	nextTif: RestingTif;
	/** Qualified market name of the asset whose orders are re-posted. */
	coin: string;
	assetId: number | undefined;
}

/**
 * Flip a resting order's time-in-force without changing its price or size.
 *
 * TIF is fixed at placement, so the only way to switch it is to re-post: the
 * exchange's `batchModify` with `{ oid, order }` replaces the resting order in
 * place — same oid, same size, same price, new tif. That is deliberately what
 * happens here: the order never disappears from the book and never changes
 * price, it just stops (or starts) being post-only.
 *
 * Trigger orders (TP/SL, stops) keep their own tif and are left alone.
 */
export function useReplaceRestingTif(): (params: ReplaceRestingTifParams) => void {
	const { address, isActive } = useTradingSession();
	const { mutateAsync: batchModify } = useExchange("batchModify");
	const paperRows = usePaperOpenOrderRows();
	const paperActions = usePaperActions();
	const { data: openOrdersEvent } = useSubscription(
		"openOrders",
		{ user: address ?? "0x0", dex: HL_ALL_DEXS },
		{ enabled: !PAPER_TRADE && isActive },
	);

	return useCallback(
		({ nextTif, coin, assetId }: ReplaceRestingTifParams) => {
			// The live feed and the preview book expose different order types; both are
			// read as the app's OpenOrder so one selector covers them.
			const rows = (PAPER_TRADE ? paperRows : (openOrdersEvent?.orders ?? [])) as unknown as OpenOrder[];
			// Plain resting limit orders for this market only — TP/SL and other trigger
			// orders keep their own time-in-force and are never re-posted here.
			const affected = restingOrdersForTifSwitch<OpenOrder>(rows, coin, nextTif);

			if (affected.length === 0) {
				toast(t`No resting ${coin} orders to change`);
				return;
			}

			if (PAPER_TRADE) {
				// The preview book only models Gtc/Alo — an IOC never rests there, so
				// there is nothing to re-post.
				if (nextTif === "Ioc") {
					toast(t`IOC orders do not rest, so there is nothing to re-post`);
					return;
				}
				paperActions.setRestingTif(
					affected.map((order) => order.oid),
					nextTif,
				);
			} else {
				if (typeof assetId !== "number") {
					toast.error(t`Could not resolve ${coin}`);
					return;
				}
				void batchModify({
					modifies: affected.map((order) => ({
						oid: order.oid,
						order: {
							a: assetId,
							b: order.side === "B",
							p: order.limitPx,
							s: order.sz,
							r: order.reduceOnly,
							t: { limit: { tif: nextTif } },
							...(order.cloid ? { c: order.cloid } : {}),
						},
					})),
				})
					.then(() => {
						toast.success(
							t`${affected.length} resting ${coin} order${affected.length === 1 ? "" : "s"} now ${nextTif === "Alo" ? "post only" : "GTC"}`,
						);
					})
					.catch((error: unknown) => {
						toast.error(error instanceof Error ? error.message : t`Could not change the order type`);
					});
				return;
			}

			toast.success(
				t`${affected.length} resting ${coin} order${affected.length === 1 ? "" : "s"} now ${nextTif === "Alo" ? "post only" : "GTC"}`,
			);
		},
		[batchModify, openOrdersEvent, paperActions, paperRows],
	);
}
