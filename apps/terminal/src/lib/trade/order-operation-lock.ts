const locks = new Map<string, symbol>();
const key = (scope: string, oid: number) => `${scope}:${oid}`;

/** Shared across chart engines and hook instances; reads may retry, writes may not overlap. */
export const orderOperationLock = {
	/** Test isolation; running operations must normally release their own token. */
	reset() {
		locks.clear();
	},
	acquire(scope: string, oid: number) {
		const id = key(scope, oid);
		if (locks.has(id)) return;
		const token = Symbol(id);
		locks.set(id, token);
		return token;
	},
	owns(scope: string, oid: number, token: symbol) {
		return locks.get(key(scope, oid)) === token;
	},
	release(scope: string, oid: number, token: symbol) {
		if (this.owns(scope, oid, token)) locks.delete(key(scope, oid));
	},
};
