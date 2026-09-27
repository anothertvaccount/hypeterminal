import { HL_ALL_DEXS } from "@/config/app";
import { useOrderQueueToasts } from "@/hooks/trade/use-order-queue-toasts";
import { cn } from "@/lib/cn";
import { useSubscription, useTradingSession, useUserPositions } from "@/lib/hyperliquid";
import { toNumber } from "@/lib/trade/numbers";
import { useGlobalSettingsActions, useMobileActiveTab } from "@/stores/use-global-settings-store";
import { MobileAccountView } from "./mobile-account-view";
import { MobileBookView } from "./mobile-book-view";
import { MobileBottomNav, type MobileTab } from "./mobile-bottom-nav";
import { MobileChartView } from "./mobile-chart-view";
import { MobileHeader } from "./mobile-header";
import { MobilePositionsView } from "./mobile-positions-view";
import { MobileTradeView } from "./mobile-trade-view";
import { OfflineBanner } from "./offline-banner";

interface Props {
	className?: string;
}

export function MobileTerminal({ className }: Props) {
	// The phone has no order queue panel, so submit outcomes are announced here.
	useOrderQueueToasts();

	const activeTab = useMobileActiveTab() as MobileTab;
	const { setMobileActiveTab } = useGlobalSettingsActions();
	const { address, isActive } = useTradingSession();
	const { positions } = useUserPositions();

	const { data: ordersEvent } = useSubscription(
		"openOrders",
		{ user: address ?? "0x0", dex: HL_ALL_DEXS },
		{ enabled: isActive },
	);

	const positionsCount = isActive
		? positions.reduce((count, entry) => (toNumber(entry.szi) ? count + 1 : count), 0)
		: 0;

	const ordersCount = isActive ? (ordersEvent?.orders?.length ?? 0) : 0;

	return (
		<div className={cn("h-dvh w-full flex flex-col bg-background text-fg font-sans", "overflow-hidden", className)}>
			<MobileHeader />
			<OfflineBanner />
			<main className="flex-1 min-h-0 flex flex-col overflow-hidden">
				{activeTab === "chart" && <MobileChartView />}
				{activeTab === "book" && <MobileBookView />}
				{/* The order form stays MOUNTED while another section is open (just
				    hidden). Chase Close, chart price picks and hotkeys submit through the
				    form, so unmounting it meant those gestures had to yank the user to
				    the Trade tab first — on desktop the panel is always on screen and
				    the action just runs. Mounted-and-hidden gives the phone the same
				    behaviour without a navigation. */}
				{/* The order form stays mounted while another section is open, just
				    off-screen. CHART PRICE PICKS and hotkeys submit through the form, and
				    on the phone the form only lives on the Trade tab, so without this a
				    tap-to-order on the chart tab would have nothing to submit. Off-screen
				    (NOT display:none, which breaks the number field and its validation)
				    plus `inert`: mounted and measurable, invisible, untappable. Chase
				    Close does NOT use this — it places its own order and never navigates. */}
				<div
					aria-hidden={activeTab !== "trade" || undefined}
					inert={activeTab !== "trade" ? true : undefined}
					className={cn(
						"min-h-0 flex-1 flex flex-col overflow-hidden",
						activeTab !== "trade" && "h-0 w-0 overflow-hidden opacity-0 pointer-events-none absolute",
					)}
				>
					<MobileTradeView />
				</div>
				{activeTab === "positions" && <MobilePositionsView />}
				{activeTab === "account" && <MobileAccountView />}
			</main>
			<MobileBottomNav
				activeTab={activeTab}
				onTabChange={setMobileActiveTab}
				badges={{ positions: positionsCount + ordersCount }}
			/>
		</div>
	);
}
