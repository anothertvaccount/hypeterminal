import { ButtonIcon, Divider } from "@hypeterminal/ui";
import { t } from "@lingui/core/macro";
import { GearIcon, KeyboardIcon, TerminalIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { Suspense } from "react";
import { APP_BAR_BUTTON_HEIGHT_CLASS, APP_HEADER_HEIGHT_CLASS } from "@/config/layout";
import { SCOPE_NAV_ITEMS, STATIC_NAV_ITEMS } from "@/config/nav";
import { cn } from "@/lib/cn";
import { createLazyComponent } from "@/lib/lazy";
import { useExchangeScope } from "@/providers/exchange-scope";
import { useSettingsDialogActions } from "@/stores/use-global-modal-store";
import { useIsTestnet } from "@/stores/use-global-settings-store";
import { useHotkeySettingsActions, useHotkeysEnabled } from "@/stores/use-hotkey-settings-store";
import { NukeButton } from "../nuke-button";
import { ThemeToggle } from "./theme-toggle";

const UserMenu = createLazyComponent(() => import("./user-menu"), "UserMenu");

function getScopeAccentClass(scope: string): string {
	switch (scope) {
		case "perp":
			return "border-scope-perp/40";
		case "spot":
			return "border-scope-spot/40";
		case "builders-perp":
			return "border-scope-builders/40";
		default:
			return "border-stroke-weak";
	}
}

export function TopNav() {
	const { open: openSettingsDialog } = useSettingsDialogActions();
	const { scope } = useExchangeScope();
	const isTestnet = useIsTestnet();
	const hotkeysOn = useHotkeysEnabled();
	const { toggleEnabled: toggleHotkeys } = useHotkeySettingsActions();

	const accentClass = getScopeAccentClass(scope);

	return (
		<header
			className={cn(
				APP_HEADER_HEIGHT_CLASS,
				"fixed left-0 right-0 z-40 border-b border-stroke-weak px-3 flex items-center justify-between bg-background transition-colors duration-300 ease-in-out",
				isTestnet ? "top-8" : "top-0",
				accentClass,
			)}
		>
			<div className="flex items-center gap-3 min-w-0">
				<div className="flex items-center gap-1.5">
					<div className="size-5 rounded-8 bg-brand/10 border border-stroke-brand-strong/30 flex items-center justify-center">
						<TerminalIcon className="size-3 text-brand" />
					</div>
					<span className="text-xs font-bold tracking-tight">
						<span className="text-brand">HYPE</span>
						<span className="text-fg">TERMINAL</span>
					</span>
				</div>
				<Divider orientation="vertical" className="my-2 hidden lg:block" />
				<nav className="hidden lg:flex items-center text-xs tracking-wide">
					{SCOPE_NAV_ITEMS.map((item) => (
						<Link
							key={item.scope}
							to={item.to}
							className={cn(
								"px-2.5 py-1 rounded-8 transition-colors duration-150",
								scope === item.scope ? item.activeClass : "text-fg-muted hover:text-fg",
							)}
						>
							{item.label}
						</Link>
					))}
					<Divider orientation="vertical" className="my-2 mx-1" />
					{STATIC_NAV_ITEMS.map((item) => (
						<button
							key={item.key}
							type="button"
							disabled
							className="px-2.5 py-1.5 text-fg-disabled cursor-not-allowed"
							tabIndex={-1}
						>
							{item.label}
						</button>
					))}
				</nav>
			</div>

			<div className="flex items-center gap-2 min-h-8">
				<Suspense fallback={<UserMenuSkeleton />}>
					<UserMenu />
				</Suspense>
				<ThemeToggle />
				<NukeButton />
				<ButtonIcon
					variant="ghost"
					intent="neutral"
					className={cn("size-8 shrink-0", hotkeysOn ? "text-success" : "text-fg-muted opacity-50")}
					onClick={toggleHotkeys}
					aria-label={t`Hotkeys`}
					aria-pressed={hotkeysOn}
					title={hotkeysOn ? "Hotkeys on — click to disable" : "Hotkeys off — click to enable"}
				>
					<KeyboardIcon className="size-4" />
				</ButtonIcon>
				<ButtonIcon
					variant="ghost"
					intent="neutral"
					className="size-8 shrink-0"
					onClick={openSettingsDialog}
					aria-label={t`Settings`}
				>
					<GearIcon className="size-4" />
				</ButtonIcon>
			</div>
		</header>
	);
}

function UserMenuSkeleton() {
	return <div className={cn(APP_BAR_BUTTON_HEIGHT_CLASS, "h-8 w-32 shrink-0 rounded-8 bg-surface animate-pulse")} />;
}
