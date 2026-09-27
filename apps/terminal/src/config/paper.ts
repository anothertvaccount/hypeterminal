/**
 * Preview (paper) trading flag.
 *
 * Default comes from `VITE_PAPER_TRADE`, but the user can override it per browser
 * from the in-app mode switch; the chosen mode is stored and wins on next load.
 * Switching modes reloads the app so every consumer of `PAPER_TRADE` (a per-session
 * constant, read in ~60 places) restarts coherent — no half-switched subscriptions,
 * no stale guards.
 */
const PAPER_MODE_STORAGE_KEY = "hypeterminal:paper-mode";

function readStoredMode(): "paper" | "live" | null {
	try {
		const raw = globalThis.localStorage?.getItem(PAPER_MODE_STORAGE_KEY);
		return raw === "paper" || raw === "live" ? raw : null;
	} catch {
		return null;
	}
}

function resolvePaperFlag(): boolean {
	const stored = readStoredMode();
	if (stored !== null) return stored === "paper";
	return import.meta.env.VITE_PAPER_TRADE === "true";
}

export const PAPER_TRADE = resolvePaperFlag();

/** Persists the chosen mode and reloads so the whole app boots in that mode. */
export function setPreviewMode(mode: "paper" | "live"): void {
	try {
		globalThis.localStorage?.setItem(PAPER_MODE_STORAGE_KEY, mode);
	} catch {
		// Storage unavailable — the reload still applies the mode for this session
		// only if the flag was env-driven; nothing else we can do here.
	}
	globalThis.location?.reload();
}

/** Starting simulated account value in USD for paper trading. */
export const PAPER_BALANCE_USD = 100_000;

/** Leverage assumed when a paper position is opened without explicit meta. */
export const PAPER_DEFAULT_LEVERAGE = 10;

export const PAPER_BADGE_TEXT = "Preview mode — orders are simulated, no real funds";
export const LIVE_BADGE_TEXT = "Live mode — orders go to Hyperliquid";

export const MODE_LIVE_WARNING = "Real orders, real funds. Your preview orders stay saved.";
export const MODE_PREVIEW_NOTE = "Back to a simulated $100,000 account — real orders stop.";
export const MODE_CANCEL_LABEL = "Cancel";
export const MODE_CONFIRM_LIVE_LABEL = "Confirm — go live";
export const MODE_CONFIRM_PREVIEW_LABEL = "Switch to preview";
export const MODE_RESET_LABEL = "Reset preview account";

export const PAPER_MONEY_DISABLED_MESSAGE = "Unavailable in preview mode";
