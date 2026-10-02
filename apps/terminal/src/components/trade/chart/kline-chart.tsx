import type { Chart, KLineData } from "klinecharts";
import { DomPosition, dispose, FormatDateType, init, LoadDataType } from "klinecharts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type ChartTypeConfig, DEFAULT_CHART_TYPE, INITIAL_CANDLE_COUNT, VOLUME_INDICATOR_NAME } from "@/config/chart";
import { MS_PER_DAY, TAB_RESTORE_THRESHOLD_MS } from "@/config/time";
import { useChartPriceHotkeys } from "@/hooks/trade/chart/use-chart-price-hotkeys";
import { candleEventToKLineData, candlesToKLineData } from "@/lib/chart/candle";
import { formatShortDate, formatTime, formatTooltipDate } from "@/lib/chart/format";
import { DEFAULT_INTERVAL } from "@/lib/chart/kline-config";
import { buildKlineStyles } from "@/lib/chart/kline-styles";
import { registerLiquidationLineOverlay } from "@/lib/chart/liquidation-line-overlay";
import { registerOrderLineOverlay } from "@/lib/chart/order-line-overlay";
import { registerPositionLineOverlay } from "@/lib/chart/position-line-overlay";
import { registerPreviewLineOverlay } from "@/lib/chart/preview-line-overlay";
import { CANDLE_PANE_ID } from "@/lib/chart/price-axis";
import { getInfoClient, useSubscription } from "@/lib/hyperliquid";
import type { ChartSource, ChartSourceToggleIntentHandlers } from "./chart-source-toggle";
import { KlineToolbar } from "./kline-toolbar";
import { OrderTifMenu } from "./order-tif-menu";
import { type AxisMenuAdapter, PriceAxisMenu } from "./price-axis-menu";
import { useKlineFormPreviewOverlays } from "./use-kline-form-preview-overlays";
import { useKlineOrderOverlays } from "./use-kline-order-overlays";
import { useKlinePositionOverlays } from "./use-kline-position-overlays";

interface Props {
	symbol?: string;
	positionDex?: string;
	theme?: "light" | "dark";
	yAxisInside?: boolean;
	onChartSourceChange?: (source: ChartSource) => void;
	tradingViewIntentHandlers?: ChartSourceToggleIntentHandlers;
}

const CANDLE_FETCH_RETRY_DELAYS_MS = [750, 2_000] as const;

type CandleSnapshotParams = Parameters<ReturnType<typeof getInfoClient>["candleSnapshot"]>[0];

function delay(ms: number) {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function logRecoverableCandleFetchFailure(label: string, err: unknown) {
	if (import.meta.env.DEV) {
		console.warn(`kline ${label} candle fetch failed`, err);
	}
}

async function fetchCandlesWithRetry(params: CandleSnapshotParams, shouldContinue: () => boolean) {
	let lastError: unknown;

	for (const retryDelayMs of [0, ...CANDLE_FETCH_RETRY_DELAYS_MS]) {
		if (!shouldContinue()) return [];
		// react-doctor-disable-next-line react-doctor/async-await-in-loop
		if (retryDelayMs > 0) await delay(retryDelayMs);
		if (!shouldContinue()) return [];

		try {
			return await getInfoClient().candleSnapshot(params);
		} catch (err) {
			lastError = err;
		}
	}

	throw lastError;
}

export function KlineChart({
	symbol = "",
	positionDex,
	theme,
	yAxisInside = false,
	onChartSourceChange,
	tradingViewIntentHandlers,
}: Props) {
	const containerRef = useRef<HTMLDivElement>(null);
	const chartRef = useRef<Chart | null>(null);
	const [activeInterval, setActiveInterval] = useState(DEFAULT_INTERVAL);
	// Bumped whenever init() builds a NEW chart instance (symbol/interval switches
	// rebuild it) so the overlay hooks re-run — their effects key off this, not the
	// chartRef object, whose identity never changes.
	const [chartEpoch, setChartEpoch] = useState(0);
	const [activeChartType, setActiveChartType] = useState<ChartTypeConfig>(DEFAULT_CHART_TYPE);
	const activeCandleType = activeChartType.type;
	const intervalRef = useRef(activeInterval);
	intervalRef.current = activeInterval;
	const isHiddenRef = useRef(false);
	const hiddenAtRef = useRef<number | null>(null);
	const candleBufferRef = useRef<KLineData[]>([]);
	const chartStyleRef = useRef({ candleType: activeCandleType, yAxisInside });
	chartStyleRef.current = { candleType: activeCandleType, yAxisInside };

	useEffect(() => {
		const container = containerRef.current;
		if (!container || !symbol) return;
		let disposed = false;

		registerOrderLineOverlay();
		registerPositionLineOverlay();
		registerLiquidationLineOverlay();
		registerPreviewLineOverlay();

		const chart = init(container, {
			customApi: {
				formatDate: (_dateTimeFormat, timestamp, _format, type) => {
					const date = new Date(timestamp);
					if (type === FormatDateType.XAxis) {
						if (activeInterval.barMs >= MS_PER_DAY) return formatShortDate(date);
						if (date.getHours() === 0 && date.getMinutes() === 0) return formatShortDate(date);
						return formatTime(date);
					}
					return formatTooltipDate(date);
				},
			},
		});
		if (!chart) return;
		chartRef.current = chart;
		setChartEpoch((epoch) => epoch + 1);
		if (import.meta.env.DEV) {
			// Debug affordance for browser test scripts (dev builds only).
			(globalThis as { __hlChart?: unknown }).__hlChart = chart;
			(globalThis as { __hlContainer?: unknown }).__hlContainer = container;
			(globalThis as { __hlSymbol?: unknown }).__hlSymbol = symbol;
		}

		chart.setStyles(
			buildKlineStyles(chartStyleRef.current.candleType, { yAxisInside: chartStyleRef.current.yAxisInside }),
		);
		chart.createIndicator(VOLUME_INDICATOR_NAME);

		chart.setLoadDataCallback(({ type, data, callback }) => {
			const interval = intervalRef.current;

			if (type === LoadDataType.Forward && data) {
				const endTime = data.timestamp;
				const startTime = endTime - INITIAL_CANDLE_COUNT * interval.barMs;

				fetchCandlesWithRetry(
					{
						coin: symbol,
						interval: interval.candleInterval,
						startTime,
						endTime,
					},
					() => !disposed && chartRef.current === chart,
				)
					.then((candles) => callback(candlesToKLineData(candles), candles.length > 0))
					.catch((err) => {
						logRecoverableCandleFetchFailure("forward-load", err);
						callback([], false);
					});
			}

			if (type === LoadDataType.Backward) {
				callback([], false);
			}
		});

		const endTime = Date.now();
		const startTime = endTime - INITIAL_CANDLE_COUNT * activeInterval.barMs;

		fetchCandlesWithRetry(
			{
				coin: symbol,
				interval: activeInterval.candleInterval,
				startTime,
				endTime,
			},
			() => !disposed && chartRef.current === chart,
		)
			.then((candles) => {
				if (chartRef.current === chart) {
					chart.applyNewData(candlesToKLineData(candles), true);
				}
			})
			.catch((err) => {
				logRecoverableCandleFetchFailure("initial", err);
				if (chartRef.current === chart) {
					chart.applyNewData([], false);
				}
			});

		const ro = new ResizeObserver(() => chart.resize());
		ro.observe(container);

		return () => {
			disposed = true;
			ro.disconnect();
			chartRef.current = null;
			candleBufferRef.current = [];
			dispose(container);
		};
	}, [symbol, activeInterval]);

	useEffect(() => {
		const chart = chartRef.current;
		if (!chart) return;
		chart.setStyles(buildKlineStyles(activeCandleType, { yAxisInside, theme }));
	}, [activeCandleType, yAxisInside, theme]);

	useEffect(() => {
		let disposed = false;
		isHiddenRef.current = document.visibilityState === "hidden";
		candleBufferRef.current = [];

		function handleVisibility() {
			if (document.visibilityState === "hidden") {
				isHiddenRef.current = true;
				hiddenAtRef.current = Date.now();
				return;
			}

			const gapMs = hiddenAtRef.current !== null ? Date.now() - hiddenAtRef.current : 0;
			isHiddenRef.current = false;
			hiddenAtRef.current = null;

			const chart = chartRef.current;
			if (!chart) return;

			for (const kline of candleBufferRef.current) {
				chart.updateData(kline);
			}
			candleBufferRef.current = [];

			chart.resize();

			if (gapMs >= TAB_RESTORE_THRESHOLD_MS && symbol) {
				const interval = intervalRef.current;
				const endTime = Date.now();
				const startTime = endTime - INITIAL_CANDLE_COUNT * interval.barMs;
				fetchCandlesWithRetry(
					{ coin: symbol, interval: interval.candleInterval, startTime, endTime },
					() => !disposed && chartRef.current === chart,
				)
					.then((candles) => {
						if (chartRef.current === chart) {
							chart.applyNewData(candlesToKLineData(candles), true);
						}
					})
					.catch((err) => logRecoverableCandleFetchFailure("tab-restore", err));
			}
		}

		document.addEventListener("visibilitychange", handleVisibility);
		return () => {
			disposed = true;
			document.removeEventListener("visibilitychange", handleVisibility);
			candleBufferRef.current = [];
		};
	}, [symbol]);

	const candleData = useSubscription(
		"candle",
		{ coin: symbol, interval: activeInterval.candleInterval },
		{ enabled: !!symbol },
	);

	useEffect(() => {
		const chart = chartRef.current;
		const event = candleData.data;
		if (!chart || !event) return;

		const klineData = candleEventToKLineData(event);
		if (!klineData) return;

		if (isHiddenRef.current) {
			candleBufferRef.current.push(klineData);
		} else {
			chart.updateData(klineData);
		}
	}, [candleData.data]);

	const { tifMenu, openTifMenu, applyTif } = useKlineOrderOverlays({ chartRef, chartEpoch, symbol, dex: positionDex });
	useKlinePositionOverlays({ chartRef, chartEpoch, symbol, dex: positionDex });
	useKlineFormPreviewOverlays({ chartRef, chartEpoch, symbol });

	// Chart-agnostic adapters: the axis menu and the click hotkeys convert pixels →
	// prices through klinecharts here; the TradingView chart supplies its own pair.
	const priceAtContainerY = useCallback((y: number): number | null => {
		const converted = chartRef.current?.convertFromPixel([{ y }], { paneId: CANDLE_PANE_ID, absolute: true });
		const point = Array.isArray(converted) ? converted[0] : converted;
		return typeof point?.value === "number" && Number.isFinite(point.value) ? point.value : null;
	}, []);
	const axisAdapter = useMemo<AxisMenuAdapter>(
		() => ({
			getAxisRect: () => {
				const axisEl = chartRef.current?.getDom(CANDLE_PANE_ID, DomPosition.YAxis);
				if (!axisEl) return null;
				const r = axisEl.getBoundingClientRect();
				return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
			},
			priceAt: priceAtContainerY,
		}),
		[priceAtContainerY],
	);
	useChartPriceHotkeys({ containerRef, priceAt: priceAtContainerY, symbol, dex: positionDex });

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: a held finger on a price line must drag it, not raise the browser's text-selection menu. Not a control, so it takes no role/tab stop.
		<div
			className="flex flex-col h-full"
			// Same reason as the TV overlay: a held finger on a price line must drag
			// the line, not trigger the browser's text-selection menu.
			style={{ userSelect: "none", WebkitUserSelect: "none", WebkitTouchCallout: "none" }}
			onContextMenu={(event) => event.preventDefault()}
		>
			<KlineToolbar
				activeInterval={activeInterval}
				onIntervalChange={setActiveInterval}
				activeChartType={activeChartType}
				onChartTypeChange={setActiveChartType}
				onChartSourceChange={onChartSourceChange}
				tradingViewIntentHandlers={tradingViewIntentHandlers}
			/>
			<PriceAxisMenu adapter={axisAdapter} symbol={symbol} dex={positionDex}>
				<div ref={containerRef} className="absolute inset-0" />
			</PriceAxisMenu>
			{/* The order-type menu is a DOM popup — the klinecharts canvas cannot host it. */}
			<OrderTifMenu
				anchor={tifMenu}
				onClose={() => openTifMenu(null)}
				onPick={(tif) => {
					if (tifMenu) applyTif(tifMenu.order, tif);
				}}
			/>
		</div>
	);
}
