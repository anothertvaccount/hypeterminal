import { getMarketCapabilities } from "@hypeterminal/hl-react";
import {
	type PointerEvent as ReactPointerEvent,
	type RefObject,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { HL_ALL_DEXS } from "@/config/app";
import { PAPER_TRADE } from "@/config/paper";
import {
	buildPositionSegments,
	buildTpSlGhostSegments,
	type ChartLabelContext,
	chartOrderFromOpenOrder,
	type LabelSegment,
} from "@/domain/trade/order/chart-labels";
import { buildPreviewSegments, computeFormDrafts, draftReferencePrice } from "@/domain/trade/order/chart-preview";
import { buildOrderSegments } from "@/domain/trade/order/chart-risk";
import { formatPriceForOrder, formatSizeForOrder } from "@/domain/trade/orders";
import { useOrderEntryData } from "@/hooks/trade/use-order-entry-data";
import { useOrderLineActions } from "@/hooks/trade/use-order-line-actions";
import { usePlaceTpSl } from "@/hooks/trade/use-place-tpsl";
import { LABEL_BOX_HEIGHT } from "@/lib/chart/label-style";
import { noteChartOverlayInteraction } from "@/lib/chart/overlay-interaction";
import { useSelectedMarketInfo, useSubscription, useTradingSession, useUserPositions } from "@/lib/hyperliquid";
import type { OpenOrder } from "@/lib/trade/open-orders";
import { canUseTpSl } from "@/lib/trade/order-types";
import {
	useLimitPrice,
	useOrderEntryActions,
	useOrderSide,
	useOrderSize,
	useOrderType,
	useScaleAmountDist,
	useScaleEnd,
	useScaleLevels,
	useScalePreview,
	useScalePriceDist,
	useScaleStart,
	useSizeMode,
	useSlPrice,
	useTpPrice,
	useTpSlEnabled,
} from "@/stores/use-order-entry-store";
import { usePaperOpenOrderRows } from "@/stores/use-paper-store";
import { getShortBuilderSymbol } from "../use-kline-position-overlays";
import { tvPriceToViewportY, tvViewportYToPrice } from "./tv-calibration";
import { LabelStrip } from "./tv-label-strip";
import type { TvCalibration } from "./use-tv-calibration";

interface Params {
	hostRef: RefObject<HTMLElement | null>;
	calibration: TvCalibration;
	symbol: string;
	dex?: string;
	/** Pans the widget's visible price range (positive = reveal lower prices). */
	shiftPriceRange?: (deltaFraction: number) => void;
}

interface TvLineRow {
	id: string;
	price: number;
	segments: LabelSegment[];
	isBuy: boolean;
	alpha: number;
	draggable: boolean;
	/** Data attribute for tests/scripts (draft kind / order / position). */
	kind: string;
	/** Drag release with the drop price (raw). */
	onDragEnd?: (rawPrice: number) => void;
	/** Press on a keyed cell (position TP/SL buttons start their gesture here). */
	onBoxPointerDown?: (key: string, event: ReactPointerEvent<HTMLElement>) => void;
	/** Click on a keyed cell (order ✕ cancel). */
	onBoxClick?: (key: string) => void;
}

/** Client y → host-relative y (host = the widget container; same origin as the layer). */
function localY(host: HTMLElement | null, clientY: number): number {
	return clientY - (host?.getBoundingClientRect().top ?? 0);
}

interface DragState {
	id: string;
	yLocal: number;
	priceText: string;
}

interface GhostState {
	mode: "tp" | "sl";
	yLocal: number;
	price: number;
}

/**
 * The TradingView canvas layer: DOM twins of every klinecharts trading overlay —
 * form draft previews (limit / TP / SL / scale ladder), resting order lines with
 * labels + ✕ cancel + drag-to-reprice, and the position line with its press-drag
 * TP/SL buttons + ghost chip. Rows are positioned each frame from the calibration
 * fit; drags convert pointer y → price through the same fit. Axis/menu pointer
 * events are bridged from the same-origin iframe by use-tv-calibration, so nothing
 * covers the widget's own price axis and its native drag-to-scale keeps working.
 */
export function TradingViewOverlayLayer({ hostRef, calibration, symbol, dex, shiftPriceRange }: Params) {
	const { address, isActive } = useTradingSession();
	const paperRows = usePaperOpenOrderRows();
	const { getPosition } = useUserPositions();
	const { data: market } = useSelectedMarketInfo();
	const placeTpSl = usePlaceTpSl();
	const { repriceOrder, cancelOrder, isCancelling } = useOrderLineActions();

	// Form state (same selectors as the klinecharts preview hook).
	const side = useOrderSide();
	const orderType = useOrderType();
	const limitPriceInput = useLimitPrice();
	const tpSlEnabled = useTpSlEnabled();
	const tpPriceInput = useTpPrice();
	const slPriceInput = useSlPrice();
	const scaleStartInput = useScaleStart();
	const scaleEndInput = useScaleEnd();
	const scaleLevels = useScaleLevels();
	const scalePreview = useScalePreview();
	const scalePriceDist = useScalePriceDist();
	const scaleAmountDist = useScaleAmountDist();
	const { setLimitPrice, setTpPrice, setSlPrice, setScaleStart, setScaleEnd } = useOrderEntryActions();

	// Account data (identical sources to the kline overlays).
	const { data: openOrdersEvent } = useSubscription(
		"openOrders",
		{ user: address ?? "0x0", dex: HL_ALL_DEXS },
		{ enabled: !PAPER_TRADE && isActive },
	);
	const { data: midsEvent } = useSubscription("allMids", { dex: HL_ALL_DEXS }, { enabled: true });
	const allOrders = useMemo(
		() => (PAPER_TRADE ? paperRows : (openOrdersEvent?.orders ?? [])),
		[paperRows, openOrdersEvent],
	);
	const symbolOrders = useMemo(() => allOrders.filter((order) => order.coin === symbol), [allOrders, symbol]);
	const chartOrders = useMemo(() => symbolOrders.map(chartOrderFromOpenOrder), [symbolOrders]);
	const position = getPosition(symbol, dex) ?? getPosition(getShortBuilderSymbol(symbol), dex);
	const sziValue = position ? Number(position.szi) : 0;
	const entryValue = position ? Number(position.entryPx) : 0;
	const liquidationValue = position?.liquidationPx != null ? Number(position.liquidationPx) : Number.NaN;
	const rawMark = midsEvent?.mids?.[symbol];
	const parsedMark = rawMark !== undefined ? Number(rawMark) : Number.NaN;
	const mark = Number.isFinite(parsedMark) && parsedMark > 0 ? parsedMark : undefined;
	const sizeInput = useOrderSize();
	const sizeMode = useSizeMode();
	const { sizeValue, szDecimals } = useOrderEntryData({ market, side, markPx: mark ?? 0, sizeMode, sizeInput });

	const placeTpSlRef = useRef(placeTpSl);
	placeTpSlRef.current = placeTpSl;
	const positionParamsRef = useRef({ coin: symbol, dex });
	positionParamsRef.current = { coin: symbol, dex };

	// biome-ignore lint/correctness/useExhaustiveDependencies: hostRef is a stable ref whose .current changes without re-renders
	const beginTpSlDrag = useCallback(
		(mode: "tp" | "sl", event: ReactPointerEvent<HTMLElement>) => {
			if (sziValue === 0 || !Number.isFinite(entryValue)) return;
			if (event.pointerType === "touch") event.preventDefault();
			try {
				event.currentTarget.setPointerCapture(event.pointerId);
			} catch {
				// see startRowDrag
			}
			ghostGestureRef.current = { mode, startY: event.clientY, moved: false, startPrice: entryValue };
			setGhost({ mode, yLocal: localY(hostRef.current, event.clientY), price: entryValue });
			liveDragRef.current = {
				move: (native) => moveTpSlDrag(native),
				up: () => {
					endRowDrag();
					endTpSlDrag();
				},
			};
			attachWindowDrag();
		},
		[sziValue, entryValue],
	);

	const rows: TvLineRow[] = useMemo(() => {
		const out: TvLineRow[] = [];
		const previewRefPrice = draftReferencePrice({
			orderType,
			limitPriceInput,
			scaleStartInput,
			scaleEndInput,
			mark: mark ?? 0,
		});

		// 1) Form drafts — shared model with the klinecharts preview hook.
		const drafts = computeFormDrafts({
			orderType,
			limitPriceInput,
			tpSlEnabled,
			tpSlAllowed: canUseTpSl(orderType) && getMarketCapabilities(market).hasTpSl,
			tpPriceInput,
			slPriceInput,
			scalePreview,
			scaleStartInput,
			scaleEndInput,
			scaleLevels,
			scalePriceDist,
			scaleAmountDist,
			sizeValue,
			szDecimals,
		});
		const fieldSetterFor = (kind: string): ((text: string) => void) | undefined => {
			if (kind === "limit") return setLimitPrice;
			if (kind === "tp") return setTpPrice;
			if (kind === "sl") return setSlPrice;
			if (kind === "scaleStart") return setScaleStart;
			if (kind === "scaleEnd") return setScaleEnd;
			return undefined; // scaleMid: a scale is a range — release snaps back.
		};
		for (const draft of drafts) {
			// Scale rungs show the size of ONE order (ladder / levels) — only once the
			// ladder exists; a lone start/end line has no per-order size to show.
			const levels = draft.scaleLevels;
			const rungSize = levels && levels > 0 ? sizeValue / levels : sizeValue;
			const showSize = !draft.kind.startsWith("scale") || levels !== undefined;
			const rungSizeText = showSize && rungSize > 0 ? formatSizeForOrder(rungSize, szDecimals) : undefined;
			const resolution = buildPreviewSegments(draft.kind, side, {
				price: draft.price,
				size: rungSize,
				sizeText: draft.rungSizeText ?? rungSizeText,
				refPrice: previewRefPrice,
			});
			const setter = fieldSetterFor(draft.kind);
			out.push({
				// MUST be unique per rung: React keys AND the rAF position map are keyed
				// by id — every middle rung previously collapsed onto one element
				// (only one mid visible, the rest stuck visibility:hidden).
				id: `draft-${draft.kind}-${draft.price}`,
				price: draft.price,
				segments: resolution.segments,
				isBuy: resolution.isBuy,
				alpha: 0.5,
				draggable: true,
				kind: `draft:${draft.kind}`,
				onDragEnd: setter
					? (raw) => {
							const text = formatPriceForOrder(raw);
							if (Number(raw) > 0) setter(text);
						}
					: undefined,
			});
		}

		// 2) Resting orders — labels + ✕ cancel + drag-to-reprice.
		const ctx: ChartLabelContext = {
			position:
				position && Number.isFinite(sziValue) && Number.isFinite(entryValue)
					? { coin: position.coin, dex: position.dex ?? undefined, szi: sziValue, entryPx: entryValue }
					: null,
			orders: chartOrders,
			mark,
		};
		symbolOrders.forEach((order: OpenOrder) => {
			const rawPrice = Number(order.isTrigger ? order.triggerPx : order.limitPx);
			if (!Number.isFinite(rawPrice) || rawPrice <= 0) return;
			const resolution = buildOrderSegments(chartOrderFromOpenOrder(order), ctx);
			// A cancel in flight: swap the ✕ for a spinner and dim the row so the
			// press reads instantly, even though the exchange takes ~a second.
			const cancelling = isCancelling(order.oid);
			out.push({
				id: `order-${order.oid}`,
				price: rawPrice,
				segments: cancelling
					? resolution.segments.map((segment) => (segment.key === "cancel" ? { ...segment, text: "…" } : segment))
					: resolution.segments,
				isBuy: resolution.isBuy,
				alpha: cancelling ? 0.16 : 0.35,
				draggable: !cancelling,
				kind: "order",
				onDragEnd: (raw) => void repriceOrder(order, raw),
				onBoxClick: (key) => {
					if (key === "cancel" && !cancelling) void cancelOrder(order);
				},
			});
		});

		// 3) Position line — pinned entry row; TP/SL cells start press-drags.
		if (Number.isFinite(sziValue) && sziValue !== 0 && Number.isFinite(entryValue) && entryValue > 0) {
			const resolution = buildPositionSegments({ coin: symbol, szi: sziValue, entryPx: entryValue }, mark);
			out.push({
				id: "position",
				price: entryValue,
				segments: resolution.segments,
				isBuy: resolution.isBuy,
				alpha: 0.5,
				draggable: false,
				kind: "position",
				onBoxPointerDown: (key, event) => {
					if (key !== "tp" && key !== "sl") return;
					beginTpSlDrag(key, event);
				},
			});
		}
		// Liquidation line (upstream feature, replicated here so both canvases match).
		if (Number.isFinite(liquidationValue) && liquidationValue > 0 && sziValue !== 0) {
			out.push({
				id: "liquidation",
				price: liquidationValue,
				segments: [{ text: "Liquidation", tone: "down" }],
				isBuy: false,
				alpha: 0.35,
				draggable: false,
				kind: "liquidation",
			});
		}
		return out;
	}, [
		side,
		orderType,
		limitPriceInput,
		tpSlEnabled,
		tpPriceInput,
		slPriceInput,
		scalePreview,
		scaleStartInput,
		scaleEndInput,
		scaleLevels,
		market,
		setLimitPrice,
		setTpPrice,
		setSlPrice,
		setScaleStart,
		setScaleEnd,
		symbolOrders,
		chartOrders,
		position,
		sziValue,
		entryValue,
		liquidationValue,
		mark,
		repriceOrder,
		cancelOrder,
		isCancelling,
		symbol,
		beginTpSlDrag,
		sizeValue,
		szDecimals,
		scalePriceDist,
		scaleAmountDist,
	]);

	// Keep the rAF loop's view of rows/prices fresh without re-subscribing it.
	const rowsRef = useRef(rows);
	rowsRef.current = rows;
	const rowElsRef = useRef(new Map<string, HTMLElement>());
	/** Strip containers: left-half box, written per frame (same anchor as klinecharts' rowAnchor). */
	const stripBoxElsRef = useRef(new Map<string, HTMLElement>());
	/** Right-edge price badges: x written per frame alongside the strip boxes. */
	const badgeElsRef = useRef(new Map<string, HTMLElement>());
	const ghostStripRef = useRef<HTMLSpanElement | null>(null);
	const ghostLineRef = useRef<HTMLDivElement | null>(null);
	const ghostWrapRef = useRef<HTMLDivElement | null>(null);
	const ghostStripBoxRef = useRef<HTMLDivElement | null>(null);
	const dragRef = useRef<{ gesture: DragState; moved: boolean; startY: number; cellKey?: string } | null>(null);
	const ghostGestureRef = useRef<{ mode: "tp" | "sl"; startY: number; moved: boolean; startPrice: number } | null>(
		null,
	);
	const [drag, setDrag] = useState<DragState | null>(null);
	const [ghost, setGhost] = useState<GhostState | null>(null);
	const ghostRef = useRef<GhostState | null>(null);
	ghostRef.current = ghost;

	// ---------- row drags (preview fields / order reprice) ----------
	/**
	 * Touch drags used to die one move in: the browser promotes a moving finger to
	 * a scroll and fires `pointercancel`, and pointer capture is lost whenever the
	 * dragged row re-renders under the finger. So while a drag is active we listen
	 * on the window (stable, never re-created) and keep the drag alive across
	 * re-renders; the elements keep their own handlers for mouse.
	 */
	const windowDragRef = useRef(false);
	const liveDragRef = useRef<{
		move: (event: PointerEvent) => void;
		up: () => void;
	} | null>(null);
	const windowMoveRef = useRef<(event: PointerEvent) => void>(() => undefined);
	const windowUpRef = useRef<() => void>(() => undefined);

	const attachWindowDrag = useCallback(() => {
		if (windowDragRef.current) return;
		windowDragRef.current = true;
		windowMoveRef.current = (event) => liveDragRef.current?.move(event);
		windowUpRef.current = () => liveDragRef.current?.up();
		window.addEventListener("pointermove", windowMoveRef.current, { passive: false });
		// BUBBLE phase on purpose: the element's own handlers (click cells, drag end)
		// must run first — a capture-phase window listener would consume the gesture
		// and strip the click's cell key (✕ cancel) / drag result.
		window.addEventListener("pointerup", windowUpRef.current);
		window.addEventListener("pointercancel", windowUpRef.current);
	}, []);

	const detachWindowDrag = useCallback(() => {
		if (!windowDragRef.current) return;
		windowDragRef.current = false;
		window.removeEventListener("pointermove", windowMoveRef.current);
		window.removeEventListener("pointerup", windowUpRef.current);
		window.removeEventListener("pointercancel", windowUpRef.current);
		liveDragRef.current = null;
	}, []);

	function priceAtClientY(clientY: number): number | null {
		const m = calibration.get();
		return m ? tvViewportYToPrice(m, clientY) : null;
	}

	/**
	 * Edge-follow: a phone/trackpad can't drag a line past the edge of the screen,
	 * so past the plot bounds we pan the visible price range instead. Calibration
	 * re-reads the range every frame, so the drag simply continues. Without this,
	 * dragging stops dead at the chart's lowest visible price.
	 */
	function followEdge(clientY: number) {
		const m = calibration.get();
		if (!m || !shiftPriceRange) return;
		if (m.plot.height <= 0) return;
		const top = m.plot.top;
		const bottom = m.plot.top + m.plot.height;
		// Positive delta shifts the visible window UP in price, so dragging past the
		// BOTTOM must go negative (reveal lower prices) and past the top positive.
		if (clientY > bottom) shiftPriceRange(-(clientY - bottom) / m.plot.height);
		else if (clientY < top) shiftPriceRange((top - clientY) / m.plot.height);
	}

	function startRowDrag(row: TvLineRow, cellKey?: string) {
		return (event: ReactPointerEvent<HTMLElement>) => {
			if (!row.draggable) return;
			// No stamp here: a press that never moves is a plain click — the chart-click
			// hotkeys must keep placing over lines/previews (spam-safe, mirrors kline).
			// Keep touch scrolls out of the way; window listeners do the tracking.
			if (event.pointerType === "touch") event.preventDefault();
			try {
				event.currentTarget.setPointerCapture(event.pointerId);
			} catch {
				// Capture is a nicety; the window listeners are the real mechanism.
			}
			const price = row.price;
			dragRef.current = {
				gesture: { id: row.id, yLocal: localY(hostRef.current, event.clientY), priceText: formatPriceForOrder(price) },
				moved: false,
				startY: event.clientY,
				cellKey,
			};
			setDrag(dragRef.current.gesture);
			liveDragRef.current = {
				move: (native) => moveRowDrag(native),
				up: () => {
					endRowDrag();
					endTpSlDrag();
				},
			};
			attachWindowDrag();
		};
	}
	function moveRowDrag(event: ReactPointerEvent<HTMLElement> | PointerEvent) {
		const active = dragRef.current;
		if (!active) return;
		const crossed = Math.abs(event.clientY - active.startY) > 3;
		// Stamp only once a real drag is underway — that gesture consumes the click.
		if (crossed && !active.moved) noteChartOverlayInteraction();
		if (crossed) active.moved = true;
		followEdge(event.clientY);
		const price = priceAtClientY(event.clientY);
		const next: DragState = {
			id: active.gesture.id,
			yLocal: localY(hostRef.current, event.clientY),
			priceText: price !== null && price > 0 ? formatPriceForOrder(price) : active.gesture.priceText,
		};
		active.gesture = next;
		setDrag(next);
	}
	/** Ends an active row drag; returns info for the click-vs-drag decision on release. */
	function endRowDrag(): { moved: boolean; cellKey?: string } {
		const active = dragRef.current;
		dragRef.current = null;
		setDrag(null);
		detachWindowDrag();
		if (!active) return { moved: false };
		if (!active.moved) return { moved: false, cellKey: active.cellKey };
		const price = priceAtClientY(active.gesture.yLocal + (hostRef.current?.getBoundingClientRect().top ?? 0));
		if (price !== null && Number.isFinite(price) && price > 0) {
			const row = rowsRef.current.find((r) => r.id === active.gesture.id);
			row?.onDragEnd?.(price);
		}
		return { moved: true };
	}

	// ---------- position TP/SL press-drag (pinned row + ghost chip) ----------
	function moveTpSlDrag(event: ReactPointerEvent<HTMLElement> | PointerEvent) {
		const active = ghostGestureRef.current;
		if (!active) return;
		const crossed = Math.abs(event.clientY - active.startY) > 3;
		if (crossed && !active.moved) noteChartOverlayInteraction();
		if (crossed) active.moved = true;
		followEdge(event.clientY);
		const price = priceAtClientY(event.clientY);
		if (price === null || price <= 0) return;
		setGhost({ mode: active.mode, yLocal: localY(hostRef.current, event.clientY), price });
	}
	function endTpSlDrag() {
		const active = ghostGestureRef.current;
		ghostGestureRef.current = null;
		detachWindowDrag();
		const dropPrice = ghostRef.current?.price;
		setGhost(null);
		if (!active?.moved) return;
		if (dropPrice === undefined || !Number.isFinite(dropPrice) || dropPrice <= 0) return;
		// A plain click on the button (no drop-price change) places nothing — mirrors
		// the klinecharts position line's press-drag semantics exactly.
		if (Math.abs(dropPrice - active.startPrice) < 1e-9) return;
		placeTpSlRef.current({ ...positionParamsRef.current, tpsl: active.mode, price: dropPrice });
	}

	// ---------- frame loop: position rows, ghost, axis strip ----------
	useEffect(() => {
		let raf = 0;
		const loop = () => {
			raf = requestAnimationFrame(loop);
			const host = hostRef.current;
			if (!host) return;
			// The host rect changes EVERY frame while the page scrolls — reading it
			// fresh (we only write transforms, which don't invalidate layout) keeps the
			// rows glued to the chart instead of lagging and snapping.
			const rect = host.getBoundingClientRect();
			const m = calibration.get();
			if (m) {
				// Strip boxes span the plot's LEFT HALF (viewport → host-relative); strips
				// center inside it — matching the default canvas' left-of-center anchor.
				const left = (m.plot.left - rect.left).toFixed(1);
				// Half the plot on desktop (the label sits left of centre, like the
				// default canvas). On a phone the plot is only ~330px, so anything
				// short of the full width squeezes the cells into each other — use
				// the whole canvas there.
				const plotWidth = m.plot.right - m.plot.left;
				const share = plotWidth < 420 ? 1 : 0.5;
				const half = (plotWidth * share).toFixed(1);
				for (const box of stripBoxElsRef.current.values()) {
					box.style.left = `${left}px`;
					box.style.width = `${half}px`;
					box.style.overflow = "hidden";
				}
				if (ghostStripBoxRef.current) {
					ghostStripBoxRef.current.style.left = `${left}px`;
					ghostStripBoxRef.current.style.width = `${half}px`;
				}
				const badgeLeft = `${(m.plot.right - rect.left + 2).toFixed(1)}px`;
				for (const badge of badgeElsRef.current.values()) {
					badge.style.left = badgeLeft;
				}
			}
			for (const row of rowsRef.current) {
				const el = rowElsRef.current.get(row.id);
				if (!el) continue;
				if (!m) {
					el.style.visibility = "hidden";
					continue;
				}
				// Rows (line + grab band) stop at the plot's right edge: covering the
				// price axis would swallow TradingView's own drag-to-scale.
				el.style.right = `${(rect.width - (m.plot.right - rect.left)).toFixed(1)}px`;
				// Rows live in the PRICE pane. With lower panes (TradingView's default
				// volume study) a line priced outside the visible range would otherwise
				// be painted on top of them, so: off-range rows hide, and the row being
				// dragged pins to the pane edge while its price keeps moving.
				const paneTop = m.pane.top - rect.top;
				const paneBottom = paneTop + m.pane.height;
				const dragY = dragRef.current?.gesture.id === row.id ? dragRef.current.gesture.yLocal : null;
				const rawY = dragY ?? tvPriceToViewportY(m, row.price) - rect.top;
				const yLocal = Math.min(Math.max(rawY, paneTop), paneBottom);
				const inRange = rawY >= paneTop - 1 && rawY <= paneBottom + 1;
				const inView =
					dragY !== null || (inRange && yLocal > -LABEL_BOX_HEIGHT * 2 && yLocal < rect.height + LABEL_BOX_HEIGHT * 2);
				el.style.visibility = inView ? "visible" : "hidden";
				el.style.transform = `translate3d(0, ${yLocal.toFixed(1)}px, 0)`;
			}
			// Ghost (position TP/SL drag preview).
			if (ghostWrapRef.current) {
				const state = ghostRef.current;
				const entryLocal = m ? tvPriceToViewportY(m, entryValue) - rect.top : 0;
				if (!state || !m) {
					ghostWrapRef.current.style.visibility = "hidden";
				} else {
					// Same pane clamp as the rows — the ghost chip may not sit on the volume pane.
					const paneTop = m.pane.top - rect.top;
					const paneBottom = paneTop + m.pane.height;
					const ghostY = Math.min(Math.max(state.yLocal, paneTop), paneBottom);
					ghostWrapRef.current.style.visibility = "visible";
					ghostWrapRef.current.style.transform = `translate3d(0, ${ghostY.toFixed(1)}px, 0)`;
					if (ghostLineRef.current) {
						const top = Math.min(entryLocal, ghostY);
						const height = Math.abs(entryLocal - ghostY);
						ghostLineRef.current.style.top = `${top.toFixed(1)}px`;
						ghostLineRef.current.style.height = `${height.toFixed(1)}px`;
					}
				}
			}
		};
		raf = requestAnimationFrame(loop);
		return () => {
			cancelAnimationFrame(raf);
		};
	}, [calibration, hostRef, entryValue]);

	return (
		// The root must never intercept pointer events: everything below it (TV's
		// pan/zoom, drawings, and its header buttons incl. "Default") lives in the
		// widget iframe. Interactive children opt back in with pointer-events:auto
		// (pointer-events is inherited, so the axis strip sets it explicitly).
		// biome-ignore lint/a11y/noStaticElementInteractions: the overlay deliberately swallows the browser's callout menu so a long-press can drag a price line. Not a control, so it takes no role/tab stop.
		<div
			className="pointer-events-none absolute inset-0 z-20"
			data-tv-overlay=""
			// A held finger on a TP/SL line must DRAG the line. Without these, the
			// browser treats the hold as a text selection and pops its own
			// "Copy / Select all" menu over the chart.
			style={{ userSelect: "none", WebkitUserSelect: "none", WebkitTouchCallout: "none" }}
			onContextMenu={(event) => event.preventDefault()}
		>
			{rows.map((row) => {
				const isDragged = drag?.id === row.id;
				return (
					<div
						key={row.id}
						ref={(el) => {
							if (el) rowElsRef.current.set(row.id, el);
							else rowElsRef.current.delete(row.id);
						}}
						data-tv-line={row.id}
						data-kind={row.kind}
						data-price={row.price}
						className="absolute left-0 right-0 top-0 will-change-transform"
						style={{ visibility: "hidden", pointerEvents: "none" }}
					>
						{/* The line + its grab band */}
						<div
							className="absolute left-0 right-0"
							style={{
								top: 0,
								borderTop: `1px dashed ${row.isBuy ? "var(--market-up)" : "var(--market-down)"}`,
								opacity: row.alpha,
							}}
						/>
						{row.draggable && (
							<div
								// A 14px band is a mouse affordance: fingers land on the line and
								// nothing happens. 34px keeps the dashed line's exact position
								// (it is a separate element) while giving touch a real target.
								className="absolute left-0 right-0 cursor-grab active:cursor-grabbing"
								// touch-action: none is REQUIRED here: without it the browser
								// decides mid-gesture that a moving finger is a scroll and fires
								// pointercancel, which silently aborts the drag a few pixels in.
								style={{ top: -17, height: 34, pointerEvents: "auto", touchAction: "none" }}
								onPointerDown={(event) => startRowDrag(row)(event)}
								onPointerMove={moveRowDrag}
								onPointerUp={endRowDrag}
								onPointerCancel={endRowDrag}
							/>
						)}
						{/* The label strip — centered within the LEFT HALF of the plot (the
						    default canvas' rowAnchor formula): closer to center, still left of
						    it. left/width are written per frame by the rAF loop. */}
						<div
							ref={(el) => {
								if (el) stripBoxElsRef.current.set(row.id, el);
								else stripBoxElsRef.current.delete(row.id);
							}}
							data-tv-strip-box=""
							className="absolute"
							style={{ top: -LABEL_BOX_HEIGHT / 2 }}
						>
							<div
								// justify-center keeps the desktop anchor (label centred in the
								// left half of the plot, as before); max-w-full stops it
								// overflowing a narrow (phone) plot.
								className="relative flex w-full justify-center max-w-full overflow-hidden"
								style={{
									pointerEvents: row.draggable || row.onBoxPointerDown ? "auto" : "none",
									// Without this the browser claims the gesture for scrolling
									// and cancels the drag (pointercancel) one move in.
									touchAction: row.draggable || row.onBoxPointerDown ? "none" : undefined,
									zIndex: 2,
								}}
								onPointerDown={(event) => {
									const key = (event.target as HTMLElement).dataset?.boxKey;
									if (key && row.onBoxPointerDown) {
										row.onBoxPointerDown(key, event);
										return;
									}
									startRowDrag(row, key)(event);
								}}
								onPointerMove={(event) => {
									moveRowDrag(event);
									moveTpSlDrag(event);
								}}
								onPointerUp={() => {
									const result = endRowDrag();
									endTpSlDrag();
									// Click (not drag) on a keyed cell: ✕ cancel etc.
									if (!result.moved && result.cellKey && row.onBoxClick) {
										// A ✕ click is a real job: consume the gesture for the chart hotkeys.
										noteChartOverlayInteraction();
										row.onBoxClick(result.cellKey);
									}
								}}
								onPointerCancel={() => {
									endRowDrag();
									endTpSlDrag();
								}}
							>
								<span className="relative inline-flex max-w-full overflow-hidden" data-tv-strip="">
									<LabelStrip segments={row.segments} isBuy={row.isBuy} />
									{isDragged && (
										<span
											ref={(el) => {
												if (el) badgeElsRef.current.set(`${row.id}-drag`, el);
												else badgeElsRef.current.delete(`${row.id}-drag`);
											}}
											data-tv-drag-badge=""
											className="absolute rounded-4 px-1.5 py-0.5 text-2xs font-semibold tabular-nums"
											style={{
												left: "100%",
												marginLeft: 8,
												top: 0,
												background: row.isBuy ? "var(--market-up)" : "var(--market-down)",
												color: "var(--text-strong)",
											}}
										>
											{drag?.priceText}
										</span>
									)}
								</span>
							</div>
						</div>
						{/* Right-edge price badge (over the axis, like the canvas charts' axis badges). */}
						<div
							ref={(el) => {
								if (el) badgeElsRef.current.set(row.id, el);
								else badgeElsRef.current.delete(row.id);
							}}
							data-tv-badge=""
							className="absolute px-1 py-0.5 text-2xs font-semibold tabular-nums rounded-4"
							style={{
								left: 0,
								top: -LABEL_BOX_HEIGHT / 2,
								background: row.isBuy ? "var(--market-up)" : "var(--market-down)",
								color: "var(--text-strong)",
								pointerEvents: "none",
							}}
						>
							{isDragged ? drag?.priceText : formatPriceForOrder(row.price)}
						</div>
					</div>
				);
			})}

			{/* Ghost row: floating TP/SL preview chip + connector during a position press-drag. */}
			<div
				ref={ghostWrapRef}
				data-tv-ghost=""
				className="absolute left-0 right-0 top-0 will-change-transform"
				style={{ visibility: "hidden", pointerEvents: "none" }}
			>
				<div
					ref={ghostLineRef}
					className="absolute"
					style={{
						left: 0,
						right: 0,
						top: 0,
						height: 0,
						borderLeft: "1px dashed var(--text-weak)",
						opacity: 0.6,
					}}
				/>
				<div ref={ghostStripBoxRef} data-tv-strip-box="" className="absolute" style={{ top: -LABEL_BOX_HEIGHT / 2 }}>
					<div className="relative flex w-full justify-center">
						<span ref={ghostStripRef} data-tv-strip="">
							<LabelStrip
								segments={
									ghost
										? buildTpSlGhostSegments({
												tpsl: ghost.mode,
												entryPx: Number.isFinite(entryValue) ? entryValue : 0,
												szi: sziValue,
												price: ghost.price,
											})
										: []
								}
								isBuy={sziValue < 0}
							/>
						</span>
					</div>
				</div>
			</div>
		</div>
	);
}
