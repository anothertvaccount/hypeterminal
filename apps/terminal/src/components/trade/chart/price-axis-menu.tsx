import { PlusIcon } from "@phosphor-icons/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { usePlaceTpSl } from "@/hooks/trade/use-place-tpsl";
import { isChartOverlayInteractionRecent } from "@/lib/chart/overlay-interaction";
import {
	AXIS_MENU_ITEMS,
	type AxisMenuItem,
	type AxisRect,
	CROSS_HOVER_EXTENSION,
	clampAxisY,
	getCrossLeft,
	getMenuRightOffset,
	isOnPriceAxis,
	resolveAxisPrice,
	TPSL_PERCENTAGES,
	type WrapperRect,
} from "@/lib/chart/price-axis";
import { cn } from "@/lib/cn";
import { getHeldChartAction } from "@/lib/hotkeys/hold-keys";
import { useMarkets, useUserPositions } from "@/lib/hyperliquid";
import { useGlobalSettingsActions } from "@/stores/use-global-settings-store";
import { useOrderEntryActions, useOrderType, useScaleChartPickTarget } from "@/stores/use-order-entry-store";

const CROSS_MARGIN = 10;
/** A press must stay within this drift to count as a plot click (vs a pan/drag). */
const SCALE_PICK_MAX_DRIFT_PX = 4;
const MENU_MARGIN = 64;

interface AxisTarget {
	/** Pointer y relative to the wrapper, clamped so the cross stays inside the chart. */
	y: number;
	priceText: string;
	crossLeft: number;
	menuTop: number;
	menuRight: number;
}

/**
 * Chart-agnostic price-axis hooks: the kline adapter reads the wrapper's DOM axis +
 * convertFromPixel, the TradingView adapter reads the widget's measured axis and
 * visible-price-range fit — the menu UI/geometry is identical on both canvases.
 */
export interface AxisMenuAdapter {
	/** Axis bounding rect in viewport coordinates, or null while the chart can't answer. */
	getAxisRect(): AxisRect | null;
	/** Raw price at a wrapper-relative y, or null when unconvertible. */
	priceAt(yWrapper: number): number | null;
}

interface Props {
	adapter: AxisMenuAdapter;
	children: ReactNode;
	symbol?: string;
	dex?: string;
}

/**
 * Price-axis trading: hovering the y-axis shows a small cross just inside the pane
 * (next to the axis border, so axis drag-to-scale/zoom stays untouched); clicking it
 * opens a menu whose entries prefill a Limit Buy/Sell at that exact price — or place
 * a Take-Profit / Stop-Loss for a chosen percentage of the open position there.
 * The menu anchors in place while open and dismisses on outside click, Escape, or
 * leaving the chart.
 */
export function PriceAxisMenu({ adapter, children, symbol, dex }: Props) {
	const wrapperRef = useRef<HTMLDivElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const crossRef = useRef<HTMLButtonElement>(null);
	const [target, setTarget] = useState<AxisTarget | null>(null);
	const targetRef = useRef<AxisTarget | null>(null);
	targetRef.current = target;
	const [menuOpen, setMenuOpen] = useState(false);
	const menuOpenedAtRef = useRef(0);
	const {
		setLimitPrice,
		setOrderType,
		setReduceOnly,
		setSide,
		setTpSlEnabled,
		setScaleStart,
		setScaleEnd,
		setScaleChartPickTarget,
	} = useOrderEntryActions();
	const orderType = useOrderType();
	const scaleChartPickTarget = useScaleChartPickTarget();
	const { setMobileActiveTab } = useGlobalSettingsActions();
	const placeTpSl = usePlaceTpSl();
	const { getPosition } = useUserPositions();
	const markets = useMarkets();
	const position = symbol
		? (getPosition(symbol, dex) ??
			getPosition(symbol.includes(":") ? symbol.slice(symbol.indexOf(":") + 1) : symbol, dex))
		: null;
	const hasPosition = position !== null && Number(position.szi) !== 0;

	// The chart is rebuilt on symbol change — drop hover state tied to the old price scale.
	// biome-ignore lint/correctness/useExhaustiveDependencies: clearing hover state must run on symbol change
	useEffect(() => {
		setTarget(null);
		setMenuOpen(false);
	}, [symbol]);

	// Hover tracking + menu dismissal. Native listeners on the wrapper catch mouse events
	// bubbling up from the chart's canvas; outside clicks (except on the menu/cross) and
	// Escape close the menu.
	useEffect(() => {
		const wrapper = wrapperRef.current;
		if (!wrapper) return;

		const updateTarget = (clientX: number, clientY: number) => {
			try {
				const axis = adapter.getAxisRect();
				if (!axis) {
					setTarget(null);
					return;
				}
				const wrapperRect = wrapper.getBoundingClientRect();
				if (!isOnPriceAxis(clientX, clientY, axis, CROSS_HOVER_EXTENSION)) {
					// Grace: the cross sits on the pane side of the axis border - keep the
					// target alive while the pointer travels between the axis and the cross,
					// otherwise it would vanish before it could be clicked.
					const current = targetRef.current;
					if (current) {
						const crossCenterX = wrapperRect.left + current.crossLeft;
						const pointerY = clientY - wrapperRect.top;
						const nearCross =
							clientX >= crossCenterX - 12 && clientX <= axis.right + 2 && Math.abs(pointerY - current.y) <= 14;
						if (nearCross) return;
					}
					setTarget(null);
					return;
				}

				const box: WrapperRect = {
					left: wrapperRect.left,
					top: wrapperRect.top,
					width: wrapperRect.width,
					height: wrapperRect.height,
				};

				const rawPrice = adapter.priceAt(clientY - wrapperRect.top);
				const priceText = resolveAxisPrice(rawPrice ?? Number.NaN);
				if (!priceText) {
					setTarget(null);
					return;
				}

				const rawY = clientY - wrapperRect.top;
				setTarget({
					y: clampAxisY(rawY, box.height, CROSS_MARGIN),
					priceText,
					crossLeft: getCrossLeft(axis, box),
					menuTop: clampAxisY(rawY, box.height, MENU_MARGIN),
					menuRight: getMenuRightOffset(axis, box),
				});
			} catch {
				// Chart is mid-dispose — treat as no hover.
				setTarget(null);
			}
		};

		const handleMouseMove = (event: MouseEvent) => {
			if (menuOpen) return; // freeze the cross/menu anchor while the menu is open
			updateTarget(event.clientX, event.clientY);
		};

		// Touch: a tap/drag on the price axis parks the cross at the touch point
		// (the cross itself is a DOM button, so tapping it opens the menu without
		// needing any synthesized mouse events from the chart canvas).
		const handleTouchPoint = (event: TouchEvent) => {
			if (menuOpen) return;
			const touch = event.touches[0] ?? event.changedTouches[0];
			if (!touch) return;
			updateTarget(touch.clientX, touch.clientY);
		};

		const handleMouseLeave = () => {
			setTarget(null);
			setMenuOpen(false);
		};

		const dismissOutside = (event: EventTarget | null) => {
			// Grace: the tap that OPENS the menu often lands its synthesized mousedown
			// right after the click — ignoring it keeps the menu from closing itself.
			if (Date.now() - menuOpenedAtRef.current < 350) return;
			if (!(event instanceof Node)) return;
			if (menuRef.current?.contains(event) || crossRef.current?.contains(event)) return;
			setMenuOpen(false);
			setTarget(null);
		};
		const handleMouseDown = (event: MouseEvent) => {
			dismissOutside(event.target);
		};
		const handleTouchDismiss = (event: TouchEvent) => {
			dismissOutside(event.target);
		};

		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") setMenuOpen(false);
		};

		wrapper.addEventListener("mousemove", handleMouseMove);
		wrapper.addEventListener("touchstart", handleTouchPoint, { passive: true });
		wrapper.addEventListener("touchmove", handleTouchPoint, { passive: true });
		wrapper.addEventListener("mouseleave", handleMouseLeave);
		if (menuOpen) {
			document.addEventListener("mousedown", handleMouseDown);
			document.addEventListener("touchstart", handleTouchDismiss, { passive: true });
			document.addEventListener("keydown", handleKeyDown);
		}
		return () => {
			wrapper.removeEventListener("mousemove", handleMouseMove);
			wrapper.removeEventListener("touchstart", handleTouchPoint);
			wrapper.removeEventListener("touchmove", handleTouchPoint);
			wrapper.removeEventListener("mouseleave", handleMouseLeave);
			document.removeEventListener("mousedown", handleMouseDown);
			document.removeEventListener("touchstart", handleTouchDismiss);
			document.removeEventListener("keydown", handleKeyDown);
		};
	}, [adapter, menuOpen]);

	// Scale ladder picking: while previewing a scale, a clean click on the PLOT
	// alternates Start ↔ End (the form's hint says which is next). Same guards as
	// the chart-click hotkeys: no held key, no label press, not the axis/menu/cross,
	// drift ≤ SCALE_PICK_MAX_DRIFT_PX (bigger movements are pans and stay pans).
	useEffect(() => {
		const wrapper = wrapperRef.current;
		if (!wrapper) return;
		let down: { x: number; y: number } | null = null;
		const handleDown = (event: MouseEvent) => {
			if (event.button !== 0) return;
			down = { x: event.clientX, y: event.clientY };
		};
		const tryPick = (clientX: number, clientY: number, startX: number, startY: number, target: EventTarget | null) => {
			if (Math.hypot(clientX - startX, clientY - startY) > SCALE_PICK_MAX_DRIFT_PX) return;
			// Scale mode: a clean plot pick always sets Start/End (auto-preview makes
			// the line appear) — no need to arm the Preview button first.
			if (orderType !== "scale" || menuOpen) return;
			if (getHeldChartAction()) return;
			if (isChartOverlayInteractionRecent()) return;
			const node = target;
			if (node instanceof Node && (crossRef.current?.contains(node) || menuRef.current?.contains(node))) return;
			const axis = adapter.getAxisRect();
			if (axis && isOnPriceAxis(clientX, clientY, axis, CROSS_HOVER_EXTENSION)) return;
			const wrapperRect = wrapper.getBoundingClientRect();
			const raw = adapter.priceAt(clientY - wrapperRect.top);
			const priceText = resolveAxisPrice(raw ?? Number.NaN);
			if (!priceText) return;
			if (scaleChartPickTarget === "start") {
				setScaleStart(priceText);
				setScaleChartPickTarget("end");
			} else {
				setScaleEnd(priceText);
				setScaleChartPickTarget("start");
			}
		};
		const handleUp = (event: MouseEvent) => {
			const start = down;
			down = null;
			if (!start) return;
			tryPick(event.clientX, event.clientY, start.x, start.y, event.target);
		};
		let touchStart: { x: number; y: number } | null = null;
		const handleTouchStartPick = (event: TouchEvent) => {
			const t0 = event.touches[0];
			if (!t0 || event.touches.length > 1) return;
			touchStart = { x: t0.clientX, y: t0.clientY };
		};
		const handleTouchEndPick = (event: TouchEvent) => {
			const t0 = event.changedTouches[0];
			const start = touchStart;
			touchStart = null;
			if (!t0 || !start) return;
			tryPick(t0.clientX, t0.clientY, start.x, start.y, event.target);
		};
		wrapper.addEventListener("mousedown", handleDown);
		wrapper.addEventListener("mouseup", handleUp);
		wrapper.addEventListener("touchstart", handleTouchStartPick, { passive: true });
		wrapper.addEventListener("touchend", handleTouchEndPick, { passive: true });
		return () => {
			wrapper.removeEventListener("mousedown", handleDown);
			wrapper.removeEventListener("mouseup", handleUp);
			wrapper.removeEventListener("touchstart", handleTouchStartPick);
			wrapper.removeEventListener("touchend", handleTouchEndPick);
		};
	}, [adapter, orderType, scaleChartPickTarget, menuOpen, setScaleStart, setScaleEnd, setScaleChartPickTarget]);

	function handlePick(item: AxisMenuItem) {
		if (!target) return;
		// Prefill a clean limit order at the picked price (with the default limit size
		// when the size field is empty).
		setOrderType(
			"limit",
			symbol
				? { price: Number(target.priceText), szDecimals: markets.getSzDecimals(symbol) }
				: { price: Number(target.priceText) },
		);
		setSide(item.side);
		setReduceOnly(false);
		setTpSlEnabled(false);
		setLimitPrice(target.priceText);
		setMobileActiveTab("trade");
		setMenuOpen(false);
		setTarget(null);
	}

	function handlePlaceTpSl(tpsl: "tp" | "sl", percent: number) {
		if (!target || !symbol) return;
		const price = Number(target.priceText);
		if (!Number.isFinite(price) || price <= 0) return;
		placeTpSl({ coin: symbol, dex, tpsl, price, sizeFraction: percent / 100 });
		setMenuOpen(false);
		setTarget(null);
	}

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: touching the price axis on a phone must move the cross, not raise the browser's selection/callout menu. Not a control, so it takes no role/tab stop.
		<div
			ref={wrapperRef}
			className="relative flex-1 min-h-0"
			// Touching the price axis on a phone must move the cross, not pop the
			// browser's selection/callout menu.
			style={{ userSelect: "none", WebkitUserSelect: "none", WebkitTouchCallout: "none" }}
			onContextMenu={(event) => event.preventDefault()}
		>
			{children}
			{target && (
				<button
					ref={crossRef}
					type="button"
					title="Set order price"
					aria-label={`Set order price ${target.priceText}`}
					className="absolute z-30 flex size-4 -translate-x-1/2 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full border border-stroke bg-surface text-fg-muted transition-colors hover:border-brand hover:text-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stroke-focus"
					style={{ top: target.y, left: target.crossLeft }}
					onClick={() => {
						if (!menuOpen) menuOpenedAtRef.current = Date.now();
						setMenuOpen(!menuOpen);
					}}
				>
					<PlusIcon className="size-3" />
				</button>
			)}
			{target && menuOpen && (
				<div
					ref={menuRef}
					className="absolute z-30 overflow-hidden rounded-8 border border-stroke bg-surface py-0.5"
					style={{ top: target.menuTop, right: target.menuRight, transform: "translateY(-50%)" }}
				>
					{AXIS_MENU_ITEMS.map((item) => (
						<button
							key={item.side}
							type="button"
							onClick={() => handlePick(item)}
							className={cn(
								"flex w-full items-center justify-between gap-4 px-3 py-1.5 text-xs font-medium transition-colors hover:bg-fill-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stroke-focus",
								item.side === "buy" ? "text-success" : "text-error",
							)}
						>
							<span>{item.label}</span>
							<span className="text-2xs tabular-nums text-fg-muted">{target.priceText}</span>
						</button>
					))}
					{hasPosition &&
						symbol &&
						(["tp", "sl"] as const).map((tpsl) => (
							<div
								key={tpsl}
								className="flex items-center justify-between gap-2 border-t border-stroke-weak/60 px-3 py-1.5"
							>
								<span className={cn("text-xs font-medium", tpsl === "tp" ? "text-success" : "text-error")}>
									{tpsl === "tp" ? "Take Profit" : "Stop Loss"}
								</span>
								<div className="flex gap-1">
									{TPSL_PERCENTAGES.map((pct) => (
										<button
											key={pct}
											type="button"
											aria-label={`${tpsl === "tp" ? "Take Profit" : "Stop Loss"} ${pct}%`}
											onClick={() => handlePlaceTpSl(tpsl, pct)}
											className="px-1.5 py-0.5 rounded-xs border border-stroke-weak text-2xs tabular-nums text-fg-muted hover:bg-fill-hover hover:text-fg transition-colors focus-visible:outline-2 focus-visible:outline-stroke-focus"
										>
											{pct}%
										</button>
									))}
								</div>
							</div>
						))}
				</div>
			)}
		</div>
	);
}
