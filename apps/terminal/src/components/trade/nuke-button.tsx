import { BombIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { type NukeResult, useNukeAccount } from "@/hooks/trade/use-nuke-account";
import { cn } from "@/lib/cn";

type DialogState = "idle" | "confirm" | "busy" | "error";

/**
 * Toolbar nuke: asks "Are you sure?" (No / Yes), then cancels every resting order
 * across all markets and market-closes every position — preview operates on the
 * simulated book, live hits the exchange. Failures surface in the dialog (partial
 * results are expected: whatever completed stays completed).
 */
export interface NukeButtonProps {
	/** Optional visible label — the desktop toolbar uses the icon-only 32px target. */
	label?: string;
}

export function NukeButton({ label }: NukeButtonProps = {}) {
	const [state, setState] = useState<DialogState>("idle");
	const [result, setResult] = useState<NukeResult | null>(null);
	const nuke = useNukeAccount();
	const noButtonRef = useRef<HTMLButtonElement>(null);
	if (import.meta.env.DEV) {
		// Debug affordance for browser test scripts (dev builds only).
		(globalThis as { __hlNuke?: typeof nuke }).__hlNuke = nuke;
	}

	// Enter must hit the safe choice: focus No when the dialog arms.
	useEffect(() => {
		if (state === "confirm") noButtonRef.current?.focus();
	}, [state]);

	useEffect(() => {
		if (state !== "confirm" && state !== "error") return;
		function handleKeyDown(event: KeyboardEvent) {
			if (event.key === "Escape") setState("idle");
		}
		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [state]);

	async function handleConfirm() {
		setState("busy");
		try {
			const outcome = await nuke();
			setResult(outcome);
			setState(outcome.errors.length > 0 ? "error" : "idle");
		} catch (error) {
			setResult({ cancelled: 0, closed: 0, errors: [error instanceof Error ? error.message : String(error)] });
			setState("error");
		}
	}

	return (
		<>
			<button
				type="button"
				aria-label="Nuke account"
				title="Close every order and position"
				className={cn(
					label
						? "w-full h-10 shrink-0 flex items-center justify-center gap-2 rounded-8 border border-stroke-error-strong/40 bg-background text-sm font-medium text-error hover:bg-error-soft/20 transition-colors cursor-pointer"
						: "size-8 shrink-0 flex items-center justify-center rounded-8 text-fg-muted hover:text-error transition-colors cursor-pointer",
				)}
				onClick={() => {
					setResult(null);
					setState("confirm");
				}}
			>
				{label ? <span>{label}</span> : <BombIcon className="size-4" />}
			</button>
			{state !== "idle" && (
				// biome-ignore lint/a11y/noStaticElementInteractions: backdrop whose own-click confirms dismissal; the dialog carries the controls
				<div
					className="fixed inset-0 z-[90] bg-background/60 flex items-center justify-center px-4"
					onClick={(event) => {
						if (event.target === event.currentTarget && state !== "busy") setState("idle");
					}}
					role="presentation"
				>
					<div
						className="w-full max-w-sm bg-surface border border-stroke-weak rounded-xs shadow-xl p-4 space-y-4"
						role="dialog"
						aria-label="Are you sure?"
					>
						<div className="space-y-1">
							<h2 className="text-sm font-semibold text-fg">Are you sure?</h2>
							<p className="text-xs text-fg-muted">
								This cancels every open order and closes every position on the account.
							</p>
						</div>
						{state === "error" && result && result.errors.length > 0 && (
							<ul className="text-2xs text-error space-y-0.5 max-h-24 overflow-y-auto">
								{result.errors.map((message) => (
									<li key={message}>{message}</li>
								))}
							</ul>
						)}
						<div className="flex justify-end gap-2">
							<button
								type="button"
								ref={noButtonRef}
								disabled={state === "busy"}
								onClick={() => setState("idle")}
								className="px-3 py-1.5 rounded-xs border border-stroke-weak bg-fill-hover text-xs font-semibold text-fg cursor-pointer disabled:opacity-50"
							>
								{state === "error" ? "Close" : "No"}
							</button>
							{state !== "error" && (
								<button
									type="button"
									disabled={state === "busy"}
									onClick={() => void handleConfirm()}
									className="px-3 py-1.5 rounded-xs border border-stroke-warning-strong/40 bg-error-soft text-error text-xs font-bold cursor-pointer disabled:opacity-50"
								>
									{state === "busy" ? "Closing…" : "Yes"}
								</button>
							)}
						</div>
						{state === "busy" && (
							<p className="text-2xs text-fg-muted">
								Cancelling {result ? result.cancelled : "…"} orders and closing positions…
							</p>
						)}
					</div>
				</div>
			)}
		</>
	);
}
