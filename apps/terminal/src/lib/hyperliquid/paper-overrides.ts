import {
	type Position,
	type UseAgentStatusResult,
	type UserPositions,
	useAgentStatus as useAgentStatusBase,
	useSubscription,
	useTradingGuard as useTradingGuardBase,
	useUserPositions as useUserPositionsBase,
} from "@hypeterminal/hl-react";
import { HL_ALL_DEXS } from "@/config/app";
import { PAPER_BALANCE_USD, PAPER_TRADE } from "@/config/paper";
import { DEFAULT_MAX_LEVERAGE } from "@/config/trade";
import { usePaperFills } from "@/hooks/trade/use-paper-fills";
import { buildPaperUserPositions } from "@/lib/paper-trading";
import { usePaperPositions, usePaperRealizedUsd } from "@/stores/use-paper-store";

type TradingGuardResult = ReturnType<typeof useTradingGuardBase>;

/** Paper mode reports the agent as ready so no wallet signature or fee approval is ever requested. */
export function useAgentStatus(): UseAgentStatusResult {
	const base = useAgentStatusBase();
	if (!PAPER_TRADE) return base;
	return {
		...base,
		needsBuilderFee: false,
		needsAgent: false,
		signaturesRequired: 0,
		isReady: true,
		isLoading: false,
	};
}

/** Paper mode runs guarded trading actions directly — nothing is ever registered on-chain. */
export function useTradingGuard(): TradingGuardResult {
	const base = useTradingGuardBase();
	if (!PAPER_TRADE) return base;
	return {
		...base,
		isReady: true,
		isEnabling: false,
		needsTrading: false,
		error: null,
		enableTrading: () => {},
		clearError: base.clearError,
		guardAction: (action) => {
			Promise.resolve(action()).catch((error: unknown) => {
				console.warn("Preview action failed", error);
			});
		},
	};
}

/** Replaces account positions with locally simulated ones; live marks feed unrealized PnL. */
export function useUserPositions(): UserPositions {
	const base = useUserPositionsBase();
	const paperPositions = usePaperPositions();
	const paperRealized = usePaperRealizedUsd();
	usePaperFills();
	const { data: midsEvent } = useSubscription(
		"allMids",
		{ dex: HL_ALL_DEXS },
		{ enabled: PAPER_TRADE && paperPositions.length > 0 },
	);
	if (!PAPER_TRADE) return base;

	const positions: Position[] = buildPaperUserPositions(paperPositions, midsEvent?.mids, DEFAULT_MAX_LEVERAGE);
	return {
		positions,
		getPosition(coin: string, dex?: string) {
			if (dex !== undefined) return positions.find((p) => p.coin === coin && p.dex === dex) ?? null;
			return positions.find((p) => p.coin === coin) ?? null;
		},
		hasPosition(coin: string, dex?: string) {
			return this.getPosition(coin, dex) !== null;
		},
		withdrawable: String(Number((PAPER_BALANCE_USD + paperRealized).toFixed(2))),
		isLoading: false,
		hasError: false,
	};
}
