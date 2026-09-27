import { XIcon } from "@phosphor-icons/react";
import { useEffect } from "react";
import { HELP_HOTKEY, HOTKEYS, type HotkeyGroup, RESERVED_CHART_KEYS_NOTE } from "@/config/hotkeys";
import { comboDisplay } from "@/lib/hotkeys/engine";
import { isCustomBinding, resolveCombo } from "@/lib/hotkeys/resolve";
import {
	useHotkeyOverrides,
	useHotkeySettingsActions,
	useHotkeysEnabled,
	useHotkeysHelpOpen,
} from "@/stores/use-hotkey-settings-store";

const GROUP_ORDER: HotkeyGroup[] = ["Chart clicks", "Order entry", "Cancellations", "Order book", "Form toggles"];

function Kbd({ children }: { children: string }) {
	return (
		<kbd className="shrink-0 px-1.5 py-0.5 rounded-xs border border-stroke-weak bg-fill-hover font-mono text-2xs text-fg whitespace-nowrap">
			{children}
		</kbd>
	);
}

/**
 * Shortcuts help overlay (opened with "?" or the ⌨ button): every documented action
 * with its default key, honest badges for unbound actions and ones this build can't
 * do, plus the master enable toggle.
 */
export function HotkeysHelp() {
	const open = useHotkeysHelpOpen();
	const enabled = useHotkeysEnabled();
	const overrides = useHotkeyOverrides();
	const { setHelpOpen, toggleEnabled } = useHotkeySettingsActions();

	useEffect(() => {
		if (!open) return;
		function handleKeyDown(event: KeyboardEvent) {
			if (event.key === "Escape") setHelpOpen(false);
		}
		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [open, setHelpOpen]);

	if (!open) return null;

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: full-screen backdrop whose own-click dismisses the dialog
		<div
			className="fixed inset-0 z-[80] bg-background/60 flex items-start justify-center py-[8vh] px-4"
			onClick={(event) => {
				if (event.target === event.currentTarget) setHelpOpen(false);
			}}
			role="presentation"
		>
			<div
				className="w-full max-w-2xl max-h-[85vh] overflow-y-auto bg-surface border border-stroke-weak rounded-xs shadow-xl p-5 space-y-4"
				role="dialog"
				aria-label="Keyboard shortcuts"
			>
				<div className="flex items-center justify-between gap-3">
					<h2 className="text-sm font-semibold text-fg">Keyboard shortcuts</h2>
					<div className="flex items-center gap-2">
						<button
							type="button"
							aria-pressed={enabled}
							onClick={toggleEnabled}
							className={`px-2 py-1 rounded-xs border text-2xs font-semibold uppercase tracking-wide cursor-pointer transition-colors ${
								enabled
									? "border-stroke-weak/60 bg-success-soft text-success"
									: "border-stroke-weak/60 bg-fill-hover text-fg-muted"
							}`}
						>
							{enabled ? "Hotkeys on" : "Hotkeys off"}
						</button>
						<button
							type="button"
							aria-label="Close shortcuts help"
							onClick={() => setHelpOpen(false)}
							className="p-1 text-fg-muted hover:text-fg transition-colors cursor-pointer"
						>
							<XIcon className="size-4" />
						</button>
					</div>
				</div>

				<p className="text-xs text-fg-muted">
					Classic trading-hotkey defaults. Keys are ignored while you type in any field. Press <Kbd>?</Kbd> to toggle
					this panel.
				</p>

				{GROUP_ORDER.map((group) => {
					const rows = HOTKEYS.filter((hotkey) => hotkey.group === group);
					if (rows.length === 0) return null;
					return (
						<section key={group} className="space-y-1.5">
							<h3 className="text-2xs font-semibold uppercase tracking-wide text-fg-muted">{group}</h3>
							<ul className="divide-y divide-stroke-weak/60 border border-stroke-weak/60 rounded-xs overflow-hidden">
								{rows.map((hotkey) => (
									<li key={hotkey.id} className="flex items-start gap-3 px-2.5 py-1.5 bg-background/40">
										<div className="w-40 shrink-0 flex flex-wrap items-center gap-1">
											{(() => {
												const combo = resolveCombo(hotkey.id, overrides);
												if (combo !== null) {
													return (
														<>
															<Kbd>{comboDisplay(combo)}</Kbd>
															{isCustomBinding(hotkey.id, overrides) && (
																<span className="text-2xs text-warning">custom</span>
															)}
														</>
													);
												}
												return <span className="text-2xs text-fg-muted italic">unbound</span>;
											})()}
										</div>
										<div className="min-w-0 flex-1">
											<p
												className={`text-xs ${
													hotkey.availability === "unavailable" ? "text-fg-muted line-through" : "text-fg"
												}`}
											>
												{hotkey.label}
											</p>
											{hotkey.note && <p className="text-2xs text-fg-muted mt-0.5">{hotkey.note}</p>}
										</div>
									</li>
								))}
							</ul>
						</section>
					);
				})}

				<p className="text-2xs text-fg-muted border-t border-stroke-weak/60 pt-3">
					{RESERVED_CHART_KEYS_NOTE} Our own addition: <Kbd>{HELP_HOTKEY}</Kbd> opens/closes this panel.
				</p>
			</div>
		</div>
	);
}
