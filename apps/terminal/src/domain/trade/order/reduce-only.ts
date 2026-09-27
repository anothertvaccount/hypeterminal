export interface ReduceOnlyMaxInput {
	/** Absolute size of the current position in base units (0 when flat). */
	positionSize: number;
	/** Resting non-reduce-only buy limit size for the market, in base units (0 when none). */
	openBuySize: number;
}

/**
 * Max order size (base units) when Reduce Only is checked: the % slider works against the
 * current position; when flat, against the market's resting buy limits. Returns null when
 * neither anchor exists so callers keep balance-based sizing.
 */
export function getReduceOnlyMaxBase(input: ReduceOnlyMaxInput): number | null {
	const positionSize = Math.abs(input.positionSize);
	if (positionSize > 0) return positionSize;
	if (input.openBuySize > 0) return input.openBuySize;
	return null;
}
