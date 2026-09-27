import { useEffect, useState } from "react";
import {
	LIVE_BADGE_TEXT,
	MODE_CANCEL_LABEL,
	MODE_CONFIRM_LIVE_LABEL,
	MODE_CONFIRM_PREVIEW_LABEL,
	MODE_LIVE_WARNING,
	MODE_PREVIEW_NOTE,
	MODE_RESET_LABEL,
	PAPER_BADGE_TEXT,
	PAPER_TRADE,
	setPreviewMode,
} from "@/config/paper";
import { usePaperActions } from "@/stores/use-paper-store";

/** Disarms the confirmation step so a stray click can't sit armed forever. */
const ARM_DISARM_MS = 6_000;

const PILL_IDLE =
	"px-2.5 py-1.5 rounded-8 border text-2xs font-semibold uppercase tracking-wide text-left cursor-pointer";
const PILL_PAPER = `${PILL_IDLE} bg-warning-soft border-stroke-warning-strong/20 text-warning`;
const PILL_LIVE = `${PILL_IDLE} bg-success-soft border-stroke-weak/40 text-success`;
const ROW =
	"flex flex-wrap items-center gap-2 px-2.5 py-1.5 rounded-8 border bg-surface border-stroke-weak/60 text-2xs";
const BTN = "px-2 py-0.5 rounded-6 border text-2xs font-semibold uppercase tracking-wide cursor-pointer";

/**
 * Preview ↔ live mode switch (replaces the static preview badge). Clicking the pill
 * arms a confirmation row: going live warns about real funds, going preview is a
 * one-step note; preview mode also exposes a account reset. Confirming persists the
 * mode and reloads — every `PAPER_TRADE` consumer restarts in the chosen mode.
 */
export function ModeSwitch() {
	const [armed, setArmed] = useState(false);
	const paperActions = usePaperActions();

	useEffect(() => {
		if (!armed) return;
		const timer = setTimeout(() => setArmed(false), ARM_DISARM_MS);
		return () => clearTimeout(timer);
	}, [armed]);

	if (!armed) {
		return (
			<button type="button" className={PAPER_TRADE ? PILL_PAPER : PILL_LIVE} onClick={() => setArmed(true)}>
				{PAPER_TRADE ? PAPER_BADGE_TEXT : LIVE_BADGE_TEXT}
			</button>
		);
	}

	const goingLive = PAPER_TRADE;
	return (
		<div className={ROW}>
			<span className={goingLive ? "text-warning font-semibold" : "text-success font-semibold"}>
				{goingLive ? MODE_LIVE_WARNING : MODE_PREVIEW_NOTE}
			</span>
			<button type="button" className={`${BTN} border-stroke-weak/60 text-fg-muted`} onClick={() => setArmed(false)}>
				{MODE_CANCEL_LABEL}
			</button>
			{PAPER_TRADE && (
				<button
					type="button"
					className={`${BTN} border-stroke-weak/60 text-fg-muted`}
					onClick={() => {
						paperActions.reset();
						setArmed(false);
					}}
				>
					{MODE_RESET_LABEL}
				</button>
			)}
			<button
				type="button"
				className={
					goingLive
						? `${BTN} border-stroke-warning-strong/40 bg-warning-soft text-warning`
						: `${BTN} border-stroke-weak/60 bg-success-soft text-success`
				}
				onClick={() => setPreviewMode(goingLive ? "live" : "paper")}
			>
				{goingLive ? MODE_CONFIRM_LIVE_LABEL : MODE_CONFIRM_PREVIEW_LABEL}
			</button>
		</div>
	);
}
