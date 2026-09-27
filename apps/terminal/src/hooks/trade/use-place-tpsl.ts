import { useCallback } from "react";
import { PAPER_TRADE } from "@/config/paper";
import { getPositionDex } from "@/domain/market";
import { buildPositionTriggerPlan, buildTpSlExchangeOrder } from "@/domain/trade/order/chart-labels";
import { sizeForFraction } from "@/domain/trade/order/size-steps";
import { formatPriceForOrder } from "@/domain/trade/orders";
import { playActionSound } from "@/lib/fill-sound";
import { useExchange, useMarkets, useUserPositions } from "@/lib/hyperliquid";
import { splitPaperPlan } from "@/lib/paper-trading";
import { interpretOrderStatuses } from "@/lib/trade/extract-order-status";
import { useOrderQueueActions } from "@/stores/use-order-queue-store";
import { usePaperActions } from "@/stores/use-paper-store";

/**
 * Places a reduce-only TP/SL trigger for100% of the position on `coin` — shared by the
 * position line's press-drag gesture and the V/B chart hotkeys so both paths behave
 * identically (preview: rests on the simulated book; live: normal-TP/SL group).
 */

export interface PlaceTpSlParams {
	coin: string;
	dex?: string;
	tpsl: "tp" | "sl";
	price: number;
	/** Fraction (0, 1] of the position to close — defaults to the full position (1). */
	sizeFraction?: number;
}

/** Local copy of the builder-symbol fallback (avoids a hook-module cycle). */
function shortCoin(coin: string): string {
	const separatorIndex = coin.indexOf(":");
	return separatorIndex === -1 ? coin : coin.slice(separatorIndex + 1);
}

export function usePlaceTpSl(): (params: PlaceTpSlParams) => void {
	const { getPosition } = useUserPositions();
	const markets = useMarkets();
	const paperActions = usePaperActions();
	const { addOrder } = useOrderQueueActions();
	const { mutateAsync: placeOrder } = useExchange("order");

	return useCallback(
		(params: PlaceTpSlParams) => {
			if (!Number.isFinite(params.price) || params.price <= 0) {
				if (import.meta.env.DEV) console.warn("[tpsl] skipped: invalid price", params);
				return;
			}
			const position = getPosition(params.coin, params.dex) ?? getPosition(shortCoin(params.coin), params.dex);
			const szi = position ? Number(position.szi) : 0;
			const entry = position ? Number(position.entryPx) : Number.NaN;
			if (!position || szi === 0 || !Number.isFinite(entry)) {
				// The usual silent killer: the chart's symbol/dex doesn't resolve a position.
				if (import.meta.env.DEV) console.warn("[tpsl] skipped: no position", params, { szi, entry });
				return;
			}

			// Exits sit opposite the position: a long closes with sells, a short with buys.
			const isBuy = szi < 0;
			const fraction =
				params.sizeFraction !== undefined && params.sizeFraction > 0 && params.sizeFraction <= 1
					? params.sizeFraction
					: 1;
			const sizeText = sizeForFraction(szi, fraction, markets.getSzDecimals(params.coin));
			if (sizeText === null) {
				// Fraction formatted to zero at this market's size precision (or no size at all).
				addOrder({
					market: params.coin,
					side: isBuy ? "buy" : "sell",
					size: "0",
					price: formatPriceForOrder(params.price),
					orderType: "trigger",
					status: "failed",
					error: "Size too small for this market",
					completedAt: Date.now(),
				});
				return;
			}
			const assetId = markets.getAssetId(params.coin) ?? markets.getAssetId(shortCoin(params.coin));
			if (typeof assetId !== "number") {
				addOrder({
					market: params.coin,
					side: isBuy ? "buy" : "sell",
					size: sizeText,
					price: formatPriceForOrder(params.price),
					orderType: "trigger",
					status: "failed",
					error: "Unknown market",
					completedAt: Date.now(),
				});
				return;
			}

			const order = buildTpSlExchangeOrder({
				assetId,
				isBuy,
				size: sizeText,
				triggerPrice: params.price,
				tpsl: params.tpsl,
			});

			if (PAPER_TRADE) {
				// Preview: the trigger rests on the simulated book and fires from the
				// fill engine when the mark trades through it. Nothing is signed.
				const resolveMarket = (id: number) => {
					const market = markets.all.find((m) => m.assetId === id);
					if (!market) return undefined;
					return { coin: market.name, dex: getPositionDex(market) };
				};
				const split = splitPaperPlan([order], { coin: params.coin, dex: params.dex }, resolveMarket);
				paperActions.applyPlan(split.fills, split.resting);
				return;
			}

			// positionTpsl — triggers against an EXISTING position. normalTpsl would be
			// rejected live with "Main order cannot be trigger order" (its first order
			// must be a normal entry, not a trigger).
			placeOrder(buildPositionTriggerPlan(order))
				.then((result) => {
					const status = interpretOrderStatuses(result.response?.data?.statuses ?? []);
					if (status.ok) {
						// Live TP/SL confirmed — dry tick (the preview path ticks from the store).
						playActionSound();
					} else {
						addOrder({
							market: params.coin,
							side: isBuy ? "buy" : "sell",
							size: sizeText,
							price: formatPriceForOrder(params.price),
							orderType: "trigger",
							status: "failed",
							error: status.error ?? "Order failed",
							completedAt: Date.now(),
						});
					}
				})
				.catch((error: unknown) => {
					addOrder({
						market: params.coin,
						side: isBuy ? "buy" : "sell",
						size: sizeText,
						price: formatPriceForOrder(params.price),
						orderType: "trigger",
						status: "failed",
						error: error instanceof Error ? error.message : "Order failed",
						completedAt: Date.now(),
					});
				});
		},
		[getPosition, markets, paperActions, placeOrder, addOrder],
	);
}
