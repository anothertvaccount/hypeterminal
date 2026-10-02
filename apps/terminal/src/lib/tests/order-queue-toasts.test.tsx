// @vitest-environment jsdom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOrderQueueToasts } from "@/hooks/trade/use-order-queue-toasts";
import { type OrderQueueItem, useOrderQueue, useOrderQueueActions } from "@/stores/use-order-queue-store";

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
let queue: OrderQueueItem[] = [];

function Probe({ capture = false }: { capture?: boolean }) {
	useOrderQueueToasts();
	// The store is only exposed through hooks, so the actions come from a render. The
	// hook is called unconditionally — conditionally calling it is a hook-order bug.
	const queueActions = useOrderQueueActions();
	const orders = useOrderQueue();
	if (capture) {
		actions = queueActions;
		queue = orders;
	}
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

	it.each(["direct", "transition"])("excludes a %s Chase failure from the queue and toast", (kind) => {
		mountProbe(true);
		let id = "";
		act(() => {
			id =
				actions?.addOrder({
					source: "chase",
					market: "xyz:SP500",
					side: "sell",
					size: "0.002",
					status: kind === "direct" ? "failed" : "pending",
					error: "Order 0: Order was never placed, already canceled, or filled. asset=110052",
				}) ?? "";
		});
		if (kind === "transition") act(() => actions?.updateOrder(id, { status: "failed" }));
		expect(queue.some((order) => order.id === id)).toBe(false);
		expect(toastError).not.toHaveBeenCalled();
	});

	it("keeps pending and successful Chase confirmations in the queue", () => {
		mountProbe(true);
		let id = "";
		act(() => {
			id = actions?.addOrder({ source: "chase", market: "BTC", side: "buy", size: "1", status: "pending" }) ?? "";
		});
		expect(queue.find((order) => order.id === id)?.status).toBe("pending");
		act(() => actions?.updateOrder(id, { status: "success", outcome: "resting" }));
		expect(queue.find((order) => order.id === id)?.status).toBe("success");
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
			actions?.updateOrder(id, {
				status: "failed",
				error: "Order 0: Order was never placed, already canceled, or filled. asset=110052",
			});
		});
		expect(queue.find((order) => order.id === id)?.status).toBe("failed");
		expect(toastError).toHaveBeenCalledTimes(1);
		const [title, options] = toastError.mock.calls[0] as [string, { description?: string }];
		expect(title).toContain("BTC");
		expect(options?.description).toBe("Order 0: Order was never placed, already canceled, or filled. asset=110052");
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
