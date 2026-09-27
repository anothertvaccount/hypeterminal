// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { submitOrderForm } from "@/lib/trade/submit-order-form";

/**
 * submitOrderForm marks the form so the panel skips ONLY its in-flight guard:
 * rapid hold-key + click spam each places its own order (every press is a
 * deliberate gesture), while the manual button keeps double-submit protection.
 */
describe("submitOrderForm force flag", () => {
	it("flags the form before requesting submission", () => {
		const form = document.createElement("form");
		form.setAttribute("data-order-form", "");
		form.requestSubmit = () => {}; // jsdom may not dispatch submit
		document.body.appendChild(form);
		expect(submitOrderForm(() => {})).toBe(true);
		expect(form.dataset.hlForceSubmit).toBe("1");
		form.remove();
	});

	it("returns false when the order form is absent", () => {
		expect(submitOrderForm(() => {})).toBe(false);
	});
});

/**
 * Mobile Chase Close switches to the Trade section and submits in one gesture. The
 * form only exists after that section mounts, so a purely synchronous lookup found
 * nothing and the user was left staring at a prefilled chase form with nothing
 * placed. submitOrderForm now waits briefly for the form and submits when it lands.
 */
describe("submitOrderForm deferred submit", () => {
	it("submits once the form finishes mounting", async () => {
		const onSettled = vi.fn<(submitted: boolean) => void>();
		expect(submitOrderForm(() => {}, onSettled)).toBe(false);

		// The Trade section mounts a frame later.
		await new Promise<void>((resolve) => {
			requestAnimationFrame(() => {
				const form = document.createElement("form");
				form.setAttribute("data-order-form", "");
				const requestSubmit = vi.fn();
				form.requestSubmit = requestSubmit;
				document.body.appendChild(form);
				(requestSubmit as unknown as { __form: HTMLFormElement }).__form = form;
				resolve();
			});
		});

		await new Promise<void>((resolve) => {
			requestAnimationFrame(() => {
				const form = document.querySelector<HTMLFormElement>("form[data-order-form]");
				expect(form?.dataset.hlForceSubmit).toBe("1");
				form?.remove();
				resolve();
			});
		});
		expect(onSettled).toHaveBeenCalledWith(true);
	});

	it("reports failure when no form ever appears", async () => {
		const onSettled = vi.fn<(submitted: boolean) => void>();
		submitOrderForm(() => {}, onSettled);
		await new Promise((resolve) => setTimeout(resolve, 1_700));
		expect(onSettled).toHaveBeenCalledWith(false);
	});
});
