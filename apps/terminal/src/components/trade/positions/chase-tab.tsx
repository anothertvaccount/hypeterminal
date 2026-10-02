import { useEffect, useState } from "react";

import { HL_ALL_DEXS } from "@/config/app";
import { PAPER_TRADE } from "@/config/paper";
import { ORDER_MIN_NOTIONAL_USD } from "@/config/trade";
import { CHASE_TIMEOUT_MS, findActiveChaseOrder } from "@/domain/trade/order/chase";
import { cn } from "@/lib/cn";
import { formatDateTime } from "@/lib/format";
import { useSubscription, useTradingSession } from "@/lib/hyperliquid";
import type { OpenOrder } from "@/lib/trade/open-orders";
import {
	type ChaseHistoryRecord,
	useChaseEntry,
	useChaseHistory,
	useChaseOrderActions,
} from "@/stores/use-chase-order-store";
import { useMarketOrderSlippagePercent } from "@/stores/use-global-settings-store";
import { usePaperOpenOrderRows } from "@/stores/use-paper-store";

const OUTCOME_STYLES: Record<string, string> = {
	filled: "bg-success-soft text-success",
	cancelled: "text-fg-muted border border-stroke-weak",
	completed: "text-fg border border-stroke-weak",
	timeout: "bg-warning-soft text-warning",
	error: "bg-error-soft text-error",
};

function outcomeLabel(outcome: string): string {
	switch (outcome) {
		case "filled":
			return "Filled";
		case "cancelled":
			return "Cancelled";
		case "timeout":
			return "Timed out";
		case "error":
			return "Failed";
		default:
			return "Completed";
	}
}

function formatDuration(ms: number): string {
	return `${Math.max(0, Math.round(ms / 1000))}s`;
}

/**
 * Chase tab (desktop + mobile): the live chase order's status up top, then the
 * persisted history of finished chases (filled / timed out / cancelled / failed).
 */
export function ChaseTab() {
	const entry = useChaseEntry();
	const history = useChaseHistory();
	const { clear, clearHistory } = useChaseOrderActions();
	const { address, isActive } = useTradingSession();
	const paperRows = usePaperOpenOrderRows();
	const [now, setNow] = useState(() => Date.now());
	const marketSlippagePercent = useMarketOrderSlippagePercent();

	// Tick once a second while a chase is running (mounted tab only).
	useEffect(() => {
		if (!entry) return;
		const id = setInterval(() => setNow(Date.now()), 1_000);
		return () => clearInterval(id);
	}, [entry]);

	// The resting order the active chase is managing (price / liveness).
	const { data: openOrdersEvent } = useSubscription(
		"openOrders",
		{ user: address ?? "0x0", dex: HL_ALL_DEXS },
		{ enabled: !PAPER_TRADE && isActive && entry !== null },
	);
	const orders: OpenOrder[] = PAPER_TRADE ? paperRows : (openOrdersEvent?.orders ?? []);
	const activeOrder = entry ? findActiveChaseOrder(orders, entry) : undefined;
	const restingDustTail =
		entry?.mode === "close" &&
		activeOrder &&
		Number(activeOrder.sz) * Number(activeOrder.limitPx) < ORDER_MIN_NOTIONAL_USD;

	const elapsed = entry ? Math.max(0, now - entry.startedAt) : 0;
	const progress = Math.min(100, (elapsed / CHASE_TIMEOUT_MS) * 100);

	return (
		<div className="flex-1 min-h-0 overflow-y-auto">
			<div className="p-3 space-y-4">
				<section className="space-y-2">
					<h3 className="text-2xs font-semibold uppercase tracking-wider text-fg-muted">Active chase</h3>
					{!entry ? (
						<p className="text-xs text-fg-muted">No chase order running.</p>
					) : (
						<div className="border border-stroke-weak rounded-xs bg-background p-3 space-y-2">
							<div className="flex flex-wrap items-center gap-2 text-xs">
								<span
									className={cn(
										"px-1.5 py-0.5 rounded-xs text-2xs font-bold uppercase",
										entry.side === "buy" ? "bg-success-soft text-success" : "bg-error-soft text-error",
									)}
								>
									{entry.side}
								</span>
								<span className="font-semibold text-fg">{entry.coin}</span>
								<span className="text-fg-muted tabular-nums">{entry.sizeText}</span>
								{entry.reduceOnly && (
									<span className="text-2xs border border-stroke-weak rounded-xs px-1 text-fg-muted">RO</span>
								)}
								<span className="ml-auto text-2xs tabular-nums text-fg-muted">
									{activeOrder ? `at ${activeOrder.limitPx}` : "checking order…"}
								</span>
							</div>
							<div className="h-1 rounded-full bg-fill-hover overflow-hidden">
								<div
									className={cn(
										"h-full transition-all",
										entry.mode !== "close" && elapsed >= CHASE_TIMEOUT_MS ? "bg-error" : "bg-brand",
									)}
									style={{ width: `${entry.mode === "close" ? 100 : progress}%` }}
								/>
							</div>
							<div className="flex justify-between text-2xs text-fg-muted tabular-nums">
								<span>re-prices every 750ms to stay at the {entry.side === "buy" ? "best bid" : "best ask"}</span>
								<span>
									{formatDateTime(new Date(entry.startedAt))} · {formatDuration(elapsed)}
									{entry.mode === "close" ? " · until position closes" : ` / ${formatDuration(CHASE_TIMEOUT_MS)}`}
								</span>
							</div>
							{!activeOrder && (
								<p className="text-2xs text-fg-muted">
									{entry.mode === "close"
										? "Checking the order and remaining position — closing will resume when confirmed."
										: "Waiting for the latest order update."}
								</p>
							)}
							{restingDustTail && (
								<p className="text-2xs text-warning">
									The remainder is below $10. Chase will cancel the resting order and finish with a reduce-only market
									close using your {marketSlippagePercent}% slippage setting.
								</p>
							)}
							<button type="button" onClick={clear} className="text-2xs text-error hover:underline">
								Stop Chase
							</button>
						</div>
					)}
				</section>

				<section className="space-y-2">
					<div className="flex items-center justify-between">
						<h3 className="text-2xs font-semibold uppercase tracking-wider text-fg-muted">History</h3>
						{history.length > 0 && (
							<button
								type="button"
								onClick={clearHistory}
								className="text-2xs text-fg-muted hover:text-fg transition-colors cursor-pointer"
							>
								Clear
							</button>
						)}
					</div>
					{history.length === 0 ? (
						<p className="text-xs text-fg-muted">
							Completed chase orders (filled, timed out, or cancelled) appear here — persisted across refreshes.
						</p>
					) : (
						<div className="border border-stroke-weak rounded-xs overflow-hidden">
							{history.slice(0, 50).map((record: ChaseHistoryRecord) => (
								<div
									key={record.id}
									className="flex items-center gap-2 border-b border-stroke-weak/60 px-3 py-1.5 text-xs last:border-b-0"
								>
									<span className="w-28 shrink-0 text-fg-muted tabular-nums">
										{formatDateTime(new Date(record.endedAt))}
									</span>
									<span className="font-semibold text-fg">{record.coin}</span>
									<span
										className={cn(
											"px-1 py-0.5 rounded-xs text-2xs font-bold uppercase",
											record.side === "buy" ? "bg-success-soft text-success" : "bg-error-soft text-error",
										)}
									>
										{record.side}
									</span>
									<span className="text-fg-muted tabular-nums">{record.size}</span>
									{record.reduceOnly && (
										<span className="text-2xs border border-stroke-weak rounded-xs px-1 text-fg-muted">RO</span>
									)}
									<span className="text-fg-muted tabular-nums">
										{formatDuration(record.endedAt - record.startedAt)}
									</span>
									{record.price && <span className="text-fg-muted tabular-nums">@ {record.price}</span>}
									<span
										className={cn(
											"ml-auto px-1.5 py-0.5 rounded-xs text-2xs font-semibold",
											OUTCOME_STYLES[record.outcome] ?? "text-fg-muted",
										)}
									>
										{outcomeLabel(record.outcome)}
									</span>
								</div>
							))}
						</div>
					)}
				</section>
			</div>
		</div>
	);
}
