import { useRef } from "react";
import { HL_ALL_DEXS } from "@/config/app";
import type { ExchangeOrder } from "@/config/trade";
import { formatPriceForOrder, formatSizeForOrder } from "@/domain/trade/orders";
import { useSubmitPlan } from "@/hooks/trade/use-submit-plan";
import { useMarkets, useSubscription, useUserPositions } from "@/lib/hyperliquid";

export interface CloseAllResult {
	closed: number;
	errors: string[];
}

/**
 * Closes every open position with reduce-only market orders (one single-asset plan
 * per position, priced from the live mark). Shared by the Flatten hotkey and the
 * toolbar Nuke button so both behave identically in preview and live.
 */
export function useCloseAllPositions(): () => Promise<CloseAllResult> {
	const { positions } = useUserPositions();
	const markets = useMarkets();
	const { submitPlan } = useSubmitPlan();
	const { data: midsEvent } = useSubscription("allMids", { dex: HL_ALL_DEXS }, { enabled: true });

	const positionsRef = useRef(positions);
	positionsRef.current = positions;
	const midsRef = useRef<Record<string, string> | undefined>(undefined);
	midsRef.current = midsEvent?.mids;

	return async () => {
		const errors: string[] = [];
		let closed = 0;
		for (const position of positionsRef.current) {
			const szi = Number(position.szi);
			if (!Number.isFinite(szi) || szi === 0) continue;
			const assetId = markets.getAssetId(position.coin);
			if (typeof assetId !== "number") continue;
			const raw = Number(midsRef.current?.[position.coin] ?? Number.NaN);
			const reference = Number.isFinite(raw) && raw > 0 ? raw : Number(position.entryPx);
			const order: ExchangeOrder = {
				a: assetId,
				b: szi < 0, // sell to close a long, buy to close a short
				p: formatPriceForOrder(reference),
				s: formatSizeForOrder(Math.abs(szi), markets.getSzDecimals(position.coin)),
				r: true,
				t: { limit: { tif: "FrontendMarket" } },
			};
			const result = await submitPlan({ orders: [order], grouping: "na" }, { coin: position.coin, dex: position.dex });
			if (result.ok) closed += 1;
			else errors.push(`${position.coin}: ${result.error}`);
		}
		return { closed, errors };
	};
}
