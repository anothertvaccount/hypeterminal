import { useTradingSession } from "@hypeterminal/hl-react";
import type { AllDexsClearinghouseStateWsEvent, SpotStateWsEvent, WebData3WsEvent } from "@nktkas/hyperliquid";
import { useMemo } from "react";
import { HL_ALL_DEXS } from "@/config/app";
import { PAPER_BALANCE_USD, PAPER_TRADE } from "@/config/paper";
import { DEFAULT_MAX_LEVERAGE } from "@/config/trade";
import { useSubscription } from "@/lib/hyperliquid";
import { buildPaperUserPositions, sumPaperMarginUsed } from "@/lib/paper-trading";
import { usePaperPositions, usePaperRealizedUsd } from "@/stores/use-paper-store";

type RawClearinghouseState = AllDexsClearinghouseStateWsEvent["clearinghouseStates"][number][1];
type RawSpotState = SpotStateWsEvent["spotState"] & {
	tokenToAvailableAfterMaintenance?: Array<[number | string, string]>;
};

export type MarginSummary = RawClearinghouseState["marginSummary"];
export type PerpSummary = RawClearinghouseState["crossMarginSummary"];
export type PerpPosition = RawClearinghouseState["assetPositions"][number];
export type SpotBalance = NonNullable<SpotStateWsEvent["spotState"]["balances"]>[number];
export type SpotAvailableAfterMaintenance = NonNullable<RawSpotState["tokenToAvailableAfterMaintenance"]>;
export type AccountAbstraction = NonNullable<WebData3WsEvent["userState"]["abstraction"]> | null;

/** Wraps a simulated position in the exchange's asset-position shape for the account panel. */
function toPaperPerpPosition(row: {
	coin: string;
	szi: string;
	entryPx: string;
	positionValue: string;
	unrealizedPnl: string;
	returnOnEquity: string;
	liquidationPx: string | null;
	marginUsed: string;
	maxLeverage: number;
	leverage: PerpPosition["position"]["leverage"];
	cumFunding: PerpPosition["position"]["cumFunding"];
}): PerpPosition {
	return {
		type: "oneWay",
		position: {
			coin: row.coin,
			szi: row.szi,
			entryPx: row.entryPx,
			positionValue: row.positionValue,
			unrealizedPnl: row.unrealizedPnl,
			returnOnEquity: row.returnOnEquity,
			liquidationPx: row.liquidationPx,
			marginUsed: row.marginUsed,
			maxLeverage: row.maxLeverage,
			leverage: row.leverage,
			cumFunding: row.cumFunding,
		},
	};
}

export interface AccountBalances {
	marginSummary: MarginSummary | null;
	perpSummary: PerpSummary | null;
	perpPositions: PerpPosition[];
	spotBalances: SpotBalance[];
	spotAvailableAfterMaintenance: SpotAvailableAfterMaintenance;
	accountAbstraction: AccountAbstraction;
	withdrawable: string;
	crossMaintenanceMarginUsed: string;
	isLoading: boolean;
	hasError: boolean;
	/**
	 * Per-feed failures. The three account feeds are independent: `webData3` only
	 * carries the account abstraction and `spotState` only the spot wallet, so a
	 * failure there must not hide a perfectly good perp balance (nor vice versa).
	 */
	perpError: boolean;
	spotError: boolean;
	abstractionError: boolean;
}

const EMPTY_SPOT_BALANCES: SpotBalance[] = [];
const EMPTY_PERP_POSITIONS: PerpPosition[] = [];
const EMPTY_SPOT_AVAILABLE_AFTER_MAINTENANCE: SpotAvailableAfterMaintenance = [];

export interface AllDexsAccountState {
	clearinghouseStates: AllDexsClearinghouseStateWsEvent["clearinghouseStates"];
	spotBalances: SpotBalance[];
	spotAvailableAfterMaintenance: SpotAvailableAfterMaintenance;
	accountAbstraction: AccountAbstraction;
	isLoading: boolean;
	hasError: boolean;
	perpError: boolean;
	spotError: boolean;
	abstractionError: boolean;
}

export function useAllDexsAccountState(): AllDexsAccountState {
	// Keyed on the trading session, not the wallet: a linked Phone Access key has
	// no wallet but still owns an account whose balances belong on screen.
	const { address, isActive: enabled } = useTradingSession();

	const { data: clearinghouseEvent, status: perpStatus } = useSubscription(
		"allDexsClearinghouseState",
		{ user: address ?? "" },
		{ enabled },
	);

	const { data: spotEvent, status: spotStatus } = useSubscription("spotState", { user: address ?? "0x0" }, { enabled });
	const { data: webData3Event, status: webData3Status } = useSubscription(
		"webData3",
		{ user: address ?? "0x0" },
		{ enabled },
	);
	const spotState = spotEvent?.spotState as RawSpotState | undefined;

	const clearinghouseStates = clearinghouseEvent?.clearinghouseStates ?? [];
	const spotBalances = spotState?.balances ?? EMPTY_SPOT_BALANCES;
	const accountAbstraction = webData3Event?.userState.abstraction ?? null;
	const spotAvailableAfterMaintenance = useMemo(
		() => spotState?.tokenToAvailableAfterMaintenance ?? EMPTY_SPOT_AVAILABLE_AFTER_MAINTENANCE,
		[spotState?.tokenToAvailableAfterMaintenance],
	);

	const isLoading =
		perpStatus === "subscribing" ||
		perpStatus === "idle" ||
		spotStatus === "subscribing" ||
		spotStatus === "idle" ||
		webData3Status === "subscribing" ||
		webData3Status === "idle";
	const perpError = perpStatus === "error";
	const spotError = spotStatus === "error";
	const abstractionError = webData3Status === "error";
	const hasError = perpError || spotError || abstractionError;

	return {
		clearinghouseStates,
		spotBalances,
		spotAvailableAfterMaintenance,
		accountAbstraction,
		isLoading,
		hasError,
		perpError,
		spotError,
		abstractionError,
	};
}

export function useDefaultDexBalances(): AccountBalances {
	const {
		clearinghouseStates,
		spotBalances,
		spotAvailableAfterMaintenance,
		accountAbstraction,
		isLoading,
		hasError,
		perpError,
		spotError,
		abstractionError,
	} = useAllDexsAccountState();
	const paperPositions = usePaperPositions();
	const paperRealized = usePaperRealizedUsd();
	// Live marks drive the synthetic per-position rows (uPnL / notional) the account
	// panel and mobile account view read — only subscribed while previewing with an
	// open position.
	const { data: paperMidsEvent } = useSubscription(
		"allMids",
		{ dex: HL_ALL_DEXS },
		{ enabled: PAPER_TRADE && paperPositions.length > 0 },
	);
	const paperPositionRows = useMemo(
		() => buildPaperUserPositions(paperPositions, paperMidsEvent?.mids, DEFAULT_MAX_LEVERAGE),
		[paperPositions, paperMidsEvent?.mids],
	);

	if (PAPER_TRADE) {
		const marginUsed = sumPaperMarginUsed(paperPositions);
		// Cash = base balance + realized PnL; equity (accountValue) adds live uPnL so
		// Balance = equity − uPnL = cash, matching the exchange's semantics.
		const cash = Number((PAPER_BALANCE_USD + paperRealized).toFixed(2));
		let unrealized = 0;
		let totalNtlPos = 0;
		for (const row of paperPositionRows) {
			unrealized += Number(row.unrealizedPnl) || 0;
			totalNtlPos += Number(row.positionValue) || 0;
		}
		const equity = Number((cash + unrealized).toFixed(2));
		const paperSummary = {
			accountValue: String(equity),
			totalNtlPos: String(Number(totalNtlPos.toFixed(2))),
			totalRawUsd: String(cash),
			totalMarginUsed: String(marginUsed),
		};
		return {
			marginSummary: paperSummary,
			perpSummary: paperSummary,
			perpPositions: paperPositionRows.map(toPaperPerpPosition),
			spotBalances: [{ coin: "USDC", token: 0, total: String(cash), hold: String(marginUsed), entryNtl: String(cash) }],
			spotAvailableAfterMaintenance: [],
			accountAbstraction: null,
			withdrawable: String(cash),
			crossMaintenanceMarginUsed: String(marginUsed),
			isLoading: false,
			hasError: false,
			perpError: false,
			spotError: false,
			abstractionError: false,
		};
	}

	const mainDex = clearinghouseStates.find(([dex]) => dex === "")?.[1];
	const marginSummary = mainDex?.marginSummary ?? null;
	const perpSummary = mainDex?.crossMarginSummary ?? null;
	const perpPositions = mainDex?.assetPositions ?? EMPTY_PERP_POSITIONS;
	const withdrawable = mainDex?.withdrawable ?? "0";
	const crossMaintenanceMarginUsed = mainDex?.crossMaintenanceMarginUsed ?? "0";

	return {
		marginSummary,
		perpSummary,
		perpPositions,
		spotBalances,
		spotAvailableAfterMaintenance,
		accountAbstraction,
		withdrawable,
		crossMaintenanceMarginUsed,
		isLoading,
		hasError,
		perpError,
		spotError,
		abstractionError,
	};
}

export { useDefaultDexBalances as useAccountBalances };
