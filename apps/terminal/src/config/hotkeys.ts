/**
 * Hotkey definitions — battle-tested trading hotkey defaults. Statuses are honest:
 *  - `available`: fully wired — bound by a default key, or bindable with no default
 *    binding (Settings → Hotkeys assigns one);
 *  - `unavailable`: hypeterminal has no equivalent feature (shown read-only). Keys
 *    for features this build does not ship are left out entirely rather than listed
 *    as dead rows.
 */

export type HotkeyGroup = "Chart clicks" | "Order entry" | "Cancellations" | "Order book" | "Form toggles";

export type HotkeyAvailability = "available" | "unavailable";

export interface HotkeyDefinition {
	id: string;
	/** Default key; null when none is documented. */
	combo: string | null;
	label: string;
	group: HotkeyGroup;
	availability: HotkeyAvailability;
	note?: string;
}

const RAW_HOTKEYS = [
	// --- Hold + click on the chart (price under the cursor) ---
	{
		id: "limitAtClick",
		combo: "s",
		label: "Limit at clicked price (buy below mid, sell above)",
		group: "Chart clicks",
		availability: "available",
	},
	{ id: "buyAtClick", combo: "a", label: "Buy at clicked price", group: "Chart clicks", availability: "available" },
	{ id: "sellAtClick", combo: "d", label: "Sell at clicked price", group: "Chart clicks", availability: "available" },
	{
		id: "slAtClick",
		combo: "v",
		label: "Place SL at clicked price",
		group: "Chart clicks",
		availability: "available",
		note: "Needs an open position — places a reduce-only stop.",
	},
	{
		id: "tpAtClick",
		combo: "b",
		label: "Place TP at clicked price",
		group: "Chart clicks",
		availability: "available",
		note: "Needs an open position — places a reduce-only take-profit.",
	},
	{
		id: "setPriceFromChart",
		combo: "z",
		label: "Set order price from chart",
		group: "Chart clicks",
		availability: "available",
	},

	// --- Order entry ---
	{
		id: "placeBuy",
		combo: "alt+shift+a",
		label: "Place buy order",
		group: "Order entry",
		availability: "available",
		note: "Submits the order form as a limit buy with its current size/price.",
	},
	{
		id: "placeSell",
		combo: "alt+shift+d",
		label: "Place sell order",
		group: "Order entry",
		availability: "available",
		note: "Submits the order form as a limit sell with its current size/price.",
	},
	{
		id: "marketBuy",
		combo: null,
		label: "Market buy",
		group: "Order entry",
		availability: "available",
		note: "No default key — use the side toggle + Market + Submit.",
	},
	{
		id: "marketSell",
		combo: null,
		label: "Market sell",
		group: "Order entry",
		availability: "available",
		note: "No default key — use the side toggle + Market + Submit.",
	},
	{
		id: "flattenPositions",
		combo: null,
		label: "Flatten positions",
		group: "Order entry",
		availability: "available",
		note: "No default key — close buttons per position.",
	},
	{
		id: "marketClosePosition",
		combo: null,
		label: "Market close active position",
		group: "Order entry",
		availability: "available",
		note: "No default key — Close button in the position row.",
	},
	{
		id: "limitClosePosition",
		combo: null,
		label: "Limit close active position",
		group: "Order entry",
		availability: "available",
		note: "No default key — reduce-only limit via the form.",
	},
	{
		id: "chaseClosePosition",
		combo: null,
		label: "Chase close active position",
		group: "Order entry",
		availability: "available",
		note: "Places a reduce-only chase limit that closes the active position.",
	},
	{
		id: "sizePreset1",
		combo: null,
		label: "Size preset 1",
		group: "Order entry",
		availability: "available",
		note: "Sets the size to quick-add amount 1 (Settings → Size buttons).",
	},
	{
		id: "sizePreset2",
		combo: null,
		label: "Size preset 2",
		group: "Order entry",
		availability: "available",
		note: "Sets the size to quick-add amount 2 (Settings → Size buttons).",
	},
	{
		id: "sizePreset3",
		combo: null,
		label: "Size preset 3",
		group: "Order entry",
		availability: "available",
		note: "Sets the size to quick-add amount 3 (Settings → Size buttons).",
	},
	{
		id: "sizePreset4",
		combo: null,
		label: "Size preset 4",
		group: "Order entry",
		availability: "available",
		note: "Sets the size to quick-add amount 4 (Settings → Size buttons).",
	},
	{
		id: "sizePreset5",
		combo: null,
		label: "Size preset 5",
		group: "Order entry",
		availability: "available",
		note: "Sets the size to quick-add amount 5 (Settings → Size buttons).",
	},

	// --- Cancellations ---
	{
		id: "cancelRecent",
		combo: "x",
		label: "Cancel recent order (active market)",
		group: "Cancellations",
		availability: "available",
	},
	{
		id: "cancelBuys",
		combo: "u",
		label: "Cancel buy orders (active market)",
		group: "Cancellations",
		availability: "available",
	},
	{
		id: "cancelSells",
		combo: "i",
		label: "Cancel sell orders (active market)",
		group: "Cancellations",
		availability: "available",
	},
	{
		id: "cancelMarketOrders",
		combo: "o",
		label: "Cancel active market orders",
		group: "Cancellations",
		availability: "available",
		note: "All resting orders on the active market.",
	},
	{
		id: "cancelAllOrders",
		combo: "p",
		label: "Cancel all orders",
		group: "Cancellations",
		availability: "available",
		note: "All resting orders across every market.",
	},

	// --- Order book ---
	{
		id: "topBookBuy",
		combo: "ctrl+alt+a",
		label: "Buy at top of orderbook",
		group: "Order book",
		availability: "available",
	},
	{
		id: "topBookSell",
		combo: "ctrl+alt+d",
		label: "Sell at top of orderbook",
		group: "Order book",
		availability: "available",
	},
	{
		id: "midBookBuy",
		combo: "ctrl+shift+a",
		label: "Buy at mid-bid",
		group: "Order book",
		availability: "available",
		note: "Approximated: 25% from best bid toward mid (no track-price feature).",
	},
	{
		id: "midBookSell",
		combo: "ctrl+shift+d",
		label: "Sell at mid-ask",
		group: "Order book",
		availability: "available",
		note: "Approximated: 25% from best ask toward mid (no track-price feature).",
	},

	// --- Form toggles ---
	{
		id: "togglePostOnly",
		combo: "q",
		label: "Toggle post only",
		group: "Form toggles",
		availability: "available",
		note: "Switches the TIF between Post Only and GTC.",
	},
	{ id: "toggleReduce", combo: "w", label: "Toggle reduce", group: "Form toggles", availability: "available" },
	{
		id: "toggleOrderOverlay",
		combo: "h",
		label: "Toggle Place Order overlay",
		group: "Form toggles",
		availability: "available",
		note: "Desktop: focuses the order form. Mobile: opens the Trade tab.",
	},
] as const satisfies readonly HotkeyDefinition[];

export type HotkeyId = (typeof RAW_HOTKEYS)[number]["id"];

/** Runtime table (full optional fields, e.g. `note`) with ids kept literal above. */
export const HOTKEYS: readonly HotkeyDefinition[] = RAW_HOTKEYS;

/** Actions completed by hold-key + chart click; the listener marks these on keydown. */
export const CHART_ACTION_IDS = [
	"buyAtClick",
	"sellAtClick",
	"limitAtClick",
	"setPriceFromChart",
	"slAtClick",
	"tpAtClick",
] as const satisfies readonly HotkeyId[];

/** Open/close the shortcuts help overlay. */
export const HELP_HOTKEY = "?";

export function getHotkey(id: HotkeyId): HotkeyDefinition {
	const found = HOTKEYS.find((hotkey) => hotkey.id === id);
	if (!found) throw new Error(`Unknown hotkey: ${id}`);
	return found;
}
