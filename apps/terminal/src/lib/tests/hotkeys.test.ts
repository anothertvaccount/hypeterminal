// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { STORAGE_KEYS } from "@/config/app";
import { CHART_ACTION_IDS, HELP_HOTKEY, HOTKEYS } from "@/config/hotkeys";
import { isChartOverlayInteractionRecent, noteChartOverlayInteraction } from "@/lib/chart/overlay-interaction";
import { comboDisplay, isEditableTarget, matchesHotkey, parseCombo, shouldHandleHotkey } from "@/lib/hotkeys/engine";
import { clearChartAction, getHeldChartAction, markChartActionHeld, releaseChartAction } from "@/lib/hotkeys/hold-keys";
import {
	applyBinding,
	buildActiveHotkeys,
	isCustomBinding,
	resolveCombo,
	serializeHotkeyEvent,
} from "@/lib/hotkeys/resolve";
import { useHotkeySettingsStore } from "@/stores/use-hotkey-settings-store";

function key(partial: {
	key: string;
	ctrlKey?: boolean;
	metaKey?: boolean;
	altKey?: boolean;
	shiftKey?: boolean;
	repeat?: boolean;
	defaultPrevented?: boolean;
	isComposing?: boolean;
}) {
	return {
		ctrlKey: false,
		metaKey: false,
		altKey: false,
		shiftKey: false,
		...partial,
	};
}

describe("parseCombo", () => {
	it("splits modifiers from the key", () => {
		expect(parseCombo("alt+shift+a")).toEqual({ key: "a", ctrl: false, alt: true, shift: true });
		expect(parseCombo("ctrl+alt+d")).toEqual({ key: "d", ctrl: true, alt: true, shift: false });
		expect(parseCombo("?")).toEqual({ key: "?", ctrl: false, alt: false, shift: false });
	});
});

describe("matchesHotkey", () => {
	it("matches plain letters only with no modifiers and no shift", () => {
		expect(matchesHotkey(key({ key: "w" }), "w")).toBe(true);
		expect(matchesHotkey(key({ key: "w", ctrlKey: true }), "w")).toBe(false);
		expect(matchesHotkey(key({ key: "w", altKey: true }), "w")).toBe(false);
		expect(matchesHotkey(key({ key: "w", shiftKey: true }), "w")).toBe(false);
		// A bare uppercase W (Caps Lock, no shiftKey) still triggers the plain binding.
		expect(matchesHotkey(key({ key: "W" }), "w")).toBe(true);
		expect(matchesHotkey(key({ key: "W", shiftKey: true }), "w")).toBe(false);
	});

	it("never lets Shift+B / Shift+S trigger the plain keys (chart-reserved)", () => {
		expect(matchesHotkey(key({ key: "b", shiftKey: true }), "b")).toBe(false);
		expect(matchesHotkey(key({ key: "s", shiftKey: true }), "s")).toBe(false);
		expect(matchesHotkey(key({ key: "b" }), "b")).toBe(true);
	});

	it("matches punctuation keys regardless of shift (Shift+/ produces ?)", () => {
		expect(matchesHotkey(key({ key: "?", shiftKey: true }), HELP_HOTKEY)).toBe(true);
		expect(matchesHotkey(key({ key: "?" }), HELP_HOTKEY)).toBe(true);
	});

	it("requires the exact modifier set for combos", () => {
		expect(matchesHotkey(key({ key: "a", altKey: true, shiftKey: true }), "alt+shift+a")).toBe(true);
		expect(matchesHotkey(key({ key: "a" }), "alt+shift+a")).toBe(false);
		expect(matchesHotkey(key({ key: "a", altKey: true }), "alt+shift+a")).toBe(false);
		expect(matchesHotkey(key({ key: "a", ctrlKey: true, altKey: true }), "ctrl+alt+a")).toBe(true);
		expect(matchesHotkey(key({ key: "a", ctrlKey: true, shiftKey: true }), "ctrl+alt+a")).toBe(false);
		expect(matchesHotkey(key({ key: "a", ctrlKey: true, shiftKey: true }), "ctrl+shift+a")).toBe(true);
		expect(matchesHotkey(key({ key: "a", ctrlKey: true, shiftKey: true }), "alt+shift+a")).toBe(false);
	});

	it("treats Cmd as Ctrl so macOS bindings work", () => {
		expect(matchesHotkey(key({ key: "a", metaKey: true, altKey: true }), "ctrl+alt+a")).toBe(true);
		expect(matchesHotkey(key({ key: "w", metaKey: true }), "w")).toBe(false);
	});
});

describe("event guards", () => {
	it("refuses repeats, composed input, and pre-claimed events", () => {
		expect(shouldHandleHotkey(key({ key: "w", repeat: true }), null)).toBe(false);
		expect(shouldHandleHotkey(key({ key: "w", isComposing: true }), null)).toBe(false);
		expect(shouldHandleHotkey(key({ key: "w", defaultPrevented: true }), null)).toBe(false);
		expect(shouldHandleHotkey(key({ key: "w" }), null)).toBe(true);
	});

	it("never fires while typing in form fields or contenteditable regions", () => {
		const input = document.createElement("input");
		const textarea = document.createElement("textarea");
		const select = document.createElement("select");
		const editable = document.createElement("div");
		editable.setAttribute("contenteditable", "true");
		const plain = document.createElement("div");
		document.body.append(input, textarea, select, editable, plain);

		expect(isEditableTarget(input)).toBe(true);
		expect(isEditableTarget(textarea)).toBe(true);
		expect(isEditableTarget(select)).toBe(true);
		expect(isEditableTarget(editable)).toBe(true);
		expect(isEditableTarget(plain)).toBe(false);
		expect(shouldHandleHotkey(key({ key: "w" }), input)).toBe(false);
		expect(shouldHandleHotkey(key({ key: "w" }), plain)).toBe(true);
	});
});

describe("comboDisplay", () => {
	it("renders help-friendly labels", () => {
		expect(comboDisplay("alt+shift+a")).toBe("Alt + Shift + A");
		expect(comboDisplay("ctrl+alt+d")).toBe("Ctrl + Alt + D");
		expect(comboDisplay("w")).toBe("W");
		expect(comboDisplay(HELP_HOTKEY)).toBe("?");
		expect(comboDisplay(null)).toBe("—");
	});
});

describe("hotkey table invariants (documented defaults)", () => {
	it("binds each combo exactly once", () => {
		const combos = HOTKEYS.map((hotkey) => hotkey.combo).filter((combo): combo is string => combo !== null);
		expect(new Set(combos).size).toBe(combos.length);
	});

	it("every available action is default-bound or bindable with a blank key", () => {
		for (const hotkey of HOTKEYS) {
			if (hotkey.availability === "available") {
				expect(hotkey.combo === null || typeof hotkey.combo === "string").toBe(true);
			}
		}
		const activeIds = buildActiveHotkeys({}).map((h) => h.id);
		for (const id of [
			"marketBuy",
			"marketSell",
			"flattenPositions",
			"marketClosePosition",
			"limitClosePosition",
			"chaseClosePosition",
			"sizePreset1",
			"sizePreset5",
		]) {
			expect(activeIds).toContain(id);
		}
		expect(activeIds).not.toContain("sizePreset6");
	});

	it("never binds the chart-reserved Shift+B / Shift+S", () => {
		const combos = HOTKEYS.map((hotkey) => hotkey.combo);
		expect(combos).not.toContain("shift+b");
		expect(combos).not.toContain("shift+s");
		// Plain b/s are bound without shift (matcher enforces no-shift for letters).
		for (const combo of ["b", "s"]) {
			const parsed = parseCombo(combo);
			expect(parsed.shift).toBe(false);
		}
	});

	it("keeps every chart action available and resolvable", () => {
		for (const id of CHART_ACTION_IDS) {
			const hotkey = HOTKEYS.find((entry) => entry.id === id);
			expect(hotkey?.availability).toBe("available");
			expect(resolveCombo(id, {})).not.toBeNull();
		}
	});
});

describe("held chart actions (rebind-proof)", () => {
	beforeEach(() => clearChartAction());

	it("marks, reads, releases by key, and clears", () => {
		expect(getHeldChartAction()).toBeNull();
		markChartActionHeld("buyAtClick", "d");
		expect(getHeldChartAction()).toBe("buyAtClick");
		releaseChartAction("x"); // wrong key - stays held
		expect(getHeldChartAction()).toBe("buyAtClick");
		releaseChartAction("d");
		expect(getHeldChartAction()).toBeNull();
		markChartActionHeld("tpAtClick", "b");
		clearChartAction();
		expect(getHeldChartAction()).toBeNull();
	});
});

describe("overlay interaction stamp", () => {
	it("is recent right after a note and expires after the window", () => {
		noteChartOverlayInteraction(1_000);
		expect(isChartOverlayInteractionRecent(300, 1_100)).toBe(true);
		expect(isChartOverlayInteractionRecent(300, 1_400)).toBe(false);
	});
});

describe("hotkey settings store", () => {
	beforeEach(() => {
		localStorage.clear();
		useHotkeySettingsStore.setState({ enabled: true, helpOpen: false });
	});

	it("defaults to enabled and persists only the toggle", () => {
		expect(useHotkeySettingsStore.getState().enabled).toBe(true);
		useHotkeySettingsStore.getState().actions.toggleEnabled();
		expect(useHotkeySettingsStore.getState().enabled).toBe(false);

		useHotkeySettingsStore.getState().actions.setHelpOpen(true);
		const raw = localStorage.getItem(STORAGE_KEYS.HOTKEYS);
		expect(raw).not.toBeNull();
		expect(raw).toContain("enabled");
		expect(raw).not.toContain("helpOpen");
	});
});

describe("binding resolution and rebinding", () => {
	const OVERRIDES: Record<string, string | null> = {};

	it("falls back to documented defaults without overrides", () => {
		expect(resolveCombo("togglePostOnly", OVERRIDES)).toBe("q");
		expect(resolveCombo("buyAtClick", OVERRIDES)).toBe("a");
	});

	it("honors overrides, including explicit unbinding", () => {
		expect(resolveCombo("togglePostOnly", { togglePostOnly: "j" })).toBe("j");
		expect(resolveCombo("togglePostOnly", { togglePostOnly: null })).toBeNull();
	});

	it("swaps combos on conflict so every key stays unique", () => {
		// Bind buy-at-click to D (sell-at-click's default): sell gets A back.
		const next = applyBinding({}, "buyAtClick", "d");
		expect(resolveCombo("buyAtClick", next)).toBe("d");
		expect(resolveCombo("sellAtClick", next)).toBe("a");
		const combos = buildActiveHotkeys(next)
			.map((h) => h.combo)
			.filter(Boolean);
		expect(new Set(combos).size).toBe(combos.length);
	});

	it("unbinding removes the key from the active set", () => {
		const next = applyBinding({}, "cancelAllOrders", null);
		expect(resolveCombo("cancelAllOrders", next)).toBeNull();
		expect(buildActiveHotkeys(next).find((h) => h.id === "cancelAllOrders")?.combo).toBeNull();
		expect(isCustomBinding("cancelAllOrders", next)).toBe(true);
		expect(isCustomBinding("cancelRecent", next)).toBe(false);
	});

	it("serializes keydowns into canonical combos", () => {
		expect(serializeHotkeyEvent({ key: "a", ctrlKey: true, metaKey: false, altKey: true, shiftKey: false })).toBe(
			"ctrl+alt+a",
		);
		expect(serializeHotkeyEvent({ key: "B", ctrlKey: false, metaKey: false, altKey: false, shiftKey: true })).toBe(
			"shift+b",
		); // canonical lowercase (parse/compare are case-insensitive)
		expect(serializeHotkeyEvent({ key: "?", ctrlKey: false, metaKey: false, altKey: false, shiftKey: true })).toBe("?");
		expect(
			serializeHotkeyEvent({ key: "Shift", ctrlKey: false, metaKey: false, altKey: false, shiftKey: true }),
		).toBeNull();
		expect(
			serializeHotkeyEvent({ key: "Escape", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false }),
		).toBeNull();
		expect(serializeHotkeyEvent({ key: "k", ctrlKey: false, metaKey: true, altKey: false, shiftKey: false })).toBe(
			"ctrl+k",
		);
	});
});
