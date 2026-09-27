import { getShortBuilderSymbol } from "@/components/trade/chart/use-kline-position-overlays";
import { HL_ALL_DEXS } from "@/config/app";
import type { usePlaceTpSl } from "@/hooks/trade/use-place-tpsl";
import { useSubscription, type useUserPositions } from "@/lib/hyperliquid";
import { submitOrderForm } from "@/lib/trade/submit-order-form";
import { useHotkeysEnabled } from "@/stores/use-hotkey-settings-store";
import { useOrderEntryStore } from "@/stores/use-order-entry-store";

/** Chart click action ids (hold-key + click) — shared by both canvas variants. */
export type ChartPriceActionId =
	| "setPriceFromChart"
	| "buyAtClick"
	| "sellAtClick"
	| "limitAtClick"
	| "slAtClick"
	| "tpAtClick";

export interface ChartPriceActionContext {
	symbol: string;
	dex?: string;
	mark?: number;
	getPosition: ReturnType<typeof useUserPositions>["getPosition"];
	placeTpSl: ReturnType<typeof usePlaceTpSl>;
	/** Market size precision — lets an empty size get the default limit size. */
	szDecimals?: number;
}

/**
 * Executes a hold-key + chart-click action at `priceText` — the single source of
 * truth shared by the klinecharts canvas and the TradingView overlay layer, so a
 * rebind in settings behaves identically on both charts. Callers own the guards
 * (hotkeys enabled, click drift, overlay-interaction stamp, usable price).
 */
export function runChartPriceAction(heldId: ChartPriceActionId, priceText: string, ctx: ChartPriceActionContext): void {
	const price = Number(priceText);
	if (!Number.isFinite(price) || price <= 0) return;

	switch (heldId) {
		case "setPriceFromChart": {
			useOrderEntryStore.getState().actions.setLimitPrice(priceText);
			return;
		}
		case "buyAtClick":
		case "sellAtClick": {
			const side = heldId === "buyAtClick" ? ("buy" as const) : ("sell" as const);
			submitOrderForm(() => {
				const store = useOrderEntryStore.getState().actions;
				store.setSide(side);
				store.setOrderType("limit", { price, szDecimals: ctx.szDecimals });
				store.setLimitPrice(priceText);
			});
			return;
		}
		case "limitAtClick": {
			const mark = ctx.mark;
			if (mark === undefined) return;
			const side = price < mark ? ("buy" as const) : ("sell" as const);
			submitOrderForm(() => {
				const store = useOrderEntryStore.getState().actions;
				store.setSide(side);
				store.setOrderType("limit", { price, szDecimals: ctx.szDecimals });
				store.setLimitPrice(priceText);
			});
			return;
		}
		case "slAtClick":
		case "tpAtClick": {
			const { symbol: coin, dex: positionDex } = ctx;
			const position = ctx.getPosition(coin, positionDex) ?? ctx.getPosition(getShortBuilderSymbol(coin), positionDex);
			if (!position) return;
			ctx.placeTpSl({ coin, dex: positionDex, tpsl: heldId === "tpAtClick" ? "tp" : "sl", price });
			return;
		}
		default:
			return;
	}
}

/** Live mark for the shared runner (price-vs-mark side picking) — re-renders on ticks. */
export function useChartMark(symbol: string): number | undefined {
	const { data: midsEvent } = useSubscription("allMids", { dex: HL_ALL_DEXS }, { enabled: true });
	const raw = midsEvent?.mids?.[symbol];
	const parsed = raw !== undefined ? Number(raw) : Number.NaN;
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** Whether chart hotkeys may act — shared by both variants' click guards. */
export function useChartHotkeysEnabled(): boolean {
	return useHotkeysEnabled();
}
