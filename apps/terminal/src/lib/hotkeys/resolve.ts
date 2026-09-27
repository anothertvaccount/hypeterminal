import { HOTKEYS, type HotkeyDefinition } from "@/config/hotkeys";

/**
 * Binding resolution: documented defaults overlaid with the user's per-action
 * overrides. Pure functions — the listener, help overlay, settings page and tests all
 * read combos through here so there is exactly one source of truth after a rebind.
 *
 * Conflict policy is a swap: binding action A to action B's key hands A's previous
 * key to B, which keeps every combo unique with no dead ends (unbinding a user-bound
 * action restores… nothing — it stays explicitly unbound until Reset).
 */

export type HotkeyOverrides = Record<string, string | null>;

export function resolveCombo(id: string, overrides: HotkeyOverrides): string | null {
	if (Object.hasOwn(overrides, id)) return overrides[id];
	return HOTKEYS.find((hotkey) => hotkey.id === id)?.combo ?? null;
}

/** Turns a keydown into a canonical combo ("ctrl+alt+a"), or null for pure modifiers / Escape. */
export function serializeHotkeyEvent(event: {
	key: string;
	ctrlKey: boolean;
	metaKey: boolean;
	altKey: boolean;
	shiftKey: boolean;
}): string | null {
	const raw = event.key;
	const lower = raw.toLowerCase();
	if (lower === "escape" || lower === "backspace") return null;
	if (lower === "control" || lower === "shift" || lower === "alt" || lower === "meta") return null;

	// Cmd is serialized as ctrl so bindings are platform-canonical (the matcher
	// accepts either physical modifier for ctrl combos).
	const useCtrl = event.ctrlKey || event.metaKey;
	const key =
		raw.length === 1 && /[a-zA-Z0-9]/.test(raw)
			? raw.toLowerCase()
			: lower.startsWith("arrow")
				? lower
				: raw.length === 1
					? raw
					: lower;

	const parts: string[] = [];
	if (useCtrl) parts.push("ctrl");
	if (event.altKey) parts.push("alt");
	// Keep shift only when it is part of the key identity (letters/digits). For
	// punctuation the shifted form IS the key (Shift+/ produces "?"), so canonical
	// combos drop it — matching how the matcher treats non-letter keys.
	const isLetterOrDigitKey = key.length === 1 && /^[a-z0-9]$/.test(key);
	if (event.shiftKey && isLetterOrDigitKey) parts.push("shift");
	parts.push(key);
	return parts.join("+");
}

/** Binds `id` to `nextCombo` (null = unbound), swapping with any action that held that combo. */
export function applyBinding(overrides: HotkeyOverrides, id: string, nextCombo: string | null): HotkeyOverrides {
	const current = resolveCombo(id, overrides);
	if (current === nextCombo) return overrides;

	const next: HotkeyOverrides = { ...overrides, [id]: nextCombo };
	if (nextCombo === null) return next;

	// Swap: whoever held this combo inherits the binding we just replaced.
	for (const hotkey of HOTKEYS) {
		if (hotkey.id === id) continue;
		if (resolveCombo(hotkey.id, next) === nextCombo) {
			next[hotkey.id] = current;
			break;
		}
	}
	return next;
}

export interface ActiveHotkey {
	id: HotkeyDefinition["id"];
	combo: string | null;
}

/** Available actions with their resolved combos (combo null = user unbound it). */
export function buildActiveHotkeys(overrides: HotkeyOverrides): ActiveHotkey[] {
	return HOTKEYS.filter((hotkey) => hotkey.availability === "available").map((hotkey) => ({
		id: hotkey.id,
		combo: resolveCombo(hotkey.id, overrides),
	}));
}

/** Whether an id's combo has been changed from (or cleared below) its documented default. */
export function isCustomBinding(id: string, overrides: HotkeyOverrides): boolean {
	return Object.hasOwn(overrides, id) && overrides[id] !== resolveCombo(id, {});
}
