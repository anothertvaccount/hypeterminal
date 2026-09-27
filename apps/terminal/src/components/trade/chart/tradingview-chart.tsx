import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CHART_MIN_HEIGHT_PX } from "@/config/chart";
import { TV_CHART_READY_TIMEOUT_MS } from "@/config/time";
import { loadTradingViewScript } from "@/lib/chart/load-tradingview";
import {
	buildChartOverrides,
	generateChartCssUrl,
	getLoadingScreenColors,
	getToolbarBgColor,
} from "@/lib/chart/theme-colors";
// Type-only: the "@/types/charting_library" alias resolves to a .d.ts, so importing
// the PriceScaleMode enum at runtime would resolve to nothing and break the module.
import type { IChartingLibraryWidget, PriceScaleMode, ResolutionString } from "@/types/charting_library";
import {
	CHART_CUSTOM_FONT_FAMILY,
	CHART_DISABLED_FEATURES,
	CHART_ENABLED_FEATURES,
	CHART_FAVORITE_INTERVALS,
	CHART_LIBRARY_PATH,
	CHART_LOCALE,
	CHART_TIME_FRAMES,
	CHART_WIDGET_DEFAULTS,
	DEFAULT_CHART_INTERVAL,
	DEFAULT_CHART_SYMBOL,
	DEFAULT_CHART_THEME,
	TIMEZONE,
} from "./constants";
import { createDatafeed } from "./datafeed";
import { type AxisMenuAdapter, PriceAxisMenu } from "./price-axis-menu";
import { TradingViewHoldClick } from "./tradingview/tradingview-hold-click";
import { TradingViewOverlayLayer } from "./tradingview/tradingview-overlay-layer";
import { tvViewportYToPrice } from "./tradingview/tv-calibration";
import { loadWidgetState, saveWidgetState } from "./tradingview/tv-save-load";
import { useTvCalibration } from "./tradingview/use-tv-calibration";

interface Props {
	symbol?: string;
	interval?: string;
	theme?: "light" | "dark";
	onSwitchToDefault?: () => void;
	/** Called when the widget fails to build or never signals ready — the panel falls back to the default canvas. */
	onLoadError?: () => void;
	/** Position dex — feeds the overlay layer's position line + TP/SL gestures. */
	positionDex?: string;
}

export function TradingViewChart({
	symbol = DEFAULT_CHART_SYMBOL,
	interval = DEFAULT_CHART_INTERVAL,
	theme = DEFAULT_CHART_THEME,
	onSwitchToDefault,
	onLoadError,
	positionDex,
}: Props) {
	const containerRef = useRef<HTMLDivElement>(null);
	const widgetRef = useRef<IChartingLibraryWidget | null>(null);
	const cssUrlRef = useRef<string | null>(null);
	const chartReadyRef = useRef(false);
	const [tvReady, setChartReadyState] = useState(false);
	const onSwitchToDefaultRef = useRef(onSwitchToDefault);
	onSwitchToDefaultRef.current = onSwitchToDefault;
	const onLoadErrorRef = useRef(onLoadError);
	onLoadErrorRef.current = onLoadError;

	useEffect(() => {
		if (!containerRef.current) return;
		let disposed = false;
		let handleAutoSave: (() => void) | null = null;
		chartReadyRef.current = false;

		/** Price scales in absolute mode — never percentages, never indexed-to-100. */
		function forceAbsolutePriceScale(widget: IChartingLibraryWidget): void {
			try {
				// The enum member for "normal" (the alias resolves to types only, so the
				// literal is cast through unknown rather than imported at runtime).
				const normal = "normal" as unknown as PriceScaleMode;
				for (const pane of widget.activeChart().getPanes()) {
					for (const scale of [...pane.getRightPriceScales(), ...pane.getLeftPriceScales()]) {
						if (scale.getMode() !== normal) scale.setMode(normal);
					}
				}
			} catch {
				// Chart mid-teardown — the next ready pass re-asserts.
			}
		}

		const initWidget = async () => {
			try {
				if (disposed || !containerRef.current) return;
				// react-doctor-disable-next-line react-doctor/async-defer-await
				await loadTradingViewScript();

				if (disposed || !containerRef.current || !window.TradingView) return;

				if (widgetRef.current) {
					widgetRef.current.remove();
				}

				if (cssUrlRef.current) {
					URL.revokeObjectURL(cssUrlRef.current);
				}

				const overrides = buildChartOverrides();
				const loadingColors = getLoadingScreenColors();
				const toolbarBg = getToolbarBgColor();
				const customCssUrl = await generateChartCssUrl();
				if (disposed || !containerRef.current || !window.TradingView) {
					URL.revokeObjectURL(customCssUrl);
					return;
				}
				cssUrlRef.current = customCssUrl;

				const widget = new window.TradingView.widget({
					container: containerRef.current,
					library_path: CHART_LIBRARY_PATH,
					datafeed: createDatafeed(),
					symbol: symbol,
					interval: interval as ResolutionString,
					auto_save_delay: 1,
					locale: CHART_LOCALE,
					fullscreen: CHART_WIDGET_DEFAULTS.FULLSCREEN,
					autosize: CHART_WIDGET_DEFAULTS.AUTOSIZE,
					theme: theme,
					timezone: TIMEZONE,
					debug: CHART_WIDGET_DEFAULTS.DEBUG,
					custom_font_family: CHART_CUSTOM_FONT_FAMILY,
					time_frames: CHART_TIME_FRAMES,
					enabled_features: CHART_ENABLED_FEATURES,
					disabled_features: CHART_DISABLED_FEATURES,
					overrides: overrides,
					loading_screen: loadingColors,
					toolbar_bg: toolbarBg,
					custom_css_url: customCssUrl,
					studies_overrides: {},
					favorites: {
						intervals: CHART_FAVORITE_INTERVALS,
					},
				});
				widgetRef.current = widget;

				// The library only NOTIFIES about changes (debounced by auto_save_delay) —
				// this pushes the serialized chart through the save/load adapter into
				// localStorage, which is what makes indicators survive a reload.
				handleAutoSave = () => {
					void saveWidgetState(widget);
				};
				widget.subscribe("onAutoSaveNeeded", handleAutoSave);

				widget.onChartReady(() => {
					if (disposed || widgetRef.current !== widget) return;
					chartReadyRef.current = true;
					setChartReadyState(true);
					// Rehydrate the saved layout (indicators + drawings) from localStorage.
					loadWidgetState(widget, symbol);
					// Absolute prices, always. TradingView persists a "percentage" /
					// "indexed to 100" price-scale mode in its own settings store (outside
					// the chart-properties flags we disable), and a stale one turns the
					// whole y-axis into +x% labels on every load. Re-assert AFTER the
					// state restore, since restoring can re-apply it.
					forceAbsolutePriceScale(widget);
					if (import.meta.env.DEV) {
						// Debug affordance for browser test scripts (dev builds only).
						(globalThis as { __hlTvWidget?: typeof widget }).__hlTvWidget = widget;
					}
				});

				if (onSwitchToDefaultRef.current) {
					widget.headerReady().then(() => {
						if (disposed || widgetRef.current !== widget) return;

						const btn = widget.createButton({ align: "right", useTradingViewStyle: false });
						btn.style.cssText =
							"display:inline-flex;align-items:center;gap:6px;padding:0 4px;cursor:default;height:100%;";

						const tvLabel = document.createElement("span");
						tvLabel.textContent = "TradingView";
						tvLabel.dataset.htActive = "true";
						tvLabel.style.cssText = "font-size:12px;color:var(--tv-fg,inherit);";

						const sep = document.createElement("span");
						sep.style.cssText =
							"display:inline-block;width:1px;height:12px;background:var(--tv-color-toolbar-divider-background,rgba(128,128,128,0.3));align-self:center;flex-shrink:0;";

						const defaultLabel = document.createElement("span");
						defaultLabel.textContent = "Default";
						defaultLabel.style.cssText =
							"font-size:12px;font-weight:400;color:var(--tv-muted-fg,rgba(128,128,128,0.8));cursor:pointer;";
						defaultLabel.onpointerover = () => {
							defaultLabel.style.color = "var(--tv-fg,inherit)";
						};
						defaultLabel.onpointerout = () => {
							defaultLabel.style.color = "var(--tv-muted-fg,rgba(128,128,128,0.8))";
						};
						defaultLabel.onclick = () => {
							onSwitchToDefaultRef.current?.();
						};

						btn.appendChild(defaultLabel);
						btn.appendChild(sep);
						btn.appendChild(tvLabel);
					});
				}
			} catch {
				// Widget failed to build (script blocked, transport…) — TradingView is the
				// default chart now, so hand control back to the klinecharts backup.
				if (!disposed) onLoadErrorRef.current?.();
			}
		};

		initWidget();
		// Watchdog: a widget that never signals ready must also fall back — otherwise
		// the default chart load would show a blank pane with no way to switch.
		const readyTimer = setTimeout(() => {
			if (disposed || chartReadyRef.current) return;
			onLoadErrorRef.current?.();
		}, TV_CHART_READY_TIMEOUT_MS);

		return () => {
			disposed = true;
			clearTimeout(readyTimer);
			if (handleAutoSave) {
				try {
					widgetRef.current?.unsubscribe("onAutoSaveNeeded", handleAutoSave);
				} catch {
					// Widget already gone.
				}
			}
			if (widgetRef.current) {
				widgetRef.current.remove();
				widgetRef.current = null;
			}
			chartReadyRef.current = false;
			if (cssUrlRef.current) {
				URL.revokeObjectURL(cssUrlRef.current);
				cssUrlRef.current = null;
			}
		};
	}, [symbol, interval, theme]);

	// Price↔pixel calibration for every overlay (rows, drags, axis menu, hotkeys).
	const calibration = useTvCalibration({ ready: tvReady, hostRef: containerRef, widgetRef });
	// Lets a touch drag continue past the chart edge: shift the visible price range
	// by a fraction of its span so the line can be placed far outside the candles.
	const shiftVisiblePriceRange = useCallback((deltaFraction: number) => {
		const widget = widgetRef.current;
		if (!widget || !Number.isFinite(deltaFraction) || deltaFraction === 0) return;
		try {
			const scale = widget.activeChart().getPanes()[0]?.getRightPriceScales()[0];
			const range = scale?.getVisiblePriceRange();
			if (!scale || !range || !Number.isFinite(range.from) || !Number.isFinite(range.to)) return;
			const shift = (range.to - range.from) * deltaFraction;
			scale.setVisiblePriceRange({ from: range.from + shift, to: range.to + shift });
		} catch {
			// Chart mid-teardown — ignore.
		}
	}, []);

	const axisAdapter = useMemo<AxisMenuAdapter>(
		() => ({
			getAxisRect: () => calibration.get()?.axis ?? null,
			priceAt: (yWrapper) => {
				const m = calibration.get();
				if (!m) return null;
				const hostTop = containerRef.current?.getBoundingClientRect().top ?? 0;
				return tvViewportYToPrice(m, hostTop + yWrapper);
			},
		}),
		[calibration],
	);

	return (
		<div className="relative flex w-full h-full flex-col" style={{ minHeight: CHART_MIN_HEIGHT_PX }}>
			<PriceAxisMenu adapter={axisAdapter} symbol={symbol} dex={positionDex}>
				<div ref={containerRef} className="absolute inset-0" />
				{tvReady && (
					<TradingViewOverlayLayer
						hostRef={containerRef}
						calibration={calibration}
						symbol={symbol}
						dex={positionDex}
						shiftPriceRange={shiftVisiblePriceRange}
					/>
				)}
				{tvReady && (
					<TradingViewHoldClick hostRef={containerRef} calibration={calibration} symbol={symbol} dex={positionDex} />
				)}
			</PriceAxisMenu>
		</div>
	);
}
