import type { LabelSegment } from "@/domain/trade/order/chart-labels";

/** Replace the main label, not a shrinkable prefix competing with size/PnL cells. */
export function pendingMoveSegments(tone: LabelSegment["tone"], kind: "move" | "type" = "move"): LabelSegment[] {
	return [
		{ text: kind === "type" ? "Changing…" : "Moving…", tone },
		{ text: "…", tone, key: "cancel" },
	];
}

export function failedMoveSegments(tone: LabelSegment["tone"]): LabelSegment[] {
	return [
		{ text: "Unconfirmed", tone },
		{ text: "!", tone },
	];
}
