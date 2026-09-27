import { type RefObject, useEffect, useMemo, useRef } from "react";
import type { IChartingLibraryWidget } from "@/types/charting_library";
import { type MeasureCache, measureTvChart, type TvMeasurement } from "./tv-calibration";

interface Params {
	ready: boolean;
	hostRef: RefObject<HTMLElement | null>;
	widgetRef: RefObject<IChartingLibraryWidget | null>;
}

export interface TvCalibration {
	/** Latest viewport-space measurement, or null until the widget/dom answer. */
	get: () => TvMeasurement | null;
}

/**
 * Keeps the TradingView price↔pixel fit fresh AND bridges the widget iframe's
 * pointer events to the parent document.
 *
 * **Freshness runs on the animation frame loop** — TV's own canvas repaints at
 * 60fps while panning/zooming, so a polled fit (hundreds of milliseconds) made
 * every overlay row visibly lag and snap. Reading `getVisiblePriceRange()` + the
 * (layout-clean) rects per frame keeps our rows glued to the chart exactly like
 * the klinecharts canvas, which recomputes price→pixel on every draw natively.
 *
 * The library runs in a same-origin blob iframe: the parent never sees pointer
 * events over the chart. Instead of an overlay strip (which would steal TradingView's
 * native price-axis drag-to-scale) we listen on the iframe's own document and
 * re-emit mousemove/mouseleave/mousedown/keydown/keyup onto the wrapper/window with
 * viewport-space coordinates — the shared PriceAxisMenu and ALL global hotkeys then
 * behave exactly like they do on the klinecharts canvas, and TradingView keeps every
 * one of its own interactions.
 */
export function useTvCalibration({ ready, hostRef, widgetRef }: Params): TvCalibration {
	const measurementRef = useRef<TvMeasurement | null>(null);

	if (import.meta.env.DEV) {
		// Debug affordance for browser test scripts (dev builds only).
		(globalThis as { __hlTvCal?: () => TvMeasurement | null }).__hlTvCal = () => measurementRef.current;
	}

	useEffect(() => {
		if (!ready) return;
		let stopped = false;
		let raf = 0;
		let attachedDoc: Document | null = null;
		let attachedFrame: HTMLIFrameElement | null = null;
		let detach: (() => void) | null = null;
		const measureCache: MeasureCache = {};

		const refresh = () => {
			if (stopped) return;
			const container = hostRef.current;
			const widget = widgetRef.current;
			if (!container || !widget) return;
			try {
				const chart = widget.activeChart();
				const range = chart.getPanes()[0]?.getRightPriceScales()[0]?.getVisiblePriceRange() ?? null;
				measurementRef.current = range ? measureTvChart(container, () => range, measureCache) : null;
			} catch {
				// Chart mid-load/dispose — keep the previous measurement.
			}
		};

		/** Forward the iframe's pointer/key events onto the parent (viewport coords). */
		const attachBridge = () => {
			const container = hostRef.current;
			if (!container) return;
			if (attachedDoc && attachedFrame?.isConnected && attachedFrame.contentDocument === attachedDoc) return;
			let frame: HTMLIFrameElement | null = null;
			for (const el of container.querySelectorAll("iframe")) {
				const r = el.getBoundingClientRect();
				if (r.width > 300 && r.height > 300) {
					frame = el as HTMLIFrameElement;
					break;
				}
			}
			const doc = frame?.contentDocument ?? null;
			if (!frame || !doc) return;
			detach?.();
			attachedDoc = doc;
			attachedFrame = frame;

			const wrap = () => hostRef.current?.parentElement ?? null;
			const onMove = (event: Event) => {
				const mouse = event as MouseEvent;
				const target = wrap();
				if (!target || !frame) return;
				const rect = frame.getBoundingClientRect();
				target.dispatchEvent(
					new MouseEvent("mousemove", {
						clientX: mouse.clientX + rect.left,
						clientY: mouse.clientY + rect.top,
						bubbles: true,
					}),
				);
			};
			const onDown = (event: Event) => {
				const mouse = event as MouseEvent;
				const target = wrap();
				if (!target || !frame) return;
				const rect = frame.getBoundingClientRect();
				target.dispatchEvent(
					new MouseEvent("mousedown", {
						clientX: mouse.clientX + rect.left,
						clientY: mouse.clientY + rect.top,
						bubbles: true,
						button: mouse.button,
					}),
				);
			};
			const onUp = (event: Event) => {
				const mouse = event as MouseEvent;
				const target = wrap();
				if (!target || !frame) return;
				const rect = frame.getBoundingClientRect();
				target.dispatchEvent(
					new MouseEvent("mouseup", {
						clientX: mouse.clientX + rect.left,
						clientY: mouse.clientY + rect.top,
						bubbles: true,
						button: mouse.button,
					}),
				);
			};
			const onLeave = () => {
				wrap()?.dispatchEvent(new MouseEvent("mouseleave"));
			};
			/**
			 * Keyboard events fired while focus is inside the iframe never reach the
			 * parent window — without this bridge, every chart interaction (panning,
			 * dragging the axis) would silently kill all global hotkeys and the
			 * hold-key chart actions until the user clicked back into the page.
			 * Skipped while typing inside the widget's own inputs.
			 */
			const onKey = (event: Event) => {
				const key = event as KeyboardEvent;
				const active = doc.activeElement;
				if (
					active instanceof HTMLInputElement ||
					active instanceof HTMLTextAreaElement ||
					(active instanceof HTMLElement && active.isContentEditable)
				) {
					return;
				}
				window.dispatchEvent(
					new KeyboardEvent(key.type, {
						key: key.key,
						code: key.code,
						ctrlKey: key.ctrlKey,
						shiftKey: key.shiftKey,
						altKey: key.altKey,
						metaKey: key.metaKey,
						repeat: key.repeat,
						bubbles: true,
						cancelable: true,
					}),
				);
			};

			/** Forward a touch event's first point to the wrapper with frame offset. */
			const forwardTouch = (type: "touchstart" | "touchmove" | "touchend" | "touchcancel", event: Event) => {
				const touchEvent = event as TouchEvent;
				const point = touchEvent.touches?.[0] ?? touchEvent.changedTouches?.[0];
				const target = wrap();
				if (!target || !point) return;
				const rect = frame.getBoundingClientRect();
				const clientX = point.clientX + rect.left;
				const clientY = point.clientY + rect.top;
				// Our wrapper handlers (axis cross, scale Start/End pick) only read the
				// first point — a plain Event with a synthetic `touches` array is enough
				// and avoids the Touch constructor (unavailable in some contexts).
				const forwarded = new Event(type, { bubbles: true, cancelable: true });
				const payload = [{ clientX, clientY, identifier: 0 }];
				Object.defineProperty(forwarded, "touches", {
					value: type === "touchend" || type === "touchcancel" ? [] : payload,
				});
				Object.defineProperty(forwarded, "changedTouches", { value: payload });
				target.dispatchEvent(forwarded);
			};
			// A stray TV-emitted touchmove (e.g. its crosshair settling after a tap)
			// must not re-target our cross mid-gesture — only forward moves while a
			// touch gesture is actually active.
			let touchGestureActive = false;
			const onTouchStart = (event: Event) => {
				touchGestureActive = true;
				forwardTouch("touchstart", event);
			};
			const onTouchMove = (event: Event) => {
				if (!touchGestureActive) return;
				forwardTouch("touchmove", event);
			};
			const onTouchEnd = (event: Event) => {
				touchGestureActive = false;
				forwardTouch("touchend", event);
			};
			doc.addEventListener("touchstart", onTouchStart, { passive: true });
			doc.addEventListener("touchmove", onTouchMove, { passive: true });
			doc.addEventListener("touchend", onTouchEnd, { passive: true });
			doc.addEventListener("touchcancel", onTouchEnd, { passive: true });
			doc.addEventListener("mousemove", onMove, { passive: true });
			doc.addEventListener("mousedown", onDown, { passive: true });
			doc.addEventListener("mouseup", onUp, { passive: true });
			doc.addEventListener("mouseleave", onLeave, { passive: true });
			doc.addEventListener("keydown", onKey, { passive: true });
			doc.addEventListener("keyup", onKey, { passive: true });
			detach = () => {
				doc.removeEventListener("touchstart", onTouchStart);
				doc.removeEventListener("touchmove", onTouchMove);
				doc.removeEventListener("touchend", onTouchEnd);
				doc.removeEventListener("touchcancel", onTouchEnd);
				doc.removeEventListener("mousemove", onMove);
				doc.removeEventListener("mousedown", onDown);
				doc.removeEventListener("mouseup", onUp);
				doc.removeEventListener("mouseleave", onLeave);
				doc.removeEventListener("keydown", onKey);
				doc.removeEventListener("keyup", onKey);
			};
		};

		// Frame loop: every overlay row repositions from THIS frame's fit, so lines
		// track pans/zooms with no visible catch-up. The interval below is only a
		// safety net for throttled/hidden frames.
		const frameLoop = () => {
			raf = requestAnimationFrame(frameLoop);
			attachBridge();
			refresh();
		};
		raf = requestAnimationFrame(frameLoop);
		const safety = setInterval(() => {
			attachBridge();
			refresh();
		}, 1000);

		return () => {
			stopped = true;
			cancelAnimationFrame(raf);
			clearInterval(safety);
			detach?.();
			attachedDoc = null;
			attachedFrame = null;
		};
	}, [ready, hostRef, widgetRef]);

	return useMemo<TvCalibration>(() => ({ get: () => measurementRef.current }), []);
}
