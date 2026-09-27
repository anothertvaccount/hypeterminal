import { t } from "@lingui/core/macro";
import { HL_ALL_DEXS } from "@/config/app";
import { PAPER_TRADE } from "@/config/paper";
import {
	CHASE_BOOK_READ_ATTEMPTS,
	CHASE_BOOK_READ_BACKOFF_MS,
	type LimitTif,
	type OrderType,
	TWAP_MINUTES_MAX,
	TWAP_MINUTES_MIN,
} from "@/config/trade";
import {
	CHASE_PLACE_MAX_RETRIES,
	chaseBehindMarkPrice,
	chasePlacementPrice,
	isPostOnlyRaceError,
} from "@/domain/trade/order/chase";
import { buildOrderPlan } from "@/domain/trade/order-intent";
import { formatPriceForOrder, formatSizeForOrder, throwIfResponseError } from "@/domain/trade/orders";
import { useSubmitPlan } from "@/hooks/trade/use-submit-plan";
import { getInfoClient, useExchange, useTradingSession } from "@/lib/hyperliquid";
import type { MarginMode } from "@/lib/trade/margin-mode";
import { clampInt, isPositive } from "@/lib/trade/numbers";
import {
	isAmbiguousSubmitError,
	matchesSubmittedOrder,
	type SubmittedOrderFingerprint,
} from "@/lib/trade/submit-verify";
import type { Side } from "@/lib/trade/types";
import { useChaseOrderStore } from "@/stores/use-chase-order-store";
import { useOrderEntryActions } from "@/stores/use-order-entry-store";
import { useOrderQueueActions } from "@/stores/use-order-queue-store";
import { usePaperActions } from "@/stores/use-paper-store";

interface SubmitMarket {
	assetId: number;
	szDecimals?: number;
	/** Market name (coin) — used to key simulated positions in paper mode. */
	coin?: string;
	/** Position dex — "" for main perps, builder dex name for builder perps. */
	dex?: string;
}

export interface OrderSubmitInput {
	market: SubmitMarket;
	baseToken: string;
	side: Side;
	orderType: OrderType;
	sizeValue: number;
	price: number;
	markPx: number;
	slippageBps: number;
	reduceOnly: boolean;
	tif: LimitTif;
	/** Applied leverage — recorded on simulated positions in paper mode. */
	leverage?: number;
	/** Applied margin mode — recorded on simulated positions in paper mode. */
	marginMode?: MarginMode;
	limitPriceInput: string;
	triggerPriceInput: string;
	scaleStartPriceInput: string;
	scaleEndPriceInput: string;
	scaleLevelsNum: number | null;
	scalePriceDist?: number[] | null;
	scaleAmountDist?: number[] | null;
	twapMinutesNum: number | null;
	twapRandomize: boolean;
	tpSlEnabled: boolean;
	canUseTpSl: boolean;
	tpPriceNum: number | null;
	slPriceNum: number | null;
	twapOrder: boolean;
	scaleOrder: boolean;
	triggerOrder: boolean;
}

interface UseOrderSubmitResult {
	handleSubmit: (input: OrderSubmitInput) => Promise<boolean>;
	isSubmitting: boolean;
}

type QueueOrderType = "twap" | "scale" | "trigger" | "limit" | "market";

function getQueueOrderType(input: OrderSubmitInput): QueueOrderType {
	if (input.twapOrder) return "twap";
	if (input.scaleOrder) return "scale";
	if (input.triggerOrder) return "trigger";
	if (input.orderType === "limit" || input.orderType === "chaseLimit") return "limit";
	return "market";
}

/** Bounded backoff between chase book re-reads (see CHASE_BOOK_READ_*). */
function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function useOrderSubmit(): UseOrderSubmitResult {
	// Post-submit verification polls the account's open orders — that is the
	// session's account, which is the linked key's owner when there is no wallet.
	const { address } = useTradingSession();
	const { submitPlan, isSubmitting: isSubmittingOrder } = useSubmitPlan();
	const { mutateAsync: placeTwapOrder, isPending: isSubmittingTwap } = useExchange("twapOrder");
	const { addOrder, updateOrder } = useOrderQueueActions();
	const { resetForm } = useOrderEntryActions();
	const paperActions = usePaperActions();

	const isSubmitting = isSubmittingOrder || isSubmittingTwap;

	/** Poll the exchange's open orders for something that looks like our order. */
	async function orderLandedOnExchange(fingerprint: SubmittedOrderFingerprint): Promise<boolean> {
		if (!address) return false;
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				const rows = await getInfoClient().openOrders({ user: address, dex: HL_ALL_DEXS });
				if (rows.some((row) => matchesSubmittedOrder(row, fingerprint))) return true;
			} catch {
				// The network that timed out may still be flaky — try again.
			}
			await new Promise((resolve) => setTimeout(resolve, 1200));
		}
		return false;
	}

	async function handleSubmit(input: OrderSubmitInput): Promise<boolean> {
		const {
			market,
			baseToken,
			side,
			orderType,
			sizeValue,
			price: formPrice,
			markPx,
			slippageBps,
			reduceOnly,
			tif,
			limitPriceInput: formLimitPriceInput,
			triggerPriceInput,
			scaleStartPriceInput,
			scaleEndPriceInput,
			scaleLevelsNum,
			scalePriceDist,
			scaleAmountDist,
			twapMinutesNum,
			twapRandomize,
			tpSlEnabled,
			canUseTpSl,
			tpPriceNum,
			slPriceNum,
			twapOrder,
		} = input;

		const szDecimals = market.szDecimals ?? 0;
		const isChase = orderType === "chaseLimit";
		// Chase placeholder for the queue row; live placement replaces it with the
		// book touch below (preview keeps mark − tick throughout).
		let price = isChase ? chaseBehindMarkPrice(side, markPx, szDecimals) : formPrice;
		let limitPriceInput = isChase ? formatPriceForOrder(price) : formLimitPriceInput;
		const formattedSize = formatSizeForOrder(sizeValue, szDecimals);
		const formattedPrice = formatPriceForOrder(price);

		const hasTp = tpSlEnabled && canUseTpSl && isPositive(tpPriceNum);
		const hasSl = tpSlEnabled && canUseTpSl && isPositive(slPriceNum);

		const orderId = addOrder({
			market: baseToken,
			side,
			size: formattedSize,
			price: formattedPrice,
			orderType: getQueueOrderType(input),
			tpPrice: hasTp ? formatPriceForOrder(tpPriceNum ?? 0) : undefined,
			slPrice: hasSl ? formatPriceForOrder(slPriceNum ?? 0) : undefined,
			status: "pending",
		});

		try {
			if (twapOrder) {
				if (PAPER_TRADE) {
					// Preview: fill the full size instantly at the entry price — no scheduling, no network.
					paperActions.applyFill({
						assetId: market.assetId,
						coin: market.coin ?? baseToken,
						dex: market.dex,
						isBuy: side === "buy",
						size: sizeValue,
						price,
						reduceOnly,
						isTrigger: false,
						leverage: input.leverage ?? 10,
						marginMode: input.marginMode ?? "cross",
					});
					updateOrder(orderId, { status: "success", outcome: "filled" });
					resetForm();
					return true;
				}
				const minutes = clampInt(Math.round(twapMinutesNum ?? 0), TWAP_MINUTES_MIN, TWAP_MINUTES_MAX);
				const result = await placeTwapOrder({
					twap: {
						a: market.assetId,
						b: side === "buy",
						s: formattedSize,
						r: reduceOnly,
						m: minutes,
						t: twapRandomize,
					},
				});
				throwIfResponseError(result.response?.data?.status);
				updateOrder(orderId, { status: "success", outcome: "twapStarted" });
				resetForm();
				return true;
			} else {
				// Chase placement is priced from a FRESH book snapshot: the touch is
				// non-marketable by construction, which is what makes post-only (Alo)
				// safe and keeps the order maker-side (GTC joins the touch instead of
				// crossing from the mark → no surprise taker fill). Preview has no book
				// to fetch — mark − tick rests until the mark trades through it.
				const resolveChasePrice = async (): Promise<number | null> => {
					if (!isChase) return price;
					if (PAPER_TRADE) return chaseBehindMarkPrice(side, markPx, szDecimals);
					// A post-only chase MUST price off the real touch, so an empty book can't
					// fall back to the mark. One cold l2Book read on a phone (cold
					// subscription, rate limit) can come back with no levels, which used to
					// fail the placement outright with "needs a fresh book snapshot". Try a
					// few times over ~1s before giving up — bounded, so submit never hangs.
					for (let attempt = 0; attempt < CHASE_BOOK_READ_ATTEMPTS; attempt += 1) {
						if (attempt > 0) await delay(CHASE_BOOK_READ_BACKOFF_MS * attempt);
						try {
							const book = await getInfoClient().l2Book({ coin: market.coin ?? baseToken });
							const resolved = chasePlacementPrice(side, book?.levels, markPx, szDecimals, tif);
							if (resolved !== null) return resolved;
						} catch {
							// fall through to the next attempt
						}
					}
					return chasePlacementPrice(side, undefined, markPx, szDecimals, tif);
				};
				if (isChase) {
					const resolved = await resolveChasePrice();
					if (resolved === null) {
						updateOrder(orderId, {
							status: "failed",
							error: "Post-only chase needs a fresh book snapshot — retry in a moment",
						});
						return false;
					}
					price = resolved;
					limitPriceInput = formatPriceForOrder(price);
					updateOrder(orderId, { price: limitPriceInput });
				}
				const buildPlan = () =>
					buildOrderPlan({
						kind: "entry",
						assetId: market.assetId,
						side,
						orderType,
						sizeValue,
						szDecimals,
						markPx,
						price,
						slippageBps,
						reduceOnly,
						tif,
						limitPriceInput,
						triggerPriceInput,
						scaleStartPriceInput,
						scaleEndPriceInput,
						scaleLevelsNum,
						scalePriceDist,
						scaleAmountDist,
						tpSlEnabled,
						canUseTpSl,
						tpPriceNum,
						slPriceNum,
					});
				const meta = {
					coin: market.coin ?? baseToken,
					dex: market.dex,
					leverage: input.leverage,
					marginMode: input.marginMode,
				};
				let plan = buildPlan();
				let result = await submitPlan(plan, meta);
				// A post-only chase can lose the race between its book read and the
				// exchange (~50ms): Hyperliquid rejects the crossing order benignly —
				// re-fetch the book and retry rather than failing the placement.
				let attempts = 0;
				while (
					!result.ok &&
					isChase &&
					!PAPER_TRADE &&
					isPostOnlyRaceError(result.error) &&
					attempts < CHASE_PLACE_MAX_RETRIES
				) {
					attempts += 1;
					const fresh = await resolveChasePrice();
					if (fresh === null) break;
					price = fresh;
					limitPriceInput = formatPriceForOrder(price);
					updateOrder(orderId, { price: limitPriceInput });
					plan = buildPlan();
					result = await submitPlan(plan, meta);
				}

				if (result.ok) {
					updateOrder(orderId, { status: "success", outcome: result.outcome });
					// Hand a resting chase limit to the chase engine (fills report "filled").
					if (orderType === "chaseLimit" && result.outcome !== "filled") {
						useChaseOrderStore.getState().actions.start({
							coin: market.coin ?? baseToken,
							dex: market.dex,
							side,
							sizeText: formattedSize,
							reduceOnly,
							startedAt: Date.now(),
							// A reduce-only chase IS a close — keep going until the position is flat.
							mode: reduceOnly ? "close" : "entry",
						});
					}
				} else {
					updateOrder(orderId, { status: "failed", error: result.error });
				}
				resetForm();
				return result.ok;
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : t`Order failed`;
			// A transport timeout leaves it unknown whether the exchange took the order
			// (network blip, proxy, or a node restart mid-request). Look for it in the
			// book before declaring failure — a blind retry doubles the position.
			if (!PAPER_TRADE && isAmbiguousSubmitError(error)) {
				if (
					await orderLandedOnExchange({
						coin: market.coin ?? baseToken,
						isBuy: side === "buy",
						size: sizeValue,
						price: price > 0 ? price : Number(formLimitPriceInput),
					})
				) {
					updateOrder(orderId, { status: "success", outcome: "resting" });
					resetForm();
					return true;
				}
				updateOrder(orderId, {
					status: "failed",
					error: `${errorMessage} — could not confirm it either way. Check Open Orders before retrying.`,
				});
				return false;
			}
			updateOrder(orderId, { status: "failed", error: errorMessage });
			return false;
		}
	}

	return { handleSubmit, isSubmitting };
}
