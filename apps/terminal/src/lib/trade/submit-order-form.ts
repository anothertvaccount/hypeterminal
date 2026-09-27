import { flushSync } from "react-dom";

/**
 * Applies store mutations and submits the order panel's form in one gesture.
 *
 * The panel's submit handler reads React-rendered values (derived from the
 * order-entry store), so mutating the store and immediately submitting would use the
 * previous render's values. `flushSync` forces the re-render synchronously before
 * `requestSubmit()`, guaranteeing the submit sees the fresh side/type/price — no
 * async timing games.
 */
function requestFormSubmit(form: HTMLFormElement): void {
	// Programmatic, per-gesture submissions (hotkeys, chart clicks): each press is a
	// deliberate order — the panel must not drop it while a live submit is in flight.
	form.dataset.hlForceSubmit = "1";
	if (import.meta.env.DEV) {
		(globalThis as { __hlSubmitCount?: number }).__hlSubmitCount =
			((globalThis as { __hlSubmitCount?: number }).__hlSubmitCount ?? 0) + 1;
	}
	form.requestSubmit();
}

/** How long to keep looking for a form that is still mounting (ms). */
const DEFERRED_SUBMIT_WINDOW_MS = 1_500;

export function submitOrderForm(apply: () => void, onSettled?: (submitted: boolean) => void): boolean {
	if (typeof document === "undefined") return false;
	flushSync(apply);
	const form = document.querySelector<HTMLFormElement>("form[data-order-form]");
	if (form) {
		requestFormSubmit(form);
		return true;
	}
	// The form is not mounted yet. On the phone the Trade section only renders after
	// the tab switch, so Chase Close landed the user on a PREFILLED chase form with
	// nothing submitted (desktop has the panel on screen, so it always hit the form
	// above). Watch briefly for it and submit as soon as it exists — a deliberate
	// order must not be silently dropped.
	if (onSettled) {
		const startedAt = Date.now();
		const poll = () => {
			const late = document.querySelector<HTMLFormElement>("form[data-order-form]");
			if (late) {
				requestFormSubmit(late);
				onSettled(true);
				return;
			}
			if (Date.now() - startedAt < DEFERRED_SUBMIT_WINDOW_MS) {
				requestAnimationFrame(poll);
				return;
			}
			onSettled(false);
		};
		requestAnimationFrame(poll);
	}
	return false;
}
