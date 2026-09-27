import { t } from "@lingui/core/macro";
import { toast } from "sonner";
import type { ClosePositionData } from "@/components/trade/positions/position-dialog-types";
import { ORDER_MIN_NOTIONAL_USD } from "@/config/trade";
import { getPositionDex } from "@/domain/market";
import { chaseBehindMarkPrice, chasePlacementPrice } from "@/domain/trade/order/chase";
import { formatPriceForOrder, formatSizeForOrder } from "@/domain/trade/orders";
import { useSubmitPlan } from "@/hooks/trade/use-submit-plan";
import { getInfoClient, useMarkets } from "@/lib/hyperliquid";
import { useExchangeScope } from "@/providers/exchange-scope";
import { useChaseOrderStore } from "@/stores/use-chase-order-store";
import { useMarketActions } from "@/stores/use-market-store";
import { useOrderQueueActions } from "@/stores/use-order-queue-store";

/** Builder symbols are `dex:coin`; the markets registry keys on the qualified name. */
function shortCoin(coin: string): string {
	const separatorIndex = coin.indexOf(":");
	return separatorIndex === -1 ? coin : coin.slice(separatorIndex + 1);
}

/** Bounded l2Book read: post-only must price off the real touch, so try a few times. */
const BOOK_ATTEMPTS = 3;
const BOOK_BACKOFF_MS = 300;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Post-only chase close, shared by the desktop AND phone position lists.
 *
 * It places the order ITSELF — it does not prefill and submit the order form — so
 * the action behaves identically everywhere: the position starts closing where the
 * user is standing, with no navigation and no dependence on the form being mounted
 * (the phone only mounts it on the Trade tab). Full remaining size, post-only, and
 * the chase engine takes over from there: it rides the touch until the position is
 * flat, with no entry-style timeout. Below the $10 minimum no order can close, so
 * we say that explicitly instead of failing silently.
 */
export function useChaseClose(): (data: ClosePositionData) => void {
	const { scope } = useExchangeScope();
	const { setSelectedMarket } = useMarketActions();
	const { submitPlan } = useSubmitPlan();
	const { addOrder } = useOrderQueueActions();
	const markets = useMarkets();

	return async (data: ClosePositionData) => {
		const { coin, size, szDecimals, isLong } = data;
		const mark = Number(data.markPx);
		const closeable = formatSizeForOrder(Math.abs(size), szDecimals);
		const notional = Math.abs(size) * mark;
		const side = isLong ? "sell" : "buy";

		if (!(mark > 0) || !(Number(closeable) > 0) || notional < ORDER_MIN_NOTIONAL_USD) {
			const message = `$${(notional > 0 ? notional : 0).toFixed(2)} of ${coin} remains — below Hyperliquid's $10 minimum order size, so no order can close it`;
			toast.error(message);
			addOrder({
				market: coin,
				side,
				size: closeable,
				price: mark > 0 ? String(mark) : undefined,
				orderType: "limit",
				status: "failed",
				error: message,
				completedAt: Date.now(),
			});
			return;
		}

		// The caller already knows the asset; the registry lookup is only a fallback.
		const assetId = data.assetId ?? markets.getAssetId(coin) ?? markets.getAssetId(shortCoin(coin));
		if (typeof assetId !== "number") {
			const message = `Could not resolve ${coin} on the exchange — nothing was sent`;
			toast.error(message);
			addOrder({
				market: coin,
				side,
				size: closeable,
				price: formatPriceForOrder(mark),
				orderType: "limit",
				status: "failed",
				error: message,
				completedAt: Date.now(),
			});
			return;
		}

		// Post-only has to join the touch; guessing from the mark could cross and get
		// rejected. A cold/rate-limited book read used to fail the placement outright.
		let price: number | null = null;
		for (let attempt = 0; attempt < BOOK_ATTEMPTS; attempt += 1) {
			if (attempt > 0) await delay(BOOK_BACKOFF_MS * attempt);
			try {
				const book = await getInfoClient().l2Book({ coin });
				price = chasePlacementPrice(side, book?.levels, mark, szDecimals, "Alo");
			} catch {
				price = null;
			}
			if (price !== null) break;
		}
		if (price === null) {
			// Preview has no book to read: rest behind the mark until it trades through.
			price = chaseBehindMarkPrice(side, mark, szDecimals);
		}
		if (!(price > 0)) {
			const message = "Could not read a fresh book to price the post-only close — try again in a moment";
			toast.error(message);
			addOrder({
				market: coin,
				side,
				size: closeable,
				price: formatPriceForOrder(mark),
				orderType: "limit",
				status: "failed",
				error: message,
				completedAt: Date.now(),
			});
			return;
		}

		// Follow the market on the chart, then post the reduce-only rest.
		setSelectedMarket(scope, coin);

		const result = await submitPlan({
			orders: [
				{
					a: assetId,
					b: side === "buy",
					p: formatPriceForOrder(price),
					s: closeable,
					r: true,
					t: { limit: { tif: "Alo" } },
				},
			],
			grouping: "na",
		});

		if (!result.ok) {
			toast.error(t`Chase close failed — ${result.error ?? "the exchange rejected the order"}`);
			addOrder({
				market: coin,
				side,
				size: closeable,
				price: formatPriceForOrder(price),
				orderType: "limit",
				status: "failed",
				error: result.error ?? "The exchange rejected the order",
				completedAt: Date.now(),
			});
			return;
		}

		addOrder({
			market: coin,
			side,
			size: closeable,
			price: formatPriceForOrder(price),
			orderType: "limit",
			status: "success",
			outcome: result.outcome,
			completedAt: Date.now(),
		});

		// A resting chase hand-off is the engine's job: it re-prices at the touch every
		// few hundred ms until the position is flat.
		if (result.outcome !== "filled") {
			const market = markets.all.find((m) => m.assetId === assetId);
			const dex = coin.includes(":") ? coin.slice(0, coin.indexOf(":")) : market ? getPositionDex(market) : "";
			useChaseOrderStore.getState().actions.start({
				coin,
				dex,
				side,
				sizeText: closeable,
				reduceOnly: true,
				startedAt: Date.now(),
				mode: "close",
			});
		}

		toast.success(t`Chase close started — riding the touch until ${coin} is flat`, {
			description: t`Positions → Chase shows it live.`,
		});
	};
}
