import type { InfoClient, OrderUpdatesWsEvent as OrderUpdatesEvent } from "@nktkas/hyperliquid";
import type { OpenOrder } from "@/lib/trade/open-orders";

type Update = OrderUpdatesEvent[number];
interface Evidence {
	updates: Map<number, { update: Update; revision: number }>;
	open: Map<number, OpenOrder>;
	openAt: number;
	batches: WeakSet<object>;
}
const accounts = new Map<string, Evidence>();
let revision = 0;
const scopes = new WeakMap<object, number>();
let scopeId = 0;
export function orderEvidenceScope(client: object, user: string) {
	if (!scopes.has(client)) scopes.set(client, ++scopeId);
	return `${scopes.get(client)}:${user.toLowerCase()}`;
}
function account(user: string): Evidence {
	const key = user.toLowerCase();
	let state = accounts.get(key);
	if (!state) {
		state = { updates: new Map(), open: new Map(), openAt: 0, batches: new WeakSet() };
		accounts.set(key, state);
	}
	return state;
}
export const orderEvidence = {
	cursor: () => revision,
	ingestUpdates(user: string, batch: OrderUpdatesEvent) {
		const state = account(user);
		if (state.batches.has(batch)) return;
		state.batches.add(batch);
		for (const update of batch) {
			const previous = state.updates.get(update.order.oid)?.update;
			if (
				previous &&
				(previous.statusTimestamp > update.statusTimestamp ||
					(previous.status !== "open" && update.status === "open") ||
					(previous.statusTimestamp === update.statusTimestamp && previous.status === "filled"))
			)
				continue;
			state.updates.delete(update.order.oid);
			state.updates.set(update.order.oid, { update, revision: ++revision });
		}
		while (state.updates.size > 512) state.updates.delete(state.updates.keys().next().value as number);
	},
	ingestOpen(user: string, rows: OpenOrder[]) {
		account(user).open = new Map(rows.map((row) => [row.oid, row]));
		account(user).openAt = Date.now();
	},
	updateAfter(user: string, oid: number, cursor: number) {
		const entry = account(user).updates.get(oid);
		return entry && entry.revision > cursor ? entry.update : undefined;
	},
	terminal(user: string, oid: number) {
		const update = account(user).updates.get(oid)?.update;
		return update && update.status !== "open" ? update : undefined;
	},
	open(user: string, oid: number) {
		const state = account(user);
		const status = state.updates.get(oid)?.update.status;
		return status && status !== "open" ? undefined : state.open.get(oid);
	},
	openFresh(user: string, oid: number) {
		return Date.now() - account(user).openAt <= 5000 ? this.open(user, oid) : undefined;
	},
	reset() {
		accounts.clear();
		revision = 0;
	},
};

/** Absence from openOrders is NEVER cancellation/fill proof. Only a matching event is. */
export function cancellationEvidence(user: string, source: OpenOrder, cursor: number) {
	const update = orderEvidence.updateAfter(user, source.oid, cursor);
	if (!update || (update.status !== "canceled" && update.status !== "filled")) return undefined;
	const row = update.order;
	if (!matchingOrderIdentity(row, source, source.limitPx, source.cloid ?? undefined)) return undefined;
	return { status: update.status, order: { ...source, ...row, reduceOnly: row.reduceOnly ?? source.reduceOnly } };
}

export function matchingOrderIdentity(
	row: Pick<OpenOrder, "oid" | "coin" | "side" | "limitPx"> & { cloid?: string | null; reduceOnly?: boolean },
	expected: OpenOrder,
	price: string,
	cloid?: string,
) {
	return (
		row.oid === expected.oid &&
		row.coin === expected.coin &&
		row.side === expected.side &&
		Number(row.limitPx) === Number(price) &&
		(!cloid || !row.cloid || row.cloid === cloid) &&
		(row.reduceOnly === undefined || row.reduceOnly === expected.reduceOnly)
	);
}

export function matchingRestingOrder(
	row: OpenOrder | undefined,
	expected: OpenOrder,
	tif: string,
	price: string,
	size: string,
	cloid?: string,
): row is OpenOrder {
	return (
		!!row &&
		row.oid === expected.oid &&
		row.coin === expected.coin &&
		row.side === expected.side &&
		!row.isTrigger &&
		row.reduceOnly === expected.reduceOnly &&
		row.tif === tif &&
		Number(row.limitPx) === Number(price) &&
		Number.isFinite(Number(row.sz)) &&
		Number(row.sz) > 0 &&
		Number(row.sz) <= Number(size) &&
		(!cloid || !row.cloid || row.cloid === cloid)
	);
}

/** History can return unknownOid for an order already visible in the live book. */
export async function readCurrentOpenOrder(
	info: InfoClient,
	user: `0x${string}`,
	oid: number,
	coin: string,
	scope: string,
): Promise<OpenOrder> {
	let last = "unavailable";
	const assertNotTerminal = () => {
		const terminal = orderEvidence.terminal(scope, oid);
		if (terminal) throw new Error(`Order #${oid} is no longer open (${terminal.status}). Nothing canceled.`);
	};
	assertNotTerminal();
	try {
		const snapshot = await info.orderStatus({ user, oid }, AbortSignal.timeout(1500));
		assertNotTerminal();
		if (snapshot.status === "order") {
			if (snapshot.order.status !== "open")
				throw new Error(`Order #${oid} is no longer open (${snapshot.order.status}). Nothing canceled.`);
			return snapshot.order.order;
		}
		last = snapshot.status;
	} catch (error) {
		if (error instanceof Error && error.message.includes("Nothing canceled")) throw error;
		last = error instanceof Error ? error.message : "read error";
	}
	assertNotTerminal();
	// A cached open row can predate a cancellation. Preflight fallback must be an independent read.
	let row: OpenOrder | undefined;
	try {
		const rows = await info.frontendOpenOrders(
			{ user, dex: coin.includes(":") ? coin.split(":")[0] : "" },
			AbortSignal.timeout(1500),
		);
		row = rows.find((candidate) => candidate.oid === oid);
	} catch {
		/* Leave the original untouched when both sources cannot verify it. */
	}
	assertNotTerminal();
	if (row) return row;
	throw new Error(
		`Order #${oid}: cannot verify the current open order; orderStatus: ${last}. Nothing canceled. Check Open Orders.`,
	);
}
