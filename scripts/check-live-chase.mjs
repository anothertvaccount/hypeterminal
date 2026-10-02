// Production UI + real SDK fixture. Every exchange write is intercepted; never forwarded.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const dependencyRoot = path.join(process.cwd(), "node_modules/.pnpm");
const playwrightEntry = readdirSync(dependencyRoot).find((name) => name.startsWith("playwright@"));
const { chromium } = await import(pathToFileURL(path.join(dependencyRoot, playwrightEntry, "node_modules/playwright/index.mjs")).href);
const browserRoot = path.join(process.env.LOCALAPPDATA ?? "", "ms-playwright");
const executablePath = readdirSync(browserRoot).filter((name) => name.startsWith("chromium-") && !name.includes("headless"))
	.map((name) => path.join(browserRoot, name, "chrome-win/chrome.exe")).find(existsSync)
	?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const base = process.env.BASE_URL ?? "https://charts.allofthesewords.com/terminal/";
const coin = process.env.CHASE_COIN ?? "xyz:SP500";
const dex = coin.includes(":") ? coin.split(":")[0] : "";
const owner = "0x0000000000000000000000000000000000000001";
const publicKey = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
const privateKey = `0x${"0".repeat(63)}1`; // Public test key; no funded account.
const info = (body) => fetch("https://api.hyperliquid.xyz/info", {
	method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
}).then((response) => response.json());
const [mids, metas, dexs] = await Promise.all([info({ type: "allMids", dex: "ALL_DEXS" }), info({ type: "allPerpMetas" }), info({ type: "perpDexs" })]);
const dexIndex = dex ? dexs.findIndex((item) => item?.name === dex) : 0;
const assetIndex = metas[dexIndex].universe.findIndex((item) => item.name === coin);
assert(assetIndex >= 0, "fixture market exists");
const assetId = dex ? 100000 + dexIndex * 10000 + assetIndex : assetIndex;
const szDecimals = metas[dexIndex].universe[assetIndex].szDecimals;
const mark = Math.round(Number(mids[coin]));
assert(mark > 0);
const recovery = process.env.CHASE_RECOVERY === "1";
const dustTail = process.env.CHASE_DUST_TAIL === "1";
const cancelRace = process.env.CHASE_CANCEL_RACE === "1";
const startRace = process.env.CHASE_START_RACE === "1";
const queueLayer = process.env.CHASE_QUEUE_LAYER === "1";
const reduceOnlyFlat = process.env.CHASE_REDUCE_ONLY_FLAT === "1";
const touchSlider = process.env.CHASE_TOUCH_SLIDER === "1";
const size = coin === "BTC" ? "0.02" : touchSlider ? "0.01" : recovery || dustTail ? "0.004" : "0.002";
const groupedBook = process.env.CHASE_GROUPED_BOOK === "1";
const outputDir = process.env.PROBE_SCREENSHOT_DIR;
const browser = await chromium.launch({ headless: true, executablePath });

async function run(mode, mobile) {
	const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1600, height: 950 }, isMobile: mobile, hasTouch: mobile || touchSlider, serviceWorkers: "block" });
	let order = null;
	let publishedOrder = null;
	let snapshotBlockedUntil = 0;
	let snapshotTimer;
	let raced = false;
	let dustTailCreated = false;
	let dustTailOid;
	const terminalOrders = new Map();
	let nextOid = 600;
	let bestBid = mark - 1;
	let bestAsk = mark + 1;
	let closing = false;
	let movingBook;
	let violation;
	const writes = [];
	const bookTicks = [];
	const subscriptions = new Map();
	const errors = [];
	const summary = { accountValue: "100000", totalNtlPos: "0", totalRawUsd: "100000", totalMarginUsed: "0" };
	const position = { coin, szi: size, entryPx: String(mark), positionValue: String(mark * Number(size)), unrealizedPnl: "0", returnOnEquity: "0", liquidationPx: null,
		marginUsed: "10", maxLeverage: 20, leverage: { type: "cross", value: 10 }, cumFunding: { allTime: "0", sinceOpen: "0", sinceChange: "0" } };
	const state = (positions) => ({ assetPositions: positions.map((position) => ({ type: "oneWay", position })), marginSummary: summary, crossMarginSummary: summary, crossMaintenanceMarginUsed: "0", withdrawable: "100000", time: Date.now() });
	let publishedPosition = { ...position };
	const accountStates = (fresh = false) => {
		const current = fresh ? position : publishedPosition;
		const positions = mode === "close" && Number(current.szi) !== 0 ? [current] : [];
		return dex ? [["", state([])], [dex, state(positions)]] : [["", state(positions)]];
	};
	const book = () => ({ coin, time: Date.now(), levels: [[{ px: String(bestBid), sz: "10", n: 2 }], [{ px: String(bestAsk), sz: "10", n: 2 }]] });
	const grouped = (request) => {
		const tick = 10 ** (Math.floor(Math.log10(mark)) + 1 - request.nSigFigs) * (request.mantissa ?? 1);
		return { ...book(), levels: [[{ px: String(Math.floor(bestBid / tick) * tick), sz: "10", n: 2 }], [{ px: String(Math.ceil(bestAsk / tick) * tick), sz: "10", n: 2 }]] };
	};
	const broadcast = (channel) => {
		// Same-channel deliveries may arrive in any order. Send grouped snapshots last
		// to reproduce SDK coin-only fanout contaminating an ungrouped subscriber.
		for (const [socket, requests] of subscriptions) for (const request of [...requests].sort((a, b) => Number(!!a.nSigFigs) - Number(!!b.nSigFigs))) {
			if (request.type !== channel) continue;
			let data;
			if (channel === "openOrders") data = { user: owner, dex: request.dex ?? "", orders: publishedOrder ? [publishedOrder] : [] };
			if (channel === "allDexsClearinghouseState") data = { user: owner, clearinghouseStates: accountStates() };
			if (channel === "allMids") data = { dex: request.dex ?? "", mids: { ...mids, [coin]: String(mark) } };
			if (channel === "activeAssetData") data = { user: owner, coin, leverage: { type: "cross", value: 10 }, availableToTrade: ["100000", "100000"], maxTradeSzs: [String(Number(size) * 4), String(Number(size) * 4)] };
			if (channel === "l2Book") data = groupedBook && request.nSigFigs ? grouped(request) : book();
			if (data) socket.send(JSON.stringify({ channel, data }));
		}
	};
	const startMovingBook = () => {
		if (movingBook) return;
		movingBook = setInterval(() => {
			bestBid -= 1; bestAsk += 1;
			bookTicks.push({ at: Date.now(), bestBid, bestAsk });
			broadcast("l2Book");
		}, 200);
	};
	await context.routeWebSocket("**/ws", (socket) => {
		const server = socket.connectToServer();
		server.onMessage((message) => socket.send(message));
		subscriptions.set(socket, []);
		socket.onMessage((message) => {
			const payload = JSON.parse(String(message));
			if (payload.method === "post") { violation = "Websocket exchange write blocked"; return; }
			const request = payload.subscription;
			const account = request?.user?.toLowerCase() === owner && (["openOrders", "allDexsClearinghouseState"].includes(request.type) || (request.type === "activeAssetData" && request.coin === coin));
			const market = request?.type === "allMids" || (request?.type === "l2Book" && request.coin === coin);
			if (account || market) {
				if (payload.method === "subscribe") subscriptions.get(socket).push(request);
				else subscriptions.set(socket, subscriptions.get(socket).filter((item) => JSON.stringify(item) !== JSON.stringify(request)));
				socket.send(JSON.stringify({ channel: "subscriptionResponse", data: payload }));
				if (payload.method === "subscribe") broadcast(request.type);
				return;
			}
			server.send(message);
		});
		socket.onClose(() => subscriptions.delete(socket));
	});
	await context.route("**/info", async (route) => {
		const request = route.request().postDataJSON();
		if (request.type === "l2Book" && request.coin === coin) return route.fulfill({ json: book() });
		if (request?.user?.toLowerCase() !== owner) return route.continue();
		if (request.type === "extraAgents") return route.fulfill({ json: [{ name: "app", address: publicKey, validUntil: Date.now() + 86400000 }] });
		if (request.type === "maxBuilderFee") return route.fulfill({ json: 1000 });
		if (request.type === "frontendOpenOrders") return route.fulfill({ json: order ? [order] : [] });
		if (request.type === "orderStatus") {
			const known = order && (order.oid === request.oid || order.cloid === request.oid) ? { order, status: "open" } : terminalOrders.get(request.oid);
			return route.fulfill({ json: known ? { status: "order", order: { ...known, statusTimestamp: Date.now() } } : { status: "unknownOid" } });
		}
		if (request.type === "clearinghouseState") return route.fulfill({ json: accountStates(true).find(([name]) => name === (request.dex ?? ""))?.[1] ?? state([]) });
		return route.continue();
	});
	await context.route("**/exchange", async (route) => {
		try {
			const { action } = route.request().postDataJSON();
			if (action.type === "cancel") {
				writes.push({ at: Date.now(), type: action.type, cancels: action.cancels });
				assert(closing || (dustTail && dustTailCreated), "chase unexpectedly canceled its order while running");
				if (order) terminalOrders.set(order.oid, { order, status: "canceled" });
				order = null;
				publishedOrder = null;
				broadcast("openOrders");
				return route.fulfill({ json: { status: "ok", response: { type: "cancel", data: { statuses: [cancelRace ? { error: `Order was never placed, already canceled, or filled. asset=${assetId}` } : "success"] } } } });
			}
			assert(["order", "batchModify"].includes(action.type), `unexpected exchange action ${action.type} blocked`);
			const modify = action.type === "batchModify";
			const row = modify ? action.modifies[0].order : action.orders[0];
			assert.equal(row.a, assetId);
			assert.equal(row.r, mode === "close");
			assert.equal(row.b, mode !== "close");
			assert.equal(row.t.limit.tif, dustTail && dustTailCreated && !modify ? "FrontendMarket" : "Alo");
			if (modify) {
				assert(order, "modification requires a resting order");
				assert.equal(action.modifies[0].oid, order.oid);
				const rawTouch = row.b ? bestBid : bestAsk;
				assert(Math.abs(Number(row.p) - rawTouch) <= 1, `chase price ${row.p} must follow raw touch ${rawTouch}, not a grouped bucket`);
			}
			else assert.equal(order, null, "only one initial placement");
			writes.push({ at: Date.now(), type: action.type, oid: modify ? action.modifies[0].oid : undefined, price: row.p, size: row.s, tif: row.t.limit.tif, reduceOnly: row.r, rawTouch: row.b ? bestBid : bestAsk });
			if (startRace && !modify) startMovingBook();
			if (startRace && mode === "close" && !modify && writes.filter((write) => write.type === "order").length <= 4) {
				writes.at(-1).expectedStartRace = true;
				return route.fulfill({ json: { status: "ok", response: { type: "order", data: { statuses: [{ error: "Post only order would have immediately matched, bbo was 30555@30558. asset=110000" }] } } } });
			}
			if (!modify && dustTail && dustTailCreated && row.t.limit.tif === "FrontendMarket") {
				assert.equal(row.s, String(10 ** -szDecimals), "market close uses the remaining valid lot");
				assert.equal(row.r, true, "dust market close is reduce-only");
				const cap = mark * 0.975;
				const decimals = Math.min(6, Math.max(0, 5 - (Math.floor(Math.log10(cap)) + 1)));
				const scale = 10 ** decimals;
				assert.equal(Number(row.p), Math.round(cap * scale) / scale, "market close uses configured 2.5% slippage with valid price rounding");
				position.szi = "0";
				publishedPosition = { ...position };
				const oid = nextOid++;
				await route.fulfill({ json: { status: "ok", response: { type: "order", data: { statuses: [{ filled: { oid } }] } } } });
				broadcast("allDexsClearinghouseState");
				return;
			}
			if (recovery && mode === "close" && modify && !raced) {
				raced = true;
				terminalOrders.set(order.oid, { order, status: "filled" });
				order = null;
				position.szi = String(Number(size) / 2); // REST is fresh; position/order streams remain stale.
				snapshotBlockedUntil = Date.now() + 2200;
				writes.at(-1).expectedRace = true;
				return route.fulfill({ json: { status: "ok", response: { type: "order", data: { statuses: [{ error: "Cannot modify canceled or filled order" }] } } } });
			}
			if (recovery && mode === "close" && !modify && raced) {
				assert.equal(writes.filter((write) => write.type === "order").length, 2, "only one recovery placement");
				assert.equal(row.s, String(Number(size) / 2), "recovery uses fresh partial remainder");
				assert(row.c, "recovery carries a CLOID for ambiguous readback");
			}
			if (modify) terminalOrders.set(order.oid, { order, status: "canceled" });
			order = { coin, side: row.b ? "B" : "A", limitPx: row.p, sz: row.s, origSz: row.s, oid: nextOid++, timestamp: Date.now(),
				isTrigger: false, triggerPx: "0", triggerCondition: "", children: [], isPositionTpsl: false, reduceOnly: row.r, orderType: "Limit", tif: row.t.limit.tif, cloid: row.c ?? null };
			if (dustTail && mode === "close" && modify && !dustTailCreated) {
				const tail = String(10 ** -szDecimals); // Valid lot size, but under $10 notional.
				assert(Number(tail) * mark < 10, `${coin} one-lot fixture tail must be below the $10 minimum`);
				order.sz = tail;
				position.szi = tail;
				publishedPosition = { ...position };
				publishedOrder = order;
				dustTailOid = order.oid;
				dustTailCreated = true;
				writes.at(-1).partialFill = { oldSize: size, remainingSize: tail, notional: Number(tail) * mark };
			}
			await route.fulfill({ json: { status: "ok", response: { type: "order", data: { statuses: [{ resting: { oid: order.oid } }] } } } });
			if (Date.now() >= snapshotBlockedUntil) publishedOrder = order;
			else if (!snapshotTimer) snapshotTimer = setTimeout(() => {
				publishedOrder = order; publishedPosition = { ...position }; broadcast("openOrders"); broadcast("allDexsClearinghouseState"); snapshotTimer = undefined;
			}, snapshotBlockedUntil - Date.now());
			broadcast("openOrders");
			if (dustTail && dustTailCreated) broadcast("allDexsClearinghouseState");
			if (!modify) startMovingBook();
		} catch (error) { violation = String(error); await route.abort(); }
	});
	await context.addInitScript(({ owner, publicKey, privateKey, coin, mobile }) => {
		localStorage.setItem("hypeterminal:paper-mode", "live");
		localStorage.setItem("market-prefs-v2", JSON.stringify({ state: { selectedMarkets: { all: coin, perp: coin, builderPerp: coin }, favoriteMarkets: [] }, version: 3 }));
		if (mobile) localStorage.setItem("hyperliquid_agent_session_Mainnet", JSON.stringify({ address: owner }));
		localStorage.setItem(`hyperliquid_agent_Mainnet_${owner}`, JSON.stringify({ privateKey, publicKey }));
		window.ethereum = { on() {}, removeListener() {}, async request({ method }) {
			if (["eth_accounts", "eth_requestAccounts"].includes(method)) return [owner];
			if (method === "eth_chainId") return "0xa4b1";
			throw new Error(`Read-only provider: ${method} forbidden`);
		} };
	}, { owner, publicKey, privateKey, coin, mobile });
	const page = await context.newPage();
	page.setDefaultTimeout(10000);
	page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
	try {
		await page.goto(base, { waitUntil: "domcontentloaded", timeout: 30000 });
		if (!mobile) {
			for (let attempt = 0; attempt < 10; attempt++) {
				if (await page.getByText(/0x0000.*0001/).first().isVisible()) break;
				for (const selector of [page.getByRole("button", { name: /^Injected/ }), page.getByText(/more wallets/), page.getByText("Connect Wallet", { exact: true }).first()]) {
					if (await selector.isVisible()) { await selector.click(); break; }
				}
				await page.waitForTimeout(500);
			}
			await page.getByText(/0x0000.*0001/).first().waitFor({ timeout: 15000 });
			await page.keyboard.press("Escape");
		}
		if (groupedBook && !mobile) {
			await page.getByRole("button", { name: "Price grouping", exact: true }).click();
			await page.getByRole("menuitem", { name: String(10 ** (Math.floor(Math.log10(mark)) - 1)), exact: true }).click();
		}
		if (mode === "close") {
			if (mobile) await page.locator('[aria-label="Primary navigation"]').getByText("Positions", { exact: true }).dispatchEvent("click");
			else {
				await page.getByRole("tab", { name: /^Positions/ }).click();
				await page.getByRole("button", { name: "Position close actions" }).click();
			}
			await page.getByText("Chase Close", { exact: true }).click();
		} else {
			if (mobile) await page.locator('[aria-label="Primary navigation"]').getByText("Trade", { exact: true }).dispatchEvent("click");
			await page.getByRole("button", { name: "Order type", exact: true }).click();
			await page.getByText("Chase Limit", { exact: true }).click();
			const form = page.locator("[data-order-form]");
			if (touchSlider) {
				const thumb = form.getByRole("slider");
				const sizeField = form.locator('input[inputmode="decimal"]').first();
				await form.getByRole("button", { name: "Clear size", exact: true }).click();
				await thumb.scrollIntoViewIfNeeded();
				const rail = await thumb.evaluate((element) => {
					const bounds = element.closest(".touch-none").getBoundingClientRect();
					return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
				});
				await page.touchscreen.tap(rail.x + rail.width * 0.5, rail.y + rail.height / 2);
				await page.waitForTimeout(350);
				assert(Number(await sizeField.inputValue()) > 0, "touch rail tap commits a nonzero size instead of snapping back to zero");
				assert(Math.abs(Number(await thumb.getAttribute("aria-valuenow")) - 50) < 8, "touch tap keeps the thumb near the chosen percentage");
				await page.touchscreen.tap(rail.x + rail.width * 0.75, rail.y + rail.height / 2);
				await page.waitForTimeout(350);
				assert(Math.abs(Number(await thumb.getAttribute("aria-valuenow")) - 75) < 8, "another touch tap updates the size");
				const thumbBounds = await thumb.boundingBox();
				const cdp = await context.newCDPSession(page);
				const start = { x: thumbBounds.x + thumbBounds.width / 2, y: thumbBounds.y + thumbBounds.height / 2 };
				await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [start] });
				await page.waitForTimeout(180);
				for (let step = 1; step <= 5; step++) {
					await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: start.x + (rail.x + rail.width * 0.25 - start.x) * step / 5, y: start.y }] });
					await page.waitForTimeout(25);
				}
				await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
				await cdp.detach();
				await page.waitForTimeout(350);
				assert(Math.abs(Number(await thumb.getAttribute("aria-valuenow")) - 25) < 8, "hold-drag still commits the requested size");
				await form.getByRole("button", { name: "Clear size", exact: true }).click();
				await page.waitForTimeout(350);
				assert(Number(await sizeField.inputValue()) === 0, "clear after touch gestures stays clear");
				assert.equal(writes.length, 0, "size gestures never submit an order");
			}
			await page.getByRole("button", { name: "25%", exact: true }).click();
			if (reduceOnlyFlat) {
				const reduceOnlyLabel = form.getByText("Reduce Only", { exact: true });
				await reduceOnlyLabel.click();
				const notice = form.getByText("Reduce Only needs an open position. Turn it off to open a trade.", { exact: true });
				await notice.waitFor();
				assert(await form.getByRole("button", { name: /^(Long|Place Long Order)$/ }).last().isDisabled(), "flat reduce-only Chase is blocked before submitting");
				assert.equal(writes.length, 0, "flat reduce-only Chase sends no exchange write");
				await reduceOnlyLabel.click();
				await notice.waitFor({ state: "hidden" });
			}
			await form.getByRole("button", { name: /^(Long|Place Long Order)$/ }).last().click();
		}
		const wantedModifies = dustTail && mode === "close" ? 1 : 3;
		if (queueLayer) {
			const queue = page.getByText("Order Queue", { exact: true }).locator("xpath=../../..");
			await queue.waitFor();
			if (mode === "close") await page.getByText(/Chase close started — riding the touch until/).waitFor({ state: "hidden" });
			const layer = await queue.evaluate((panel) => {
				// Stress the overlap regardless of the user's chosen panel heights.
				const book = document.querySelector('[data-slot="orderbook-spread"]').getBoundingClientRect();
				panel.style.left = `${book.left + 8}px`;
				panel.style.top = `${book.top - 40}px`;
				panel.style.right = "auto";
				panel.style.bottom = "auto";
				const bounds = panel.getBoundingClientRect();
				const points = [12, bounds.width / 2, bounds.width - 12].flatMap((x) =>
					[12, bounds.height / 2, bounds.height - 12].map((y) =>
						panel.contains(document.elementFromPoint(bounds.left + x, bounds.top + y)),
					),
				);
				return { portaled: panel.parentElement === document.body, points };
			});
			assert(layer.portaled, "queue escapes the trade sidebar stacking context");
			assert(layer.points.every(Boolean), "queue is above the book at every sampled surface point");
		}
		for (let attempt = 0; writes.filter((write) => write.type === "batchModify" && !write.expectedRace).length < wantedModifies && attempt < 40; attempt++) {
			if (violation) throw new Error(violation);
			await page.waitForTimeout(250);
		}
		clearInterval(movingBook);
		movingBook = undefined;
		const modifies = writes.filter((write) => write.type === "batchModify" && !write.expectedRace);
		assert(modifies.length >= wantedModifies, `expected ${wantedModifies} production reprices; observed ${modifies.length}`);
		assert.equal(violation, undefined);
		if (!dustTail) assert(new Set(modifies.map((write) => write.price)).size >= 3, "three distinct book-following prices");
		let finalPrice;
		let uiText = "";
		let chaseText;
		if (dustTail && mode === "close") {
			assert(dustTailCreated, "fixture partially filled the order below minimum size");
			finalPrice = order?.limitPx ?? String(mark);
			await page.getByRole("tab", { name: /^Chase/ }).click();
			const dustNotice = page.getByText(/below \$10\. Chase will cancel the resting order and finish with a reduce-only market close/);
			await dustNotice.waitFor();
			chaseText = await dustNotice.innerText();
			for (let attempt = 0; writes.filter((write) => write.type === "order" && write.tif === "FrontendMarket").length < 1 && attempt < 20; attempt++)
				await page.waitForTimeout(250);
			assert.equal(writes.filter((write) => write.type === "batchModify").length, 1, "do not reprice an undersized live remainder");
			assert.equal(writes.filter((write) => write.type === "order").length, 2, "one initial limit and one market close for the tail");
			assert.equal(writes.filter((write) => write.type === "cancel").length, 1, "cancel the old resting tail before market close");
			const marketClose = writes.find((write) => write.type === "order" && write.tif === "FrontendMarket");
			assert(marketClose, "submit a reduce-only market close for the remaining lot");
			assert.equal(marketClose.reduceOnly, true);
			assert.equal(marketClose.size, String(10 ** -szDecimals));
			assert.equal(writes.find((write) => write.type === "cancel").cancels[0].o, dustTailOid);
			assert.equal(violation, undefined);
			assert(!/Cannot modify canceled or filled|Order not found|Chase reprice failed/.test(await page.locator("body").innerText()), "dust fallback creates no expected queue/toast error");
			await page.getByText("No chase order running.", { exact: true }).waitFor();
			assert.equal(position.szi, "0", "the fixture remains open until the reduce-only market close succeeds");
		} else {
			await page.waitForTimeout(1000);
			if (mobile) {
				await page.locator('[aria-label="Primary navigation"]').getByText("Positions", { exact: true }).dispatchEvent("click");
				await page.getByRole("tab", { name: /^Orders/ }).click();
			} else await page.getByRole("tab", { name: /^Open Orders/ }).click();
			finalPrice = order.limitPx;
			const displayedPrice = Number(finalPrice).toLocaleString("en-US");
			const panel = page.locator('[role="tabpanel"]:not([hidden])').filter({ has: page.getByRole("button", { name: mobile ? "Cancel All" : "Cancel all orders", exact: true }) });
			await panel.getByText(new RegExp(displayedPrice.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).first().waitFor();
			uiText = await panel.innerText();
		}
		assert.deepEqual(errors, []);
		if (startRace && mode === "close") {
			assert.equal(writes.filter((write) => write.expectedStartRace).length, 4, "four startup rejections retry without stopping");
			const placements = writes.filter((write) => write.type === "order");
			assert.equal(placements.length, 5, "one accepted placement follows the four definite rejections");
			assert(new Set(placements.map((write) => write.price)).size >= 3, "startup retries follow the moving book");
			assert(!/Chase close failed|Post only order would have immediately matched|\d+ failed/.test(await page.locator("body").innerText()), "startup book races create no failure popup or queue row");
		}
		if (cancelRace) {
			closing = true;
			await page.getByRole("tab", { name: /^Chase/ }).click();
			await page.getByRole("button", { name: "Stop Chase", exact: true }).click();
			for (let attempt = 0; !writes.some((write) => write.type === "cancel") && attempt < 20; attempt++) await page.waitForTimeout(250);
			assert(writes.some((write) => write.type === "cancel"), "stopping Chase attempts cleanup cancellation");
			await page.waitForTimeout(500);
			assert(!/Order was never placed, already canceled, or filled|\d+ failed/.test(await page.locator("body").innerText()), "Chase cancel race creates no failed queue row or popup");
			await page.getByText("No chase order running.", { exact: true }).waitFor();
		}
		if (recovery && mode === "close") {
			assert(raced, "fixture forced the expected canceled/filled race");
			assert.equal(writes.filter((write) => write.type === "order").length, 2);
			assert(!/Cannot modify canceled or filled|Order not found|Chase reprice failed/.test(await page.locator("body").innerText()), "expected race creates no queue/toast error");
			terminalOrders.set(order.oid, { order, status: "filled" });
			closing = true; // Engine cleanup may cancel its last acknowledged reduce-only rest.
			order = null; publishedOrder = null; position.szi = "0"; publishedPosition = { ...position };
			broadcast("openOrders"); broadcast("allDexsClearinghouseState");
			await page.getByRole("tab", { name: /^Chase/ }).click();
			await page.getByText("No chase order running.", { exact: true }).waitFor();
			await page.getByText("Completed", { exact: true }).waitFor();
			chaseText = await page.locator('[role="tabpanel"]:not([hidden])').last().innerText();
			assert.equal(writes.filter((write) => write.type === "order").length, 2, "flat position must not repost");
		}
		const result = { mode, mobile, recovery, dustTail, cancelRace, startRace, coin, writes, gapsMs: modifies.slice(1).map((write, index) => write.at - modifies[index].at), finalPrice, uiText, chaseText, bookTicks, errors };
		assert(result.gapsMs.every((gap) => gap >= 500 && gap < 1250), `750 ms cadence must not skip alternate ticks: ${result.gapsMs}`);
		if (outputDir) { mkdirSync(outputDir, { recursive: true }); const filename = `chase-${mode}-${mobile ? "phone" : "desktop"}${startRace ? "-start-race" : cancelRace ? "-cancel-race" : recovery ? "-recovery" : dustTail ? "-dust-tail" : ""}`; await page.screenshot({ path: path.join(outputDir, `${filename}.png`) }); writeFileSync(path.join(outputDir, `${filename}.json`), JSON.stringify(result, null, 2)); }
		console.log(JSON.stringify({ PASS: `${mobile ? "phone" : "desktop"} ${coin} ${mode}${recovery ? " recovery" : dustTail ? " dust-tail" : ""}`, reprices: modifies.length, gapsMs: result.gapsMs, finalPrice, errors }));
	} catch (error) {
		if (outputDir) { mkdirSync(outputDir, { recursive: true }); writeFileSync(path.join(outputDir, `chase-${mode}-failure.json`), JSON.stringify({ writes, bookTicks, errors, violation, text: await page.locator("body").innerText() }, null, 2)); await page.screenshot({ path: path.join(outputDir, `chase-${mode}-failure.png`) }); }
		throw error;
	} finally { closing = true; clearInterval(movingBook); clearTimeout(snapshotTimer); await context.close(); }
}
try {
	const modes = process.env.CHASE_MODE ? [process.env.CHASE_MODE] : ["close", "entry"];
	const viewports = process.env.CHASE_PHONE === "1" ? [true] : [false];
	for (const mobile of viewports) for (const mode of modes) await run(mode, mobile);
} finally { await browser.close(); }
