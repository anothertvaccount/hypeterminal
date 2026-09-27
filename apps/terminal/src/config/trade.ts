import type { OrderParameters, TwapOrderParameters } from "@nktkas/hyperliquid";

export const QUICK_PERCENT_OPTIONS = [25, 50, 100, 200, 400] as const;
export const TP_QUICK_PERCENT_OPTIONS = [25, 50, 100, 200] as const;
export const SL_QUICK_PERCENT_OPTIONS = [5, 10, 25, 50] as const;

export const SMALL_BALANCE_THRESHOLD_USD = 1;
export const MAX_HISTORY_ROWS = 200;
export const LIQ_WARNING_PROXIMITY = 0.1;

export const ORDER_MIN_NOTIONAL_USD = 10;
export const ORDER_FEE_RATE_TAKER = 0.00045;
export const ORDER_FEE_RATE_MAKER = 0.00015;
export const ORDER_FEE_RATE_SPOT_TAKER = 0.0007;
export const ORDER_FEE_RATE_SPOT_MAKER = 0.0004;
export const ORDER_SIZE_PERCENT_STEPS = [25, 50, 75, 100] as const;
export const SIZE_PERCENT_OPTIONS = [0, 25, 50, 75, 100] as const;

/** Quick size chips above the slider — each click adds its USD amount to the size. */
export const DEFAULT_SIZE_BUTTON_AMOUNTS = [5, 50, 100, 250, 500] as const;
/** Default size prefilled when landing on the limit tab with an empty size (USD, editable in Settings). */
export const DEFAULT_LIMIT_SIZE_USD = 100;
export const ORDER_LEVERAGE_STEPS = [1, 2, 3, 5, 10, 15, 20, 25, 30, 40, 50, 75, 100, 125, 150, 200] as const;

/** Liquidation-distance safety multiplier applied to the 1/leverage price buffer. */
export const LIQUIDATION_BUFFER_FACTOR = 0.9;
/** Distance ratio below which the estimated liquidation price is flagged as too close. */
export const LIQ_WARNING_THRESHOLD = 0.05;
export const BPS_PER_UNIT = 10000;

// HL tick-size protocol: prices must carry at most 5 significant figures and 8 decimals.
export const HL_PRICE_MAX_SIG_FIGS = 5;
export const HL_PRICE_MAX_DECIMALS = 8;
/** Leverage ceiling below which `getDefaultLeverage` returns the max instead of halving. */
export const DEFAULT_LEVERAGE_FALLBACK = 5;

export const TWAP_MINUTES_MIN = 5;
export const TWAP_MINUTES_MAX = 1440;
export const TWAP_MIN_NOTIONAL_PER_MINUTE_USD = 10;
export const TWAP_SUBORDER_INTERVAL_SECONDS = 30;
export const SCALE_LEVELS_MIN = 2;
export const SCALE_LEVELS_MAX = 20;

export const DEFAULT_MAX_LEVERAGE = 50;
export const MARKET_LEVERAGE_HARD_MAX = 100;
export const DEFAULT_MARKET_ORDER_SLIPPAGE_PERCENT = 2.5;
export const MARKET_ORDER_SLIPPAGE_MIN_PERCENT = 0.1;
export const MARKET_ORDER_SLIPPAGE_MAX_PERCENT = 5;
export const DEFAULT_LEVERAGE_BY_MODE = { cross: 10, isolated: 10 } as const;

export const POSITIONS_TABS = [
	{ value: "balances", label: "Balances" },
	{ value: "positions", label: "Positions" },
	{ value: "orders", label: "Open Orders" },
	{ value: "twap", label: "TWAP" },
	{ value: "history", label: "Trade History" },
	{ value: "funding", label: "Funding History" },
	{ value: "orders-history", label: "Order History" },
	{ value: "chase", label: "Chase" },
] as const;

export const MOBILE_POSITIONS_TABS = [
	{ value: "positions", label: "Positions" },
	{ value: "orders", label: "Orders" },
	{ value: "balances", label: "Balances" },
	{ value: "twap", label: "TWAP" },
	{ value: "history", label: "Trades" },
	{ value: "orders-history", label: "Order Hist." },
	{ value: "chase", label: "Chase" },
	{ value: "funding", label: "Funding" },
] as const;

export type MobilePositionsTabValue = (typeof MOBILE_POSITIONS_TABS)[number]["value"];

export const ORDER_TYPES = [
	"market",
	"limit",
	"chaseLimit",
	"stopMarket",
	"stopLimit",
	"takeProfitMarket",
	"takeProfitLimit",
	"twap",
	"scale",
] as const;

export type OrderType = (typeof ORDER_TYPES)[number];
export type AdvancedOrderType = Exclude<OrderType, "market" | "limit">;
export type AdvancedOrderGroup = "trigger" | "execution";
export type ExchangeOrder = OrderParameters["orders"][number];
export type TwapOrderParams = TwapOrderParameters;

type OrderTypeSpec = ExchangeOrder["t"];
export type LimitTif = Extract<OrderTypeSpec, { limit: unknown }>["limit"]["tif"];

export const TIF_OPTIONS: Record<"Gtc" | "Ioc" | "Alo", { label: string }> = {
	Gtc: { label: "GTC" },
	Ioc: { label: "IOC" },
	Alo: { label: "Post Only" },
};

export const ADVANCED_ORDER_TYPES: AdvancedOrderType[] = [
	"chaseLimit",
	"stopMarket",
	"stopLimit",
	"takeProfitMarket",
	"takeProfitLimit",
	"twap",
	"scale",
];

export const ADVANCED_ORDER_GROUPS: Record<AdvancedOrderType, AdvancedOrderGroup> = {
	chaseLimit: "execution",
	stopMarket: "trigger",
	stopLimit: "trigger",
	takeProfitMarket: "trigger",
	takeProfitLimit: "trigger",
	twap: "execution",
	scale: "execution",
};

export const SPOT_ALLOWED_TYPES: AdvancedOrderType[] = ["twap", "scale"];

export const OPEN_ORDER_TYPE_PREFIXES = {
	takeProfit: "Take Profit",
	stop: "Stop",
} as const;

/**
 * A post-only chase prices off the real touch, so an empty book read can't fall
 * back to the mark — it has to try again. One l2Book call on a phone can come
 * back with no levels (cold subscription, rate limit), which used to fail the
 * placement outright. Bounded so a submit never hangs.
 */
export const CHASE_BOOK_READ_ATTEMPTS = 3;
export const CHASE_BOOK_READ_BACKOFF_MS = 300;
