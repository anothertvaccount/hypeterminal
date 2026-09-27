/**
 * Pure hotkey engine: combo parsing/matching and event guards. No DOM listeners,
 * no React — everything here is unit-testable. Semantics chosen deliberately:
 *  - `ctrl` bindings match Ctrl **or** Cmd (cross-platform);
 *  - modifier sets match exactly (Ctrl+Shift+A never triggers Alt+Shift+A);
 *  - Shift is enforced for letters/digits (Shift+B must not fire plain `b`, per
 *    the chart-reserved-keys caution) but ignored for punctuation whose shifted
 *    form IS the key (e.g. "?").
 */

export interface HotkeyEventLike {
	key: string;
	ctrlKey: boolean;
	metaKey: boolean;
	altKey: boolean;
	shiftKey: boolean;
	repeat?: boolean;
	defaultPrevented?: boolean;
	isComposing?: boolean;
}

export interface ParsedCombo {
	key: string;
	ctrl: boolean;
	alt: boolean;
	shift: boolean;
}

export function parseCombo(combo: string): ParsedCombo {
	const parts = combo
		.toLowerCase()
		.split("+")
		.map((part) => part.trim())
		.filter(Boolean);
	const parsed: ParsedCombo = { key: "", ctrl: false, alt: false, shift: false };
	for (const part of parts) {
		if (part === "ctrl" || part === "control" || part === "cmd" || part === "meta") parsed.ctrl = true;
		else if (part === "alt" || part === "option") parsed.alt = true;
		else if (part === "shift") parsed.shift = true;
		else parsed.key = part;
	}
	return parsed;
}

function isLetterOrDigit(key: string): boolean {
	return key.length === 1 && /^[a-z0-9]$/.test(key);
}

export function matchesHotkey(event: HotkeyEventLike, combo: string): boolean {
	const parsed = parseCombo(combo);
	if (!parsed.key) return false;
	if (event.key.toLowerCase() !== parsed.key) return false;

	const ctrlHeld = event.ctrlKey || event.metaKey;
	if (parsed.ctrl !== ctrlHeld) return false;
	if (parsed.alt !== event.altKey) return false;

	if (parsed.shift) {
		if (!event.shiftKey) return false;
	} else if (isLetterOrDigit(parsed.key)) {
		if (event.shiftKey) return false;
	}
	return true;
}

const EDITABLE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);
const CONTENTEDITABLE = '[contenteditable]:not([contenteditable="false"])';

export function isEditableTarget(target: EventTarget | null): boolean {
	if (!target || typeof (target as Partial<Element>).closest !== "function") return false;
	const element = target as Element;
	if (element.tagName && EDITABLE_TAGS.has(element.tagName)) return true;
	try {
		return element.closest(CONTENTEDITABLE) !== null;
	} catch {
		return false;
	}
}

/** Central gate: never steal keys while typing, composing (IME), repeating, or when another handler already claimed the event. */
export function shouldHandleHotkey(event: HotkeyEventLike, target: EventTarget | null): boolean {
	if (event.defaultPrevented) return false;
	if (event.isComposing) return false;
	if (event.repeat) return false;
	return !isEditableTarget(target);
}

/** Human-readable combo for the help modal: "ctrl+alt+a" → "Ctrl + Alt + A". */
export function comboDisplay(combo: string | null): string {
	if (!combo) return "—";
	const parsed = parseCombo(combo);
	const mods: string[] = [];
	if (parsed.ctrl) mods.push("Ctrl");
	if (parsed.alt) mods.push("Alt");
	if (parsed.shift) mods.push("Shift");
	const key = parsed.key.length === 1 && isLetterOrDigit(parsed.key) ? parsed.key.toUpperCase() : parsed.key;
	return [...mods, key].join(" + ");
}
