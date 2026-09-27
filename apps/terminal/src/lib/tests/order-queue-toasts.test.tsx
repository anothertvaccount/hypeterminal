// @vitest-environment jsdom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOrderQueueToasts } from "@/hooks/trade/use-order-queue-toasts";
import { useOrderQueueActions } from "@/stores/use-order-queue-store";

vi.mock("@lingui/core/macro", () => ({
	t: (strings: TemplateStringsArray | string, ...values: unknown[]) => {
		if (typeof strings === "string") return strings;
		return strings.reduce((message, part, index) => `${message}${part}${values[index] ?? ""}`, "");
	},
}));

const toastError = vi.fn();
const toastSuccess = vi.fn();

vi.mock("sonner", () => ({
	toast: {
		error: (...args: unknown[]) => toastError(...args),
		success: (...args: unknown[]) => toastSuccess(...args),
	},
}));

type QueueActions = ReturnType<typeof useOrderQueueActions>;
let actions: QueueActions | null = null;

function Probe({ capture = false }: { capture?: boolean }) {
	useOrderQueueToasts();
	// The store is only exposed through hooks, so the actions come from a render. The
	// hook is called unconditionally — conditionally calling it is a hook-order bug.
	const queueActions = useOrderQueueActions();
	if (capture) actions = queueActions;
	return null;
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function render(node: ReactNode) {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	act(() => {
		root?.render(node);
	});
}

function mountProbe(capture = false) {
	render(createElement(Probe, { capture }));
}

function unmount() {
	if (root) act(() => root?.unmount());
	container?.remove();
	container = null;
	root = null;
}

describe("useOrderQueueToasts", () => {
	beforeEach(() => {
		toastError.mockClear();
		toastSuccess.mockClear();
		actions = null;
	});

	afterEach(() => {
		unmount();
	});

	it("stays quiet for rows that already failed before mount", () => {
		// Seed a failure with the watcher NOT mounted, then mount it: a page reload
		// must not replay every old failure as a fresh toast.
		mountProbe(true);
		let id = "";
		act(() => {
			id = actions?.addOrder({ market: "BTC", side: "buy", size: "1", status: "pending" }) ?? "";
		});
		act(() => {
			actions?.updateOrder(id, { status: "failed", error: "stale failure" });
		});
		unmount();
		toastError.mockClear();

		mountProbe();
		expect(toastError).not.toHaveBeenCalled();
	});

	it("announces an order that fails while mounted, with the reason", () => {
		mountProbe(true);
		let id = "";
		act(() => {
			id = actions?.addOrder({ market: "BTC", side: "sell", size: "0.1", status: "pending" }) ?? "";
		});
		act(() => {
			actions?.updateOrder(id, { status: "failed", error: "Post-only chase needs a fresh book snapshot" });
		});
		expect(toastError).toHaveBeenCalledTimes(1);
		const [title, options] = toastError.mock.calls[0] as [string, { description?: string }];
		expect(title).toContain("BTC");
		expect(options?.description).toBe("Post-only chase needs a fresh book snapshot");
	});

	it("announces a failure only once, even if the row is updated again", () => {
		mountProbe(true);
		let id = "";
		act(() => {
			id = actions?.addOrder({ market: "ETH", side: "buy", size: "1", status: "pending" }) ?? "";
		});
		act(() => {
			actions?.updateOrder(id, { status: "failed", error: "nope" });
		});
		act(() => {
			actions?.updateOrder(id, { error: "nope (edited)" });
		});
		expect(toastError).toHaveBeenCalledTimes(1);
	});

	it("announces a filled market order but stays quiet for resting limits", () => {
		mountProbe(true);
		let market = "";
		let limit = "";
		act(() => {
			market =
				actions?.addOrder({ market: "BTC", side: "buy", size: "1", orderType: "market", status: "pending" }) ?? "";
			limit = actions?.addOrder({ market: "BTC", side: "buy", size: "1", orderType: "limit", status: "pending" }) ?? "";
		});
		act(() => {
			actions?.updateOrder(market, { status: "success", outcome: "filled" });
			actions?.updateOrder(limit, { status: "success", outcome: "resting" });
		});
		expect(toastSuccess).toHaveBeenCalledTimes(1);
	});
});
