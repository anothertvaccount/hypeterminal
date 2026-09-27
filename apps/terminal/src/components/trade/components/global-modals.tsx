import { Suspense } from "react";
import { createLazyComponent } from "@/lib/lazy";

const GlobalSettingsModal = createLazyComponent(() => import("./global-settings-modal"), "GlobalSettingsModal");
const SpotSwapModal = createLazyComponent(() => import("./spot-swap-modal"), "SpotSwapModal");
const CommandMenu = createLazyComponent(() => import("./command-menu"), "CommandMenu");

export function GlobalModals() {
	return (
		<Suspense fallback={null}>
			<GlobalSettingsModal />
			<SpotSwapModal />
			<CommandMenu />
		</Suspense>
	);
}
