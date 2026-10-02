import { t } from "@lingui/core/macro";
import { toast } from "sonner";
import type { ClosePositionData } from "@/components/trade/positions/position-dialog-types";
import { getPositionDex } from "@/domain/market";
import { formatSizeForOrder } from "@/domain/trade/orders";
import { useMarkets } from "@/lib/hyperliquid";
import { useExchangeScope } from "@/providers/exchange-scope";
import { useChaseOrderStore } from "@/stores/use-chase-order-store";
import { useMarketActions } from "@/stores/use-market-store";

/** The engine owns initial placement and retries, as well as repricing, until flat. */
export function useChaseClose(): (data: ClosePositionData) => void {
	const { scope } = useExchangeScope();
	const { setSelectedMarket } = useMarketActions();
	const markets = useMarkets();

	return (data: ClosePositionData) => {
		const { coin, size, szDecimals, isLong } = data;
		const state = useChaseOrderStore.getState();
		if (state.entry?.mode === "close" && state.entry.coin === coin) return;
		const market = markets.all.find(
			(row) => (data.assetId !== undefined && row.assetId === data.assetId) || row.name === coin,
		);
		const dex = coin.includes(":") ? coin.slice(0, coin.indexOf(":")) : market ? getPositionDex(market) : "";
		setSelectedMarket(scope, coin);
		state.actions.start({
			coin,
			dex,
			side: isLong ? "sell" : "buy",
			sizeText: formatSizeForOrder(Math.abs(size), szDecimals),
			tif: "Alo",
			reduceOnly: true,
			mode: "close",
			placementPending: true,
			startedAt: Date.now(),
		});
		toast.success(t`Chase close started — riding the touch until ${coin} is flat`, {
			description: t`Positions → Chase shows it live.`,
		});
	};
}
