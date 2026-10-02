import { t } from "@lingui/core/macro";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useOrderTifStatus } from "@/hooks/trade/use-order-tif-status";
import { type ChartOrderMode, canSwitchOrderTif, useReplaceOrderTif } from "@/hooks/trade/use-replace-order-tif";
import { noteChartOverlayInteraction } from "@/lib/chart/overlay-interaction";
import { cn } from "@/lib/cn";
import type { OpenOrder } from "@/lib/trade/open-orders";

export interface TifMenuAnchor {
	order: OpenOrder;
	/** Viewport coordinates of the tap that opened the menu. */
	x: number;
	y: number;
}

/**
 * Type menu for a resting order, shown on the klinecharts canvas.
 *
 * klinecharts draws order labels onto the canvas, so the tappable cell is a label
 * segment (see use-kline-order-overlays) and the menu itself is a DOM popup portalled
 * to the body — the canvas cannot host it, and the chart's own container clips
 * anything drawn over the plot.
 */
export function OrderTifMenu({
	anchor,
	onClose,
	onPick,
}: {
	anchor: TifMenuAnchor | null;
	onClose: () => void;
	/** The chart owns the replace so it can redraw its canvas labels. */
	onPick: (tif: ChartOrderMode) => void;
}) {
	const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
	const menuRef = useRef<HTMLSpanElement | null>(null);
	const { tif, pending, moving } = useOrderTifStatus(anchor?.order);
	const { optionsForOrder } = useReplaceOrderTif();

	useLayoutEffect(() => {
		if (!anchor) {
			setPosition(null);
			return;
		}
		// Flip above/below the tap so the menu never runs off the bottom of a phone.
		const rect = menuRef.current?.getBoundingClientRect();
		if (!rect) return;
		const flip = anchor.y + rect.height + 16 > window.innerHeight;
		setPosition({
			top: Math.max(
				8,
				Math.min(flip ? anchor.y - rect.height - 8 : anchor.y + 8, window.innerHeight - rect.height - 8),
			),
			left: Math.max(8, Math.min(anchor.x, window.innerWidth - rect.width - 8)),
		});
	}, [anchor]);

	useEffect(() => {
		if (!anchor) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		window.addEventListener("resize", onClose);
		return () => {
			window.removeEventListener("keydown", onKey);
			window.removeEventListener("resize", onClose);
		};
	}, [anchor, onClose]);

	if (!anchor || !canSwitchOrderTif(anchor.order)) return null;

	return createPortal(
		<>
			<button type="button" aria-label={t`Close`} className="fixed inset-0 z-40 cursor-default" onClick={onClose} />
			<span
				ref={menuRef}
				role="menu"
				className="fixed z-50 flex w-52 flex-col overflow-hidden rounded-xs border border-stroke-weak bg-surface shadow-overlay"
				style={{ top: position?.top ?? anchor.y + 8, left: position?.left ?? anchor.x }}
			>
				{optionsForOrder(anchor.order).map((option) => (
					<button
						key={option.value}
						type="button"
						role="menuitem"
						disabled={pending !== undefined || moving}
						className={cn(
							"px-3 py-1.5 text-left text-2xs hover:bg-fill-hover",
							tif === option.value && "font-semibold text-brand",
						)}
						onClick={() => {
							noteChartOverlayInteraction();
							onPick(option.value);
							onClose();
						}}
					>
						{option.label}
					</button>
				))}
				<span className="border-t border-stroke-weak px-3 py-2 text-2xs text-fg-muted">
					{optionsForOrder(anchor.order).some((option) => option.value === "TriggerMarket")
						? t`PO/GTC are active reduce-only limits at this price with a fixed size. GTC may fill immediately; PO may reject. Trigger Market restores TP/SL at this price. Failed replacement leaves the original canceled.`
						: t`Verified Post Only drags modify; GTC drags/type changes cancel/repost with a new ID. Failed reposts leave the original canceled. Moving… is unconfirmed.`}
				</span>
			</span>
		</>,
		document.body,
	);
}
