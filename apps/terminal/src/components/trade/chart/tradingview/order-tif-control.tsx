import { t } from "@lingui/core/macro";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useOrderTifStatus } from "@/hooks/trade/use-order-tif-status";
import { canSwitchOrderTif, tifLabel, useReplaceOrderTif } from "@/hooks/trade/use-replace-order-tif";
import { useIsMobile } from "@/hooks/use-mobile";
import { noteChartOverlayInteraction } from "@/lib/chart/overlay-interaction";
import { cn } from "@/lib/cn";
import type { OpenOrder } from "@/lib/trade/open-orders";

/**
 * Order-type control for a resting order, immediately left of its label.
 * The label's ✕ cancel stays on the right.
 *
 * Limits offer Post Only and GTC. Reduce-only TP/SL market triggers offer
 * active Post Only/GTC limits and a return to Trigger Market at the current price.
 * The exchange assigns a replacement oid; saved TP/SL intent follows it.
 *
 * Two details this had to account for:
 *  - the label row captures pointer events for drag-to-reprice, so the button stops
 *    propagation on pointerdown; otherwise the row eats the tap;
 *  - the row clips its overflow, so the menu is portalled to the body and positioned
 *    against the button.
 */
export function OrderTifControl({ order, className }: { order?: OpenOrder; className?: string }) {
	const isMobile = useIsMobile();
	const [anchor, setAnchor] = useState<{ top: number; bottom: number; left: number } | null>(null);
	const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
	const menuRef = useRef<HTMLSpanElement | null>(null);
	const buttonRef = useRef<HTMLButtonElement | null>(null);
	const { replaceOrderTif, optionsForOrder } = useReplaceOrderTif();
	const { tif, pending, error, moving } = useOrderTifStatus(order);
	const open = anchor !== null;

	useLayoutEffect(() => {
		const rect = menuRef.current?.getBoundingClientRect();
		if (!anchor || !rect) return;
		const flip = anchor.bottom + rect.height + 12 > window.innerHeight;
		setPosition({
			top: Math.max(
				8,
				Math.min(flip ? anchor.top - rect.height - 4 : anchor.bottom + 4, window.innerHeight - rect.height - 8),
			),
			left: Math.max(8, Math.min(anchor.left, window.innerWidth - rect.width - 8)),
		});
	}, [anchor]);

	useEffect(() => {
		if (!open) return;
		const close = () => setAnchor(null);
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") close();
		};
		window.addEventListener("keydown", onKey);
		window.addEventListener("resize", close);
		return () => {
			window.removeEventListener("keydown", onKey);
			window.removeEventListener("resize", close);
		};
	}, [open]);

	if (!order || !canSwitchOrderTif(order)) return null;

	function toggle() {
		noteChartOverlayInteraction();
		if (anchor) {
			setAnchor(null);
			return;
		}
		const rect = buttonRef.current?.getBoundingClientRect();
		if (!rect) return;
		setAnchor({
			top: rect.top,
			bottom: rect.bottom,
			left: rect.left,
		});
	}

	return (
		<>
			<span className={cn("flex shrink-0 items-center pr-1.5", className)} data-tv-tif="">
				<button
					ref={buttonRef}
					type="button"
					aria-label={t`Change order type`}
					aria-expanded={open}
					aria-busy={pending !== undefined || moving}
					disabled={pending !== undefined || moving}
					title={error}
					onPointerDown={(event) => {
						// The row drag would otherwise consume this press.
						event.stopPropagation();
					}}
					onClick={toggle}
					className={cn(
						"shrink-0 whitespace-nowrap rounded-xs border bg-surface/95 px-1.5 py-0.5 text-2xs font-semibold tabular-nums backdrop-blur-sm",
						"hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stroke-focus",
						tif === "Alo" && "border-brand-strong/50 text-brand",
						tif === "Ioc" && "border-warning-strong/50 text-warning",
						tif === "Gtc" && "border-stroke-weak text-fg-muted",
						error && "border-stroke-error-strong text-error",
					)}
				>
					{tifLabel(tif, isMobile)}
					{pending ? "…" : error ? " !" : ""}
				</button>
			</span>
			{open &&
				anchor &&
				createPortal(
					<>
						<button
							type="button"
							aria-label={t`Close`}
							className="fixed inset-0 z-40 cursor-default"
							onPointerDown={(event) => event.stopPropagation()}
							onClick={(event) => {
								event.stopPropagation();
								setAnchor(null);
							}}
						/>
						<span
							ref={menuRef}
							role="menu"
							// Portal events still bubble through the chart row in React. Without
							// this, it starts a drag and captures the pointer before the pick clicks.
							onPointerDown={(event) => event.stopPropagation()}
							onPointerUp={(event) => event.stopPropagation()}
							className="fixed z-50 flex w-52 flex-col overflow-hidden rounded-xs border border-stroke-weak bg-surface shadow-overlay"
							style={{ top: position?.top ?? anchor.bottom + 4, left: position?.left ?? anchor.left }}
						>
							{optionsForOrder(order).map((option) => (
								<button
									key={option.value}
									type="button"
									role="menuitem"
									className={cn(
										"px-3 py-1.5 text-left text-2xs hover:bg-fill-hover",
										tif === option.value && "font-semibold text-brand",
									)}
									onClick={(event) => {
										event.stopPropagation();
										noteChartOverlayInteraction();
										replaceOrderTif(order, option.value);
										setAnchor(null);
									}}
								>
									{option.label}
								</button>
							))}
							<span className="border-t border-stroke-weak px-3 py-2 text-2xs text-fg-muted">
								{optionsForOrder(order).some((option) => option.value === "TriggerMarket")
									? t`PO/GTC are active reduce-only limits at this price with a fixed size. GTC may fill immediately; PO may reject. Trigger Market restores TP/SL at this price. Failed replacement leaves the original canceled.`
									: t`Verified Post Only drags modify; GTC drags/type changes cancel/repost with a new ID. Failed reposts leave the original canceled. Moving… is unconfirmed.`}
							</span>
						</span>
					</>,
					document.body,
				)}
		</>
	);
}
