import { t } from "@lingui/core/macro";
import { PAPER_TRADE } from "@/config/paper";
import { getPositionDex } from "@/domain/market";
import type { OrderPlan } from "@/domain/trade/order-intent";
import { formatPriceForOrder } from "@/domain/trade/orders";
import { playActionSound } from "@/lib/fill-sound";
import { getInfoClient, useExchange, useMarkets } from "@/lib/hyperliquid";
import { derivePaperResult, type PaperMarketResolver, type PaperOrderMeta, splitPaperPlan } from "@/lib/paper-trading";
import { interpretOrderStatuses, type OrderResult } from "@/lib/trade/extract-order-status";
import { usePaperActions } from "@/stores/use-paper-store";

export type SubmitPlanInput = Pick<OrderPlan, "orders" | "grouping"> & { errors?: string[] };

interface UseSubmitPlanResult {
	submitPlan: (plan: SubmitPlanInput, meta?: PaperOrderMeta) => Promise<OrderResult>;
	isSubmitting: boolean;
}

export function useSubmitPlan(): UseSubmitPlanResult {
	const { mutateAsync: placeOrder, isPending: isSubmitting } = useExchange("order");
	const paperActions = usePaperActions();
	const markets = useMarkets();

	// Plans are single-asset: resolve coin/dex so callers that only pass an assetId
	// (close/TP-SL modals) still produce chartable, displayable paper orders.
	const resolveMarket: PaperMarketResolver = (assetId) => {
		const market = markets.all.find((m) => m.assetId === assetId);
		if (!market) return undefined;
		return { coin: market.name, dex: getPositionDex(market) };
	};

	/** True for market/IOC legs (they execute immediately instead of resting). */
	function isMarketExecutionLeg(order: SubmitPlanInput["orders"][number]): boolean {
		if ("trigger" in order.t) return false;
		const tif = order.t.limit.tif;
		return tif === "FrontendMarket" || tif === "Ioc";
	}

	/** Current mark for the plan's market, so preview market fills match the screen. */
	async function currentMarkPx(assetId: number | undefined, meta: PaperOrderMeta | undefined): Promise<number> {
		if (assetId === undefined) return 0;
		const market = markets.all.find((m) => m.assetId === assetId);
		const dex = market ? getPositionDex(market) : meta?.dex || undefined;
		const coin = market?.name ?? meta?.coin ?? "";
		if (!coin) return 0;
		try {
			const mids = await getInfoClient().allMids(dex ? { dex } : undefined);
			const raw = Number(mids[coin] ?? mids[dex ? `${dex}:${coin}` : coin] ?? 0);
			return Number.isFinite(raw) && raw > 0 ? raw : 0;
		} catch {
			return 0;
		}
	}

	async function paperOrdersAtMark(
		orders: SubmitPlanInput["orders"],
		meta: PaperOrderMeta | undefined,
	): Promise<SubmitPlanInput["orders"]> {
		const marketLeg = orders.find((order) => isMarketExecutionLeg(order));
		if (!marketLeg) return orders;
		// Bounded: a slow or rate-limited info API must never stall the submit itself.
		// The mark is a nicety here (the plan price already fills at the book in
		// preview terms), so timing out just keeps the plan price.
		const mark = await Promise.race([
			currentMarkPx(Number(marketLeg.a), meta),
			new Promise<number>((resolve) => setTimeout(() => resolve(0), 1500)),
		]);
		if (mark <= 0) return orders;
		return orders.map((order) => (isMarketExecutionLeg(order) ? { ...order, p: formatPriceForOrder(mark) } : order));
	}

	async function submitPlan(plan: SubmitPlanInput, meta?: PaperOrderMeta): Promise<OrderResult> {
		if (plan.errors && plan.errors.length > 0) {
			return { ok: false, error: plan.errors.join("; ") };
		}
		if (PAPER_TRADE) {
			// Simulate locally — market legs fill, Gtc/Alo limits rest on the book, nothing is signed.
			// Market legs carry mark ± the slippage allowance (that cap is for the live
			// exchange, which fills at the book). Preview has no book, so fill at the
			// mark the user is looking at — otherwise positions open visibly off-price.
			const orders = await paperOrdersAtMark(plan.orders, meta);
			const split = splitPaperPlan(orders, meta, resolveMarket);
			paperActions.applyPlan(split.fills, split.resting);
			return derivePaperResult(plan.orders, split);
		}
		try {
			if (import.meta.env.DEV) {
				const first = plan.orders[0];
				const firstIsTrigger = Boolean(first && "trigger" in first.t);
				if (plan.grouping === "normalTpsl" && plan.orders.length === 1 && firstIsTrigger) {
					// The exchange rejects this with "Main order cannot be trigger order";
					// flag it locally so a future caller can't ship it silently.
					console.error("[plan] trigger-only batch under normalTpsl — must be positionTpsl", plan);
				}
			}
			const result = await placeOrder({ orders: plan.orders, grouping: plan.grouping });
			const status = interpretOrderStatuses(result.response?.data?.statuses ?? []);
			// Placements tick; fills announce through the userFills stream instead.
			if (status.ok && status.outcome !== "filled") playActionSound();
			return status;
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : t`Order failed` };
		}
	}

	return { submitPlan, isSubmitting };
}
