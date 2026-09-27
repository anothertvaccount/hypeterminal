import { STORAGE_KEYS } from "@/config/app";
import type { IChartingLibraryWidget } from "@/types/charting_library";

/**
 * Indicator/layout persistence for the TradingView widget via its LOW-LEVEL
 * save/load API: on the library's `onAutoSaveNeeded` event we call `widget.save()`
 * (the library serializes indicators + drawings + chart config itself) and keep the
 * state object in localStorage; on the next page load `widget.load(state)` restores
 * it. No server, no layout dialogs — just "what I put on the canvas is still there
 * after a refresh".
 *
 * The state is run through {@link sanitizeTvState} on BOTH paths: TV's serialized
 * chart carries geometry and symbol data that must never override the app's current
 * market (a left-captured price axis, or the MainSeries' saved `symbol`, silently
 * brick the canvas / pin every ticker switch to the symbol the save happened on).
 */

/**
 * TV stores each pane's price axes per side (`leftAxisesState` / `rightAxisesState`).
 * If the main axis is captured on the LEFT, loading that state renders the y-axis on
 * the wrong side and `getRightPriceScales()[0]` returns nothing — our calibration
 * reads the visible price range from it, so with no right scale there is no
 * measurement and EVERY price↔pixel feature dies: axis menu, chart-click pricing,
 * the label strip, previews, risk labels and TP/SL drags. The app never places an
 * axis on the left, so a left-side axis in persisted state is corruption (saved
 * mid-restore or a stray library save). Merge it back to the right side before the
 * state ever reaches the widget — on both the load and the save path.
 *
 * Returns the same object, mutated in place (the input is always a freshly
 * parsed/saved plain object we own), and reports whether anything was healed.
 */
export function sanitizeTvState(state: object, currentSymbol?: string): { state: object; healed: boolean } {
	let healed = false;
	try {
		const charts = (state as { charts?: unknown }).charts;
		if (!Array.isArray(charts)) return { state, healed };
		for (const chart of charts) {
			const panes = (chart as { panes?: unknown } | null)?.panes;
			if (!Array.isArray(panes)) continue;
			for (const pane of panes) {
				if (!pane || typeof pane !== "object") continue;
				const slot = pane as { leftAxisesState?: unknown; rightAxisesState?: unknown };
				if (Array.isArray(slot.leftAxisesState) && slot.leftAxisesState.length > 0) {
					const right = Array.isArray(slot.rightAxisesState) ? slot.rightAxisesState : [];
					slot.rightAxisesState = [...right, ...slot.leftAxisesState];
					slot.leftAxisesState = [];
					healed = true;
				}
				// The MainSeries source state carries the SAVED chart's symbol
				// (`state.symbol` / `state.shortName`). Loading it snaps the canvas
				// back to the symbol that was current when the save happened — so
				// switching to another ticker rebuilds the widget with the new
				// symbol and load() silently flips it straight back. Overwrite it
				// with the widget's current symbol (app market): TV then resolves
				// a complete, coherent state instead of a missing field.
				const sources = (pane as { sources?: unknown }).sources;
				if (!Array.isArray(sources)) continue;
				for (const source of sources) {
					if (!source || typeof source !== "object") continue;
					const series = source as { type?: unknown; state?: Record<string, unknown> };
					if (series.type !== "MainSeries" || !series.state || typeof series.state !== "object") continue;
					const hadSymbol = typeof series.state.symbol === "string";
					const oldShort = typeof series.state.shortName === "string" ? series.state.shortName : null;
					if (currentSymbol) {
						// Keep the quote side of the display name ("BTC/USDC" -> "ETH/USDC").
						const quote = oldShort?.includes("/") ? oldShort.slice(oldShort.indexOf("/")) : "";
						const next = { symbol: currentSymbol, shortName: `${currentSymbol}${quote}` };
						if (series.state.symbol !== next.symbol || series.state.shortName !== next.shortName) {
							series.state.symbol = next.symbol;
							series.state.shortName = next.shortName;
							healed = true;
						}
					} else if (hadSymbol || oldShort !== null) {
						// Save path: no widget symbol in scope — the load path overwrites
						// it anyway; keep the state as captured.
					}
				}
			}
		}
	} catch {
		// Defensive: a malformed state must never break the chart — pass it through
		// unchanged and let the widget's own load path reject it.
		return { state, healed };
	}
	if (healed) {
		console.warn("[tv-save-load] persisted chart state healed (price-axis side / saved symbol)");
	}
	return { state, healed };
}

function readStoredState(): object | null {
	try {
		const raw = localStorage.getItem(STORAGE_KEYS.TV_CHART);
		if (!raw) return null;
		const parsed: unknown = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? (parsed as object) : null;
	} catch {
		return null;
	}
}

/** Serialize the current chart through the widget and persist it (never throws into the library). */
export async function saveWidgetState(widget: IChartingLibraryWidget): Promise<boolean> {
	try {
		const state = await new Promise<unknown>((resolve, reject) => {
			try {
				widget.save((result: unknown) => resolve(result));
			} catch (error) {
				reject(error);
			}
		});
		if (!state || typeof state !== "object") return false;
		// Never persist a left-side axis even if the live chart somehow ended up
		// with one — the next load must not inherit the broken geometry.
		const { state: safe } = sanitizeTvState(state as object);
		try {
			localStorage.setItem(STORAGE_KEYS.TV_CHART, JSON.stringify(safe));
			return true;
		} catch (error) {
			console.warn("[tv-save-load] persist failed", error);
			return false;
		}
	} catch (error) {
		console.warn("[tv-save-load] serialize failed", error);
		return false;
	}
}

/** Restore the persisted chart state, if any. Called once the widget is ready. */
export function loadWidgetState(widget: IChartingLibraryWidget, currentSymbol?: string): boolean {
	const state = readStoredState();
	if (!state) return false;
	try {
		// Heal before the widget ever sees it: a left-axis state renders the y-axis
		// on the wrong side and kills all calibration-based chart trading; a saved
		// symbol would pin every market switch to the symbol the save happened on.
		const { state: safe } = sanitizeTvState(state, currentSymbol);
		widget.load(safe);
		return true;
	} catch (error) {
		console.warn("[tv-save-load] restore failed", error);
		return false;
	}
}
