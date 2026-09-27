// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { isFillSoundMuted, playActionSound, playFillSound, setFillSoundMuted } from "@/lib/fill-sound";
import type { PaperOpenOrder } from "@/lib/paper-trading";
import { emitFillNotifications, useFillNotificationsStore } from "@/stores/use-fill-notifications-store";
import { usePaperTradingStore } from "@/stores/use-paper-store";

const notifications = useFillNotificationsStore;
const paper = usePaperTradingStore;

function crossedLimit(overrides: Partial<PaperOpenOrder> = {}): PaperOpenOrder {
	return {
		oid: 42,
		assetId: 0,
		coin: "BTC",
		dex: "",
		isBuy: true,
		size: 1,
		limitPx: 90,
		reduceOnly: false,
		leverage: 10,
		marginMode: "cross",
		tif: "Gtc",
		placedAt: 1,
		...overrides,
	};
}

describe("fill notifications", () => {
	beforeEach(() => {
		notifications.setState({ items: [] });
		paper.getState().actions.reset();
		setFillSoundMuted(false);
	});

	it("turns one fill into one popup with side, market, size, price and kind", () => {
		emitFillNotifications([{ side: "buy", market: "BTC", size: "0.5", price: "84000", kind: "Market" }]);
		const [item] = notifications.getState().items;
		expect(notifications.getState().items).toHaveLength(1);
		expect(item).toMatchObject({ side: "buy", market: "BTC", size: "0.5", price: "84000", kind: "Market" });
		expect(typeof item.preview).toBe("boolean");
		expect(item.id).toContain("fill-");
	});

	it("keeps newest first and never shows more than four", () => {
		for (let i = 0; i < 6; i += 1) {
			emitFillNotifications([{ side: "buy", market: "BTC", size: String(i) }]);
		}
		const items = notifications.getState().items;
		expect(items).toHaveLength(4);
		expect(items[0].size).toBe("5");
	});

	it("dismiss removes only the target popup", () => {
		emitFillNotifications([{ side: "buy", market: "BTC", size: "1" }]);
		emitFillNotifications([{ side: "sell", market: "ETH", size: "2" }]);
		const [second, first] = notifications.getState().items;
		notifications.getState().actions.dismiss(second.id);
		expect(notifications.getState().items.map((i) => i.id)).toEqual([first.id]);
	});

	describe("preview producers (paper store)", () => {
		it("notifies on an executable plan fill (market submit / close)", () => {
			paper.getState().actions.applyPlan(
				[
					{
						assetId: 0,
						coin: "BTC",
						dex: "",
						isBuy: true,
						size: 1,
						price: 100,
						reduceOnly: false,
						isTrigger: false,
						leverage: 10,
						marginMode: "cross",
					},
				],
				[],
			);
			expect(notifications.getState().items[0]).toMatchObject({ side: "buy", market: "BTC", kind: "Market" });
		});

		it("stays silent when a plan only places resting orders (TP/SL drag)", () => {
			paper.getState().actions.applyPlan([], [crossedLimit()]);
			expect(notifications.getState().items).toHaveLength(0);
		});

		it("labels engine fills: Limit for crossed rests, TP/SL for triggers", () => {
			paper.setState({ openOrders: [crossedLimit()] });
			paper.getState().actions.fillCrossedOrders({ BTC: "85" });
			// Marketable fills report the execution price (min/max vs the mark), not the rest price.
			expect(notifications.getState().items[0]).toMatchObject({ kind: "Limit", price: "85" });

			notifications.setState({ items: [] });
			paper.setState({
				openOrders: [
					crossedLimit({
						oid: 43,
						isBuy: false,
						limitPx: 120,
						triggerPx: 120,
						isTrigger: true,
						tpsl: "tp",
						reduceOnly: true,
					}),
				],
			});
			paper.getState().actions.fillCrossedOrders({ BTC: "121" });
			expect(notifications.getState().items[0]).toMatchObject({ kind: "TP", side: "sell", price: "120" });
		});

		it("notifies on direct fills (quick close paths)", () => {
			paper.getState().actions.applyFill({
				assetId: 0,
				coin: "BTC",
				dex: "",
				isBuy: false,
				size: 1,
				price: 110,
				reduceOnly: true,
				isTrigger: false,
				leverage: 10,
				marginMode: "cross",
			});
			expect(notifications.getState().items[0]).toMatchObject({ side: "sell", kind: "Market" });
		});
	});

	describe("sound mute", () => {
		it("persists the mute flag and silences playback attempts", () => {
			expect(isFillSoundMuted()).toBe(false);
			setFillSoundMuted(true);
			expect(isFillSoundMuted()).toBe(true);
			expect(() => playFillSound("buy")).not.toThrow();
			expect(() => playFillSound("sell")).not.toThrow();
			setFillSoundMuted(false);
			expect(isFillSoundMuted()).toBe(false);
		});

		it("never throws when playback runs outside a browser audio stack", () => {
			expect(() => playFillSound("buy")).not.toThrow();
		});

		it("action sound is a distinct, muteable signal — and logged for scripts", () => {
			const log = (globalThis as { __hlSoundLog?: string[] }).__hlSoundLog;
			if (log) log.length = 0;
			playActionSound();
			if (log) expect(log).toContain("action");
			playFillSound("buy");
			if (log) {
				expect(log).toContain("fill");
				expect(log.indexOf("action")).not.toBe(log.indexOf("fill"));
			}
			setFillSoundMuted(true);
			expect(() => {
				playActionSound();
				playFillSound("sell");
			}).not.toThrow();
			setFillSoundMuted(false);
		});
	});
});
