import { SpeakerHighIcon, SpeakerSlashIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { FILL_NOTIFICATION_DURATION_MS } from "@/config/time";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/cn";
import { isFillSoundMuted, setFillSoundMuted } from "@/lib/fill-sound";
import { useSubscription, useTradingSession } from "@/lib/hyperliquid";
import {
	emitFillNotifications,
	type FillNotification,
	useFillNotificationActions,
	useFillNotifications,
} from "@/stores/use-fill-notifications-store";

interface LiveFill {
	tid: number;
	coin: string;
	px: string;
	sz: string;
	side: "B" | "A";
	time?: number;
}

function FillCard({ item, onDismiss }: { item: FillNotification; onDismiss: (id: string) => void }) {
	useEffect(() => {
		const timer = setTimeout(() => onDismiss(item.id), FILL_NOTIFICATION_DURATION_MS);
		return () => clearTimeout(timer);
	}, [item.id, onDismiss]);

	return (
		<div
			data-testid="fill-notification"
			className="pointer-events-auto w-full bg-surface border border-stroke-weak rounded-xs shadow-lg p-2 flex items-start gap-2"
		>
			<span
				className={cn(
					"shrink-0 px-1.5 py-0.5 rounded-xs text-2xs font-bold uppercase",
					item.side === "buy" ? "bg-success-soft text-success" : "bg-error-soft text-error",
				)}
			>
				{item.side}
			</span>
			<div className="min-w-0 flex-1">
				<p className="text-xs font-semibold text-fg truncate">
					{item.market}
					{item.kind && <span className="text-fg-muted font-normal"> · {item.kind}</span>}
				</p>
				<p className="text-2xs text-fg-muted tabular-nums">
					{item.size}
					{item.price !== undefined ? ` @ ${item.price}` : ""} · Filled
				</p>
			</div>
			{item.preview && (
				<span className="shrink-0 self-center text-2xs text-warning border border-stroke-warning-strong/40 rounded-xs px-1">
					preview
				</span>
			)}
			<button
				type="button"
				aria-label="Dismiss fill notification"
				className="shrink-0 text-fg-muted hover:text-fg transition-colors"
				onClick={() => onDismiss(item.id)}
			>
				<XIcon className="size-3" />
			</button>
		</div>
	);
}

/**
 * Top-right fill alerts: a brief popup per fill (preview fills from the paper store,
 * live fills from the `userFills` stream — its snapshot seeds the seen-set so history
 * never chimes) plus a persisted mute toggle for the chime.
 */
export function FillNotifications() {
	const isMobile = useIsMobile();
	const items = useFillNotifications();
	const { dismiss } = useFillNotificationActions();
	const [muted, setMuted] = useState(() => isFillSoundMuted());
	const { address, isActive } = useTradingSession();

	const { data: fillsEvent } = useSubscription("userFills", { user: address ?? "0x0" }, { enabled: isActive });
	const seenTids = useRef<Set<number> | null>(null);
	const bornAtRef = useRef(Date.now());

	useEffect(() => {
		const fills = (fillsEvent?.fills ?? []) as unknown as LiveFill[];
		if (seenTids.current === null) {
			seenTids.current = new Set<number>();
			// First payload: remember history without alerting on it.
			for (const fill of fills) seenTids.current.add(fill.tid);
			return;
		}
		const fresh = fills.filter(
			(fill) =>
				!seenTids.current?.has(fill.tid) &&
				// Guard against partial/streamed snapshots leaking history after the seed:
				// only fills stamped since this component mounted are genuinely "live".
				(typeof fill.time !== "number" || fill.time >= bornAtRef.current - 5_000),
		);
		if (fresh.length === 0) return;
		for (const fill of fresh) seenTids.current.add(fill.tid);
		emitFillNotifications(
			fresh.map((fill) => ({
				side: fill.side === "B" ? "buy" : "sell",
				market: fill.coin,
				size: String(fill.sz),
				price: String(fill.px),
			})),
		);
	}, [fillsEvent]);

	// Desktop only. On the phone the fill CARDS were a third floating stack that
	// landed on the order-queue panel and the form, and the sound toggle (parked
	// bottom-left) sat right on top of the Long/Short submit button. On a phone the
	// queue panel lists every order with its outcome and the queue toasts announce
	// failures, so the fill cards are redundant — and the toggle now lives in the
	// mobile header, where it cannot cover a control. Nothing renders here on mobile:
	// a `hidden` class next to `flex` does NOT win (equal specificity, and the utility
	// order in the stylesheet decides), so the aside would still be laid out.
	if (isMobile) return null;

	return (
		<aside
			aria-label="Fill notifications"
			className="fixed top-16 right-2 z-50 flex flex-col items-end gap-2 w-64 pointer-events-none"
		>
			<FillSoundToggle muted={muted} onToggle={setMuted} />
			{items.map((item) => (
				<FillCard key={item.id} item={item} onDismiss={dismiss} />
			))}
		</aside>
	);
}

/**
 * Trade-sound mute toggle. Rendered in the DESKTOP notification stack and, on the
 * phone, in the mobile header next to the bell — a floating button is a liability
 * on a small screen, where it ends up over the submit button.
 */
export function FillSoundToggle({
	muted,
	onToggle,
	className,
}: {
	muted: boolean;
	onToggle: (next: boolean) => void;
	className?: string;
}) {
	return (
		<button
			type="button"
			aria-label="Trade sound"
			aria-pressed={!muted}
			title={muted ? "Enable trade sounds" : "Mute trade sounds (fills, placements, cancels)"}
			className={cn("text-fg-muted hover:text-fg transition-colors cursor-pointer", className)}
			onClick={() => {
				const next = !muted;
				setFillSoundMuted(next);
				onToggle(next);
			}}
		>
			{muted ? <SpeakerSlashIcon className="size-4" /> : <SpeakerHighIcon className="size-4" />}
		</button>
	);
}
