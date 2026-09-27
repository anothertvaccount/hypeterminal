import { t } from "@lingui/core/macro";
import type { AdvancedOrderType, OrderType } from "@/config/trade";

export function getAdvancedOrderTypeLabel(orderType: AdvancedOrderType): string {
	switch (orderType) {
		case "stopMarket":
			return t`Stop Market`;
		case "stopLimit":
			return t`Stop Limit`;
		case "takeProfitMarket":
			return t`Take Profit Market`;
		case "takeProfitLimit":
			return t`Take Profit Limit`;
		case "twap":
			return t`TWAP`;
		case "scale":
			return t`Scale`;
		case "chaseLimit":
			return t`Chase Limit`;
	}
}

export function getAdvancedOrderLabel(orderType: OrderType, fallback: string): string {
	return isAdvancedOrderType(orderType) ? getAdvancedOrderTypeLabel(orderType) : fallback;
}

export function isAdvancedOrderType(orderType: OrderType): orderType is AdvancedOrderType {
	return orderType !== "market" && orderType !== "limit";
}

export function isStopOrderType(orderType: OrderType): boolean {
	return orderType === "stopMarket" || orderType === "stopLimit";
}

export function isTakeProfitOrderType(orderType: OrderType): boolean {
	return orderType === "takeProfitMarket" || orderType === "takeProfitLimit";
}

export function isTriggerOrderType(orderType: OrderType): boolean {
	return isStopOrderType(orderType) || isTakeProfitOrderType(orderType);
}

export function isScaleOrderType(orderType: OrderType): boolean {
	return orderType === "scale";
}

export function isTwapOrderType(orderType: OrderType): boolean {
	return orderType === "twap";
}

export function usesLimitPrice(orderType: OrderType): boolean {
	return (
		orderType === "limit" || orderType === "stopLimit" || orderType === "takeProfitLimit" || orderType === "chaseLimit"
	);
}

export function usesTriggerPrice(orderType: OrderType): boolean {
	return isTriggerOrderType(orderType);
}

export function canUseTpSl(orderType: OrderType): boolean {
	// Scale ladders attach shared reduce-only TP/SL triggers like any entry main.
	return orderType === "market" || orderType === "limit" || orderType === "scale";
}

export function isTakerOrderType(orderType: OrderType): boolean {
	return (
		orderType === "market" || orderType === "stopMarket" || orderType === "takeProfitMarket" || orderType === "twap"
	);
}

export function isMarketExecutionOrderType(orderType: OrderType): boolean {
	return orderType === "market" || orderType === "stopMarket" || orderType === "takeProfitMarket";
}

export function getTabsOrderType(orderType: OrderType): "market" | "limit" | "advanced" {
	return orderType === "market" || orderType === "limit" ? orderType : "advanced";
}
