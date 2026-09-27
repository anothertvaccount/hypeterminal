import { ClientOnly } from "@tanstack/react-router";
import { Suspense, useState } from "react";
import { getPositionDex } from "@/domain/market";
import { useIntentScriptLoader } from "@/hooks/ui/use-intent-script-loader";
import { TRADINGVIEW_SCRIPT_SRC } from "@/lib/chart/load-tradingview";
import { chartSymbolFromMarket, useSelectedMarketInfo } from "@/lib/hyperliquid";
import { createLazyComponent } from "@/lib/lazy";
import { useRenderCommitTrack } from "@/lib/performance/render-profile";
import { useTheme } from "@/stores/use-global-settings-store";

const TradingViewChart = createLazyComponent(() => import("./tradingview-chart"), "TradingViewChart");
const KlineChart = createLazyComponent(() => import("./kline-chart"), "KlineChart");

type ChartType = "default" | "tradingview";

export function ChartPanel() {
	useRenderCommitTrack("chart");
	const theme = useTheme();
	const { data: selectedMarket } = useSelectedMarketInfo();
	// TradingView is the default chart on load; the original klinecharts canvas is
	// one click away — and the automatic fallback if the widget fails to load.
	const [chartType, setChartType] = useState<ChartType>("tradingview");
	const chartTheme = theme === "dark" ? "dark" : "light";
	const { intentHandlers: tradingViewIntentHandlers } = useIntentScriptLoader({
		src: TRADINGVIEW_SCRIPT_SRC,
		isReady: () => typeof window !== "undefined" && Boolean(window.TradingView),
		onIntent: () => TradingViewChart.preload?.(),
	});

	return (
		<div className="h-full flex flex-col overflow-hidden">
			{chartType === "default" && selectedMarket && (
				<ClientOnly>
					<Suspense fallback={<ChartLoadingFallback />}>
						<KlineChart
							symbol={chartSymbolFromMarket(selectedMarket.name, getPositionDex(selectedMarket))}
							positionDex={getPositionDex(selectedMarket)}
							theme={chartTheme}
							onChartSourceChange={setChartType}
							tradingViewIntentHandlers={tradingViewIntentHandlers}
						/>
					</Suspense>
				</ClientOnly>
			)}
			{chartType === "tradingview" && selectedMarket && (
				<ClientOnly>
					<Suspense fallback={<ChartLoadingFallback />}>
						<TradingViewChart
							symbol={chartSymbolFromMarket(selectedMarket.name, getPositionDex(selectedMarket))}
							theme={chartTheme}
							positionDex={getPositionDex(selectedMarket)}
							onSwitchToDefault={() => setChartType("default")}
							onLoadError={() => setChartType("default")}
						/>
					</Suspense>
				</ClientOnly>
			)}
		</div>
	);
}

function ChartLoadingFallback() {
	return <div className="h-full w-full animate-pulse bg-surface" />;
}
