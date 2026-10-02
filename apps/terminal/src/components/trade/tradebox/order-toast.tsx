import { Button } from "@hypeterminal/ui";
import { t } from "@lingui/core/macro";
import { CheckIcon, LightningIcon, SpinnerGapIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ORDER_TOAST_DISMISS_MS, ORDER_TOAST_SUCCESS_DURATION_MS } from "@/config/time";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/cn";
import type { OrderOutcome } from "@/lib/trade/extract-order-status";
import { type OrderQueueItem, useOrderQueue, useOrderQueueActions } from "@/stores/use-order-queue-store";

const ORDER_TOAST_WIDTH = "w-80";
const ORDER_TOAST_LIST_MAX_HEIGHT = "max-h-72";

function useAutoRemove(order: OrderQueueItem, onRemove: () => void) {
	useEffect(() => {
		if (order.status !== "success" || !order.completedAt) return;

		const elapsed = Date.now() - order.completedAt;
		const remaining = ORDER_TOAST_SUCCESS_DURATION_MS - elapsed;

		if (remaining <= 0) {
			onRemove();
			return;
		}

		const timer = setTimeout(onRemove, remaining);
		return () => clearTimeout(timer);
	}, [order.status, order.completedAt, onRemove]);
}

function getOrderTypeLabel(orderType: OrderQueueItem["orderType"]): string | null {
	switch (orderType) {
		case "trigger":
			return "Trigger";
		case "scale":
			return "Scale";
		case "twap":
			return "TWAP";
		default:
			return null;
	}
}

function getOutcomeLabel(outcome: OrderOutcome): string {
	switch (outcome) {
		case "filled":
			return t`Filled`;
		case "resting":
			return t`Placed`;
		case "triggerSet":
			return t`Set`;
		case "twapStarted":
			return t`Running`;
	}
}

function OrderItem({ order, onRemove }: { order: OrderQueueItem; onRemove: () => void }) {
	useAutoRemove(order, onRemove);

	const sideColor = order.side === "buy" ? "text-success" : "text-error";
	const sideBg = order.side === "buy" ? "bg-success-soft" : "bg-error-soft";
	const orderTypeLabel = getOrderTypeLabel(order.orderType);
	const hasTpSl = order.tpPrice || order.slPrice;

	return (
		<div
			className={cn(
				"flex gap-3 py-2.5 px-3 transition-[opacity,transform] duration-300",
				order.status === "pending" && "animate-pulse",
			)}
		>
			<div
				className={cn(
					"flex items-center justify-center size-7 rounded-8 shrink-0",
					order.status === "pending" && "bg-brand-soft border border-stroke-brand-strong/30",
					order.status === "success" && "bg-success-soft border border-stroke-success-strong/30",
					order.status === "failed" && "bg-error-soft border border-stroke-error-strong/30",
				)}
			>
				{order.status === "pending" && <SpinnerGapIcon className="size-4 animate-spin text-brand" />}
				{order.status === "success" && <CheckIcon className="size-4 text-success" />}
				{order.status === "failed" && <XIcon className="size-4 text-error" />}
			</div>

			<div className="flex-1 min-w-0 space-y-0.5">
				<div className="flex items-center gap-2">
					{orderTypeLabel && (
						<span className="px-1.5 py-0.5 rounded text-xs font-bold uppercase tracking-wide bg-surface text-fg-muted">
							{orderTypeLabel}
						</span>
					)}
					<span className={cn("px-1.5 py-0.5 rounded text-xs font-bold uppercase tracking-wide", sideBg, sideColor)}>
						{order.side}
					</span>
					<span className="text-xs font-medium text-fg">{order.market}</span>
					{order.status === "success" && order.outcome && (
						<span className={cn("text-xs font-medium", order.outcome === "filled" ? "text-success" : "text-fg-muted")}>
							{getOutcomeLabel(order.outcome)}
						</span>
					)}
				</div>
				<div className="text-xs text-fg-muted flex items-center gap-2 flex-wrap">
					<span>
						{t`Size`}: <span className="text-fg font-medium">{order.size}</span>
					</span>
					{order.price && (
						<span>
							@ <span className="text-fg font-medium">{order.price}</span>
						</span>
					)}
				</div>
				{hasTpSl && (
					<div className="text-xs text-fg-muted flex items-center gap-2">
						{order.tpPrice && (
							<span>
								TP: <span className="text-success font-medium">{order.tpPrice}</span>
							</span>
						)}
						{order.slPrice && (
							<span>
								SL: <span className="text-error font-medium">{order.slPrice}</span>
							</span>
						)}
					</div>
				)}
				{order.error && <div className="text-xs text-error">{order.error}</div>}
			</div>

			{order.status === "failed" && (
				<Button
					variant="ghost"
					intent="neutral"
					onClick={onRemove}
					className="p-1.5 rounded-8 text-fg-muted hover:text-fg hover:bg-fill-hover transition-colors shrink-0 self-start"
					aria-label={t`Dismiss`}
				>
					<XIcon className="size-4" />
				</Button>
			)}
		</div>
	);
}

function CountdownBar({ order }: { order: OrderQueueItem }) {
	if (order.status !== "success") return null;

	return (
		<div className="absolute bottom-0 left-0 right-0 h-0.5 bg-success-soft overflow-hidden">
			<div
				className="h-full bg-success/60 animate-countdown"
				style={{ animationDuration: `${ORDER_TOAST_SUCCESS_DURATION_MS}ms` }}
			/>
		</div>
	);
}

export function OrderToast() {
	const isMobile = useIsMobile();
	const orders = useOrderQueue();
	const { removeOrder } = useOrderQueueActions();
	const [dismissed, setDismissed] = useState(false);
	const newestId = orders[orders.length - 1]?.id;

	// A NEW order always brings the queue back. Compared against the last id we saw so
	// the effect genuinely depends on it (a new row, not a re-render, un-dismisses).
	const lastNewestIdRef = useRef<string | undefined>(undefined);
	useEffect(() => {
		if (lastNewestIdRef.current === newestId) return;
		lastNewestIdRef.current = newestId;
		setDismissed(false);
	}, [newestId, lastNewestIdRef]);

	// …then it hides itself after ORDER_TOAST_DISMISS_MS of quiet (or instantly on
	// the manual close). Updates/removals of existing rows re-arm the timer but do
	// not resurrect a dismissed box.
	useEffect(() => {
		if (dismissed || orders.length === 0) return;
		const ms = import.meta.env.DEV
			? ((globalThis as { __hlOrderToastDismissMs?: number }).__hlOrderToastDismissMs ?? ORDER_TOAST_DISMISS_MS)
			: ORDER_TOAST_DISMISS_MS;
		const timer = setTimeout(() => setDismissed(true), ms);
		return () => clearTimeout(timer);
	}, [orders, dismissed]);

	if (dismissed || orders.length === 0 || typeof document === "undefined") return null;

	const pendingCount = orders.filter((o) => o.status === "pending").length;
	const successCount = orders.filter((o) => o.status === "success").length;
	const failedCount = orders.filter((o) => o.status === "failed").length;

	// Escape the fixed sidebar's stacking context so the book cannot cover the queue.
	return createPortal(
		<div
			className={cn(
				// Phone: the panel is docked to the TOP, full width. It used to sit
				// bottom-right, where it collided with the toasts (same corner, same
				// 20rem width) and covered the bottom nav. Top vs bottom-centre keeps
				// the two surfaces apart and leaves the nav tappable.
				isMobile
					? "inset-x-2 top-[3.25rem] w-auto max-h-[32vh] overflow-y-auto"
					: cn(ORDER_TOAST_WIDTH, "bottom-6 right-6"),
				"fixed z-50",
				"bg-surface/95 backdrop-blur-sm",
				"border border-stroke-weak/60 rounded-8 overflow-hidden",
				"shadow-overlay shadow-black/20 dark:shadow-black/50",
				"font-sans",

				pendingCount > 0 && "ring-1 ring-stroke-brand-strong/30",
				failedCount > 0 && pendingCount === 0 && "ring-1 ring-stroke-error-strong/30",
				successCount > 0 && pendingCount === 0 && failedCount === 0 && "ring-1 ring-stroke-success-strong/30",
			)}
		>
			<div className="px-3 py-2 border-b border-stroke-weak/40 bg-surface flex items-center justify-between">
				<div className="flex items-center gap-2">
					<LightningIcon className="size-4 text-brand" />
					<span className="text-xs font-semibold uppercase tracking-wider text-fg">{t`Order Queue`}</span>
				</div>
				<div className="flex items-center gap-1.5">
					{pendingCount > 0 && (
						<span className="px-1.5 py-0.5 rounded text-xs font-medium bg-brand-soft text-brand border border-stroke-brand-strong/30">
							{pendingCount} {t`pending`}
						</span>
					)}
					{failedCount > 0 && (
						<span className="px-1.5 py-0.5 rounded text-xs font-medium bg-error-soft text-error border border-stroke-error-strong/30">
							{failedCount} {t`failed`}
						</span>
					)}
					<button
						type="button"
						aria-label={t`Dismiss order queue`}
						onClick={() => setDismissed(true)}
						className="p-1 rounded text-fg-muted hover:text-fg hover:bg-fill-hover transition-colors cursor-pointer"
					>
						<XIcon className="size-3.5" />
					</button>
				</div>
			</div>

			<div className={cn("divide-y divide-stroke-weak/30 overflow-y-auto", ORDER_TOAST_LIST_MAX_HEIGHT)}>
				{orders.map((order) => (
					<div key={order.id} className="relative">
						<OrderItem order={order} onRemove={() => removeOrder(order.id)} />
						<CountdownBar order={order} />
					</div>
				))}
			</div>
		</div>,
		document.body,
	);
}
