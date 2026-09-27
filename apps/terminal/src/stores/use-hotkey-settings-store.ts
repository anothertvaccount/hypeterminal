import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { STORAGE_KEYS } from "@/config/app";
import { applyBinding, type HotkeyOverrides } from "@/lib/hotkeys/resolve";

interface HotkeySettingsState {
	/** Master switch for every hotkey. */
	enabled: boolean;
	/** User rebinding overrides: action id → combo (null = explicitly unbound). */
	overrides: HotkeyOverrides;
	/** Which action is waiting for a key press on the settings/help pages (transient). */
	capturingId: string | null;
	/** Shortcuts help overlay visibility (transient — not persisted). */
	helpOpen: boolean;
	actions: {
		setEnabled: (enabled: boolean) => void;
		toggleEnabled: () => void;
		setHelpOpen: (open: boolean) => void;
		toggleHelpOpen: () => void;
		setBinding: (id: string, combo: string | null) => void;
		clearBindings: () => void;
		setCapturing: (id: string | null) => void;
	};
}

export const useHotkeySettingsStore = create<HotkeySettingsState>()(
	persist(
		(set, get) => ({
			enabled: true,
			overrides: {},
			capturingId: null,
			helpOpen: false,
			actions: {
				setEnabled: (enabled) => set({ enabled }),
				toggleEnabled: () => set({ enabled: !get().enabled }),
				setHelpOpen: (open) => set({ helpOpen: open }),
				toggleHelpOpen: () => set({ helpOpen: !get().helpOpen }),
				setBinding: (id, combo) => set({ overrides: applyBinding(get().overrides, id, combo) }),
				clearBindings: () => set({ overrides: {} }),
				setCapturing: (id) => set({ capturingId: id }),
			},
		}),
		{
			name: STORAGE_KEYS.HOTKEYS,
			version: 1,
			storage: createJSONStorage(() => localStorage),
			partialize: (state) => ({ enabled: state.enabled, overrides: state.overrides }),
		},
	),
);

export function useHotkeysEnabled(): boolean {
	return useHotkeySettingsStore((state) => state.enabled);
}

export function useHotkeyOverrides(): HotkeyOverrides {
	return useHotkeySettingsStore((state) => state.overrides);
}

export function useHotkeysCapturingId(): string | null {
	return useHotkeySettingsStore((state) => state.capturingId);
}

export function useHotkeySettingsActions(): HotkeySettingsState["actions"] {
	return useHotkeySettingsStore((state) => state.actions);
}

export function useHotkeysHelpOpen(): boolean {
	return useHotkeySettingsStore((state) => state.helpOpen);
}
