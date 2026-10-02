import { HL_ALL_DEXS } from "@/config/app";
import { PAPER_TRADE } from "@/config/paper";
import { getPositionDex } from "@/domain/market";
import { getMarketQuoteToken } from "@/domain/trade/balances";
import { deriveOrderEntry, type OrderEntryDerived } from "@/domain/trade/order/derive";
import { getReduceOnlyMaxBase } from "@/domain/trade/order/reduce-only";
import { getSizeForPercent as getSizeForPercentCalc, getSizeValueForModeToggle } from "@/domain/trade/order/size";
import { useSubscription, useTradingSession, useUserPositions } from "@/lib/hyperliquid";
import type { UnifiedMarketInfo } from "@/lib/hyperliquid/hooks/useMarketsInfo";
import { withPaperQuoteToken } from "@/lib/paper-trading";
import { toNumber } from "@/lib/trade/numbers";
import type { Side, SizeMode } from "@/lib/trade/types";
import { useReduceOnly } from "@/stores/use-order-entry-store";
import { usePaperOpenOrders } from "@/stores/use-paper-store";
import { useDefaultDexBalances } from "./use-account-balances";
import { useAssetLeverage } from "./use-asset-leverage";

interface OrderEntryData extends OrderEntryDerived {
	isConnected: boolean;

	getSizeForPercent: (pct: number) => string;
	convertSizeForModeToggle: () => string;

	leverage: number;
	currentLeverage: number;
	pendingLeverage: number | null;
	maxLeverage: number;
	setPendingLeverage: (value: number) => void;
	resetPendingLeverage: () => void;
	marginMode: "cross" | "isolated";
	hasPosition: boolean;
	reduceOnlyPositionSzi: number | null;
	switchMarginMode: (mode: "cross" | "isolated") => Promise<void>;
	applyMarginAndLeverage: (mode: "cross" | "isolated", leverageValue: number) => Promise<void>;
	isSwitchingMode: boolean;
	switchModeError: Error | null;
	isOnlyIsolated: boolean;
	allowsCrossMargin: boolean;
	maxTradeSzs: [number, number] | null;
}

interface UseOrderEntryDataOptions {
	market: UnifiedMarketInfo | undefined;
	side: Side;
	markPx: number;
	sizeMode: SizeMode;
	sizeInput: string;
}

export function useOrderEntryData({
	market,
	side,
	markPx,
	sizeMode,
	sizeInput,
}: UseOrderEntryDataOptions): OrderEntryData {
	// A linked trading key is a tradable session: the form's balance, max size and
	// resting orders must resolve for it exactly as they do for a wallet.
	const { address, isActive: isConnected } = useTradingSession();
	const reduceOnly = useReduceOnly();
	const userPositions = useUserPositions();
	const paperOpenOrders = usePaperOpenOrders();
	const { data: openOrdersEvent } = useSubscription(
		"openOrders",
		{ user: address ?? "0x0", dex: HL_ALL_DEXS },
		// Shares a query key with the Orders tab; disabled in paper mode where the book lives locally.
		{ enabled: isConnected && !PAPER_TRADE },
	);
	const { spotBalances: rawSpotBalances, spotAvailableAfterMaintenance } = useDefaultDexBalances();
	// Paper trading: make sure the selected market's quote token has a simulated balance row.
	const spotBalances =
		PAPER_TRADE && market ? withPaperQuoteToken(rawSpotBalances, getMarketQuoteToken(market)) : rawSpotBalances;
	const {
		displayLeverage: leverage,
		currentLeverage,
		pendingLeverage,
		maxLeverage,
		setPendingLeverage,
		resetPending: resetPendingLeverage,
		maxTradeSzs,
		availableToTrade,
		marginMode,
		hasPosition,
		switchMarginMode,
		applyMarginAndLeverage,
		isSwitchingMode,
		switchModeError,
		isOnlyIsolated,
		allowsCrossMargin,
	} = useAssetLeverage();

	const conversionPrice = markPx > 0 ? markPx : 0;

	const derived = deriveOrderEntry({
		isConnected,
		market,
		side,
		conversionPrice,
		sizeMode,
		sizeInput,
		spotBalances,
		spotAvailableAfterMaintenance,
		maxTradeSzs,
		availableToTrade,
	});

	// Reduce Only: size the % slider against the current position, or — when flat — against
	// the market's resting buy limits, instead of the balance-based maximum.
	const reduceOnlyApplies = reduceOnly && !!market && !derived.isSpotMarket;
	const reduceOnlyPosition =
		reduceOnlyApplies && market ? userPositions.getPosition(market.name, getPositionDex(market)) : null;
	const reduceOnlyPositionSize = reduceOnlyPosition ? Math.abs(toNumber(reduceOnlyPosition.szi) ?? 0) : 0;
	const reduceOnlyPositionSzi =
		userPositions.isLoading || userPositions.hasError
			? null
			: reduceOnlyPosition
				? toNumber(reduceOnlyPosition.szi)
				: 0;
	let openBuySize = 0;
	if (reduceOnlyApplies && !reduceOnlyPosition && market) {
		if (PAPER_TRADE) {
			for (const order of paperOpenOrders) {
				if (order.isBuy && !order.reduceOnly && order.coin === market.name) openBuySize += order.size;
			}
		} else {
			for (const order of openOrdersEvent?.orders ?? []) {
				if (order.side === "B" && !order.isTrigger && !order.reduceOnly && order.coin === market.name) {
					openBuySize += Number(order.sz) || 0;
				}
			}
		}
	}
	const reduceOnlyMaxBase = reduceOnlyApplies
		? getReduceOnlyMaxBase({ positionSize: reduceOnlyPositionSize, openBuySize })
		: null;
	const orderEntry = reduceOnlyMaxBase !== null ? { ...derived, maxSize: reduceOnlyMaxBase } : derived;

	function getSizeForPercent(pct: number): string {
		return getSizeForPercentCalc({
			pct,
			isSpotMarket: orderEntry.isSpotMarket,
			side,
			sizeMode,
			price: conversionPrice,
			maxSize: orderEntry.maxSize,
			spotBalance: orderEntry.spotBalance,
			szDecimals: orderEntry.szDecimals,
		});
	}

	function convertSizeForModeToggle(): string {
		return getSizeValueForModeToggle({
			sizeValue: orderEntry.sizeValue,
			sizeMode,
			price: conversionPrice,
			szDecimals: orderEntry.szDecimals,
		});
	}

	return {
		isConnected,
		...orderEntry,
		getSizeForPercent,
		convertSizeForModeToggle,
		leverage,
		currentLeverage,
		pendingLeverage,
		maxLeverage,
		setPendingLeverage,
		resetPendingLeverage,
		marginMode,
		hasPosition,
		switchMarginMode,
		reduceOnlyPositionSzi,
		applyMarginAndLeverage,
		isSwitchingMode,
		switchModeError,
		isOnlyIsolated,
		allowsCrossMargin,
		maxTradeSzs,
	};
}
