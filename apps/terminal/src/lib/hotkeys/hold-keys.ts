/**
 * Held *chart action* state (action-based, not letter-based, so rebinds keep
 * hold+click working): the global listener records which chart action matched on
 * keydown; the chart's mouse-up handler reads it; keyup/blur release it.
 */

interface HeldChartAction {
	id: string;
	key: string;
}

let held: HeldChartAction | null = null;

export function markChartActionHeld(id: string, key: string): void {
	held = { id, key };
}

export function releaseChartAction(key: string): void {
	if (held && held.key === key) held = null;
}

export function clearChartAction(): void {
	held = null;
}

export function getHeldChartAction(): string | null {
	return held?.id ?? null;
}

if (import.meta.env.DEV) {
	// Debug affordance for browser test scripts (dev builds only).
	(globalThis as { __hlHold?: { get: () => string | null } }).__hlHold = { get: getHeldChartAction };
}
