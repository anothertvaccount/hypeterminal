import { FireIcon } from "@phosphor-icons/react";
import { ClientOnly } from "@tanstack/react-router";
import { Skeleton } from "boneyard-js/react";
import { Suspense, useState } from "react";
import { UI_TEXT } from "@/config/ui-text";
import { get24hChange, getOiUsd, getPositionDex } from "@/domain/market";
import { cn } from "@/lib/cn";
import { formatPercent, formatUSD } from "@/lib/format";
import { chartSymbolFromMarket, useSelectedMarketInfo } from "@/lib/hyperliquid";
import { createLazyComponent } from "@/lib/lazy";
import { toBig } from "@/lib/trade/numbers";
import { getValueColorClass } from "@/lib/ui/value-color";
import { useExchangeScope } from "@/providers/exchange-scope";
import { useTheme } from "@/stores/use-global-settings-store";
import { useMarketActions } from "@/stores/use-market-store";
import { TokenSelector } from "../chart/token-selector";
import { MobileBottomNavSpacer } from "./mobile-bottom-nav";

const KlineChart = createLazyComponent(() => import("../chart/kline-chart"), "KlineChart");
const TradingViewChart = createLazyComponent(() => import("../chart/tradingview-chart"), "TradingViewChart");

type ChartType = "default" | "tradingview";

const overviewText = UI_TEXT.MARKET_OVERVIEW;

interface MobileChartViewProps {
	className?: string;
}

export function MobileChartView({ className }: MobileChartViewProps) {
	const theme = useTheme();
	// TradingView is the default canvas on mobile too (desktop parity: natively
	// touch-capable axis zoom/drag, labels, drawing tools); the original klinecharts
	// canvas stays as the automatic fallback if the widget fails to load.
	const [chartType, setChartType] = useState<ChartType>("tradingview");
	const { data: selectedMarket, isLoading } = useSelectedMarketInfo();
	const { scope } = useExchangeScope();
	const { setSelectedMarket } = useMarketActions();

	function handleMarketChange(marketName: string) {
		setSelectedMarket(scope, marketName);
	}

	const fundingNum = toBig(selectedMarket?.funding)?.toNumber() ?? 0;
	const markPx = selectedMarket?.markPx;
	const change24h = get24hChange(selectedMarket?.prevDayPx, selectedMarket?.markPx);
	const oiUsd = getOiUsd(selectedMarket?.openInterest, selectedMarket?.markPx);

	return (
		<div className={cn("flex flex-col flex-1 min-h-0", className)}>
			<div className="shrink-0 px-3 py-2 border-b border-stroke-weak/60 bg-surface">
				<div className="flex items-center justify-between gap-3">
					<TokenSelector selectedMarket={selectedMarket} onValueChange={handleMarketChange} />

					<Skeleton name="market-price" loading={isLoading}>
						<div className="text-right">
							<div
								className={cn(
									"text-sm font-semibold tabular-nums",
									change24h !== null ? getValueColorClass(change24h) : "text-fg",
								)}
							>
								{formatUSD(markPx ?? null)}
							</div>
							{typeof change24h === "number" && (
								<div className={cn("text-xs tabular-nums", getValueColorClass(change24h))}>
									{change24h >= 0 ? "+" : ""}
									{change24h.toFixed(2)}%
								</div>
							)}
						</div>
					</Skeleton>
				</div>
			</div>

			<div className="shrink-0 px-3 py-1.5 border-b border-stroke-weak/40 bg-background overflow-x-auto">
				<Skeleton name="market-stats" loading={isLoading}>
					<div className="flex items-center gap-4 text-xs min-w-max">
						<StatPill label={overviewText.LABEL_ORACLE} value={formatUSD(selectedMarket?.oraclePx)} />
						<StatPill
							label={overviewText.LABEL_VOLUME}
							value={formatUSD(selectedMarket?.dayNtlVlm, {
								notation: "compact",
								compactDisplay: "short",
							})}
						/>
						<StatPill
							label={overviewText.LABEL_OPEN_INTEREST}
							value={formatUSD(oiUsd, {
								notation: "compact",
								compactDisplay: "short",
							})}
						/>
						<div className="flex items-center gap-1">
							<FireIcon className={cn("size-3", getValueColorClass(fundingNum))} />
							<span className={cn("tabular-nums font-medium", getValueColorClass(fundingNum))}>
								{formatPercent(fundingNum, {
									minimumFractionDigits: 4,
									signDisplay: "exceptZero",
								})}
							</span>
						</div>
					</div>
				</Skeleton>
			</div>

			<div className="flex-1 min-h-0">
				<ClientOnly
					fallback={
						<div className="h-full flex items-center justify-center">
							<ChartSkeleton />
						</div>
					}
				>
					<Suspense fallback={<ChartSkeleton />}>
						{selectedMarket &&
							(chartType === "tradingview" ? (
								<TradingViewChart
									symbol={chartSymbolFromMarket(selectedMarket.name, getPositionDex(selectedMarket))}
									positionDex={getPositionDex(selectedMarket)}
									theme={theme === "dark" ? "dark" : "light"}
									onSwitchToDefault={() => setChartType("default")}
									onLoadError={() => setChartType("default")}
								/>
							) : (
								<KlineChart
									symbol={chartSymbolFromMarket(selectedMarket.name, getPositionDex(selectedMarket))}
									positionDex={getPositionDex(selectedMarket)}
									theme={theme === "dark" ? "dark" : "light"}
									yAxisInside
								/>
							))}
					</Suspense>
				</ClientOnly>
			</div>

			<MobileBottomNavSpacer />
		</div>
	);
}

function StatPill({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex items-center gap-1.5">
			<span className="text-fg-muted text-xs">{label}</span>
			<span className="tabular-nums text-fg text-xs">{value}</span>
		</div>
	);
}

function ChartSkeleton() {
	return <div className="w-full h-full animate-pulse bg-surface" />;
}
