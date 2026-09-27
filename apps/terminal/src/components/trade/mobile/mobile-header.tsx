import { ButtonIcon } from "@hypeterminal/ui";
import { BellIcon, GearIcon, SpeakerHighIcon, SpeakerSlashIcon, TerminalIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { APP_HEADER_HEIGHT_CLASS } from "@/config/layout";
import { UI_TEXT } from "@/config/ui-text";
import { cn } from "@/lib/cn";
import { isFillSoundMuted, setFillSoundMuted } from "@/lib/fill-sound";
import { useSettingsDialogActions } from "@/stores/use-global-modal-store";
import { ThemeToggle } from "../header/theme-toggle";
import { UserMenu } from "../header/user-menu";
import { MobileNavDrawer } from "./mobile-nav-drawer";

const TOP_NAV_TEXT = UI_TEXT.TOP_NAV;

interface Props {
	className?: string;
}

export function MobileHeader({ className }: Props) {
	const { open: openSettingsDialog } = useSettingsDialogActions();
	const [fillSoundMuted, setFillSoundMutedState] = useState(() => isFillSoundMuted());

	return (
		<header
			className={cn(
				"pt-[env(safe-area-inset-top)]",
				"sticky top-0 z-40 bg-surface/95 backdrop-blur-sm",
				"border-b border-stroke-weak/60",
				className,
			)}
		>
			<div className={cn(APP_HEADER_HEIGHT_CLASS, "px-2 flex items-center justify-between")}>
				<div className="flex items-center gap-1">
					<MobileNavDrawer />
					<div className="size-6 rounded-8 bg-brand/10 border border-stroke-brand-strong/30 flex items-center justify-center">
						<TerminalIcon className="size-3.5 text-brand" />
					</div>
				</div>

				<div className="flex items-center gap-0.5">
					<UserMenu />
					<ButtonIcon
						variant="ghost"
						intent="neutral"
						size="md"
						className="touch-target"
						aria-label={TOP_NAV_TEXT.NOTIFICATIONS_ARIA}
					>
						<BellIcon className="size-4" />
					</ButtonIcon>
					{/* The sound toggle used to float bottom-left over the Long/Short button. */}
					<ButtonIcon
						variant="ghost"
						intent="neutral"
						size="md"
						className="touch-target"
						aria-label="Trade sound"
						aria-pressed={!fillSoundMuted}
						title={fillSoundMuted ? "Enable trade sounds" : "Mute trade sounds (fills, placements, cancels)"}
						onClick={() => {
							const next = !fillSoundMuted;
							setFillSoundMuted(next);
							setFillSoundMutedState(next);
						}}
					>
						{fillSoundMuted ? <SpeakerSlashIcon className="size-4" /> : <SpeakerHighIcon className="size-4" />}
					</ButtonIcon>
					<ThemeToggle />
					<ButtonIcon
						variant="ghost"
						intent="neutral"
						size="md"
						className="touch-target"
						aria-label={TOP_NAV_TEXT.SETTINGS_ARIA}
						onClick={openSettingsDialog}
					>
						<GearIcon className="size-4" />
					</ButtonIcon>
				</div>
			</div>
		</header>
	);
}
