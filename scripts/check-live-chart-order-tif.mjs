// LIVE SDK-path fixtures: every HTTP exchange action is fulfilled locally or aborted.
// No real order is canceled/placed. Public market data is the only passthrough data.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const pnpmRoot = path.join(process.cwd(), "node_modules/.pnpm");
const entry = readdirSync(pnpmRoot).find((name) => name.startsWith("playwright@"));
const { chromium } = await import(pathToFileURL(path.join(pnpmRoot, entry, "node_modules/playwright/index.mjs")).href);
const msRoot = path.join(process.env.LOCALAPPDATA ?? "", "ms-playwright");
const executablePath = (existsSync(msRoot) ? readdirSync(msRoot) : [])
	.filter((name) => name.startsWith("chromium-") && !name.includes("headless"))
	.map((name) => path.join(msRoot, name, "chrome-win/chrome.exe")).find(existsSync)
	?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const base = process.env.BASE_URL ?? "http://localhost:3100/";
const typePlaceholderOnly = process.env.TIF_PLACEHOLDER_ONLY === "1";
const menuAnchorOnly = process.env.TIF_MENU_ANCHOR_ONLY === "1";
const owner = "0x0000000000000000000000000000000000000001";
const publicKey = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
const privateKey = `0x${"0".repeat(63)}1`; // Public test key; never a funded account/key.
// Keep the fixture inside the current viewport rather than a stale fixed market price.
const mids = await fetch("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "allMids" }), signal: AbortSignal.timeout(10000) }).then((response) => response.json());
const fixturePrice = String(Math.round(Number(mids.BTC) * 0.9995));
assert(Number(fixturePrice) > 0);
const initial = { coin: "BTC", side: "B", limitPx: fixturePrice, sz: "0.02", oid: 42, timestamp: Date.now(), origSz: "0.02", triggerCondition: "", isTrigger: false, triggerPx: "0", children: [], isPositionTpsl: false, reduceOnly: false, orderType: "Limit", tif: "Alo", cloid: null };

const browser = await chromium.launch({ headless: true, executablePath });
async function run(mobile, canvas, scenario = "success") {
	const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1600, height: 950 }, isMobile: mobile, hasTouch: mobile, serviceWorkers: "block" });
	const native = scenario === "post-only";
	const tpSl = scenario.startsWith("tpsl-");
	const tpSlMode = scenario === "tpsl-po" ? "Alo" : "Gtc";
	const tpSlKind = scenario === "tpsl-po" ? "tp" : "sl";
	const streamOnly = scenario === "stream-only";
	const unconfirmed = scenario === "cancel-unconfirmed";
	const dragOnly = native || scenario === "gtc-existing" || streamOnly || unconfirmed;
	const successful = scenario === "success" || dragOnly;
	const wantedLabel = native ? "Post Only" : "GTC";
	const postOnlyLabel = mobile ? "PO" : "Post Only";
	const dragOid = dragOnly ? 42 : 99;
	let order = { ...initial, tif: dragOnly && !native ? "Gtc" : "Alo" };
	if (tpSl) order = { ...initial, side: "A", reduceOnly: true, isTrigger: true, isPositionTpsl: true, triggerPx: fixturePrice,
		orderType: tpSlKind === "tp" ? "Take Profit Market" : "Stop Market", tif: null };
	let actualTif = order.tif;
	const history = new Map([[42, order]]);
	let cancelLagUntil = 0;
	let readGlitch = false;
	let placeholderChecks = 0;
	const canceledOids = new Set();
	let cancels = 0;
	let placements = 0;
	let reprices = 0;
	let repricedPx;
	let cancellationVerified = false;
	let violation;
	const sockets = new Map();
	const updateSockets = new Set();
	let screenshotTaken = false;
	const movingVisible = async (label = "Moving…") => page.evaluate(({ canvas, label }) => {
		if (canvas === "kline") {
			return globalThis.__tifPaints.some((p) => p.text === label && Date.now() - p.at < 1500 && p.inCanvas
				&& p.left >= 0 && p.right <= innerWidth && p.y > 0 && p.y < innerHeight
				&& document.elementFromPoint(p.x, p.y)?.tagName === "CANVAS");
		}
		const cell = [...document.querySelectorAll('[data-tv-line^="order-"] span')].find((el) => el.childNodes.length === 1 && el.textContent === label);
		if (!cell) return false;
		const box = cell.getBoundingClientRect();
		const strip = cell.closest('[data-tv-strip-box]').getBoundingClientRect();
		const range = document.createRange(); range.selectNodeContents(cell);
		const text = range.getBoundingClientRect();
		const row = cell.closest('[data-tv-line]');
		return getComputedStyle(cell).visibility === "visible" && box.width > 0 && box.height > 0
			&& text.left >= box.left && text.right <= box.right && text.left >= strip.left && text.right <= strip.right
			&& text.left >= 0 && text.right <= innerWidth && text.top >= 0 && text.bottom <= innerHeight
			&& !row.querySelector('button[aria-label="Change order type"]');
	}, { canvas, label });
	const checkMoving = async () => {
		if (await movingVisible(cancels === 1 && !dragOnly ? "Changing…" : "Moving…")) {
			placeholderChecks++;
			if (mobile && process.env.PROBE_SCREENSHOT_DIR && !screenshotTaken) {
				mkdirSync(process.env.PROBE_SCREENSHOT_DIR, { recursive: true });
				await page.screenshot({ path: path.join(process.env.PROBE_SCREENSHOT_DIR, `moving-${canvas}-${scenario}.png`) });
				screenshotTaken = true;
			}
		}
	};
	const broadcast = () => {
		for (const [socket, dex] of sockets) socket.send(JSON.stringify({ channel: "openOrders", data: { dex, user: owner, orders: order ? [order] : [] } }));
	};
	await context.routeWebSocket("**/ws", (socket) => {
		const server = socket.connectToServer();
		server.onMessage((message) => socket.send(message));
		socket.onMessage((message) => {
			const data = JSON.parse(String(message));
			if (data.method === "post") { violation = "Unexpected websocket action blocked"; return; }
			if (data.subscription?.type === "orderUpdates" && data.subscription.user.toLowerCase() === owner) {
				if (data.method === "subscribe") { updateSockets.add(socket); socket.send(JSON.stringify({ channel: "subscriptionResponse", data })); }
				else updateSockets.delete(socket);
				return;
			}
			if (data.subscription?.type === "openOrders" && data.subscription.user.toLowerCase() === owner) {
				if (data.method === "subscribe") {
					sockets.set(socket, data.subscription.dex ?? "");
					socket.send(JSON.stringify({ channel: "subscriptionResponse", data }));
					broadcast();
				} else sockets.delete(socket);
				return;
			}
			server.send(message);
		});
		socket.onClose(() => { sockets.delete(socket); updateSockets.delete(socket); });
	});
	await context.route("**/exchange", async (route) => {
		// NEVER continue/fetch an exchange request, including unexpected actions.
		try {
			const { action } = route.request().postDataJSON();
			if (action.type === "cancel") {
				assert.deepEqual(action.cancels, [{ a: 0, o: tpSl ? order.oid : placements === 0 ? 42 : 99 }]);
				assert.equal(++cancels, placements + 1);
				assert(cancels <= 2);
				if (scenario === "cancel-rejected") {
					return route.fulfill({ json: { status: "ok", response: { type: "cancel", data: { statuses: [{ error: "Cancel rejected fixture" }] } } } });
				}
				history.set(order.oid, { ...order, tif: actualTif });
				canceledOids.add(order.oid);
				cancellationVerified = false;
				if (!tpSl && (cancels === 2 || dragOnly || typePlaceholderOnly)) { cancelLagUntil = Date.now() + 2800; readGlitch = true; }
				order = null;
				await route.fulfill({ json: { status: "ok", response: { type: "cancel", data: { statuses: ["success"] } } } });
				broadcast(); // Original row UNMOUNTS before placement: the async job must survive.
				if (streamOnly) {
					await new Promise((resolve) => setTimeout(resolve, 900));
					await checkMoving();
					cancellationVerified = true;
					const canceled = [...canceledOids].at(-1);
					for (const socket of updateSockets) socket.send(JSON.stringify({ channel: "orderUpdates", data: [{ order: history.get(canceled), status: "canceled", statusTimestamp: Date.now() }] }));
				}
				return;
			}
			if (action.type === "batchModify") {
				// Model the REAL report, not the previous falsely optimistic fixture:
				// the exchange ACKs the new price but returns Alo even for a Gtc payload.
				const row = action.modifies[0].order;
				if (!native || actualTif !== "Alo" || row.t.limit.tif !== "Alo") violation = "GTC batchModify resets to Alo; must not be used";
				else {
					assert.equal(cancels, 0); assert.equal(placements, 0);
					assert.equal(++reprices, 1);
					assert.notEqual(Number(row.p), Number(fixturePrice)); repricedPx = row.p;
				}
				actualTif = "Alo";
				order = { ...order, oid: 100, limitPx: action.modifies[0].order.p, tif: "Alo" };
				await route.fulfill({ json: { status: "ok", response: { type: "order", data: { statuses: [{ resting: { oid: 100 } }] } } } });
				broadcast();
				return;
			}
			assert.equal(action.type, "order", "unexpected exchange action forbidden");
			assert(cancellationVerified, "no placement before cancellation read-back");
			assert.equal(++placements, cancels);
			assert.equal(order, null, "old order must be absent before the single replacement");
			const row = action.orders[0];
			assert.match(row.c, /^0x[0-9a-f]{32}$/);
			if (tpSl) {
				assert.equal(row.a, 0); assert.equal(row.b, false); assert.equal(row.r, true);
				assert.equal(row.p, fixturePrice); assert.equal(row.s, "0.02");
				assert.deepEqual(row.t, placements === 1 ? { limit: { tif: tpSlMode } } : { trigger: { isMarket: true, triggerPx: fixturePrice, tpsl: tpSlKind } });
				assert.equal(action.grouping, placements === 1 ? "na" : "positionTpsl");
				const oid = placements === 1 ? 99 : 100;
				order = { ...initial, oid, side: "A", reduceOnly: true, cloid: row.c,
					isTrigger: placements === 2, isPositionTpsl: placements === 2, triggerPx: placements === 2 ? fixturePrice : "0",
					orderType: placements === 2 ? (tpSlKind === "tp" ? "Take Profit Market" : "Stop Market") : "Limit", tif: placements === 1 ? tpSlMode : null };
				actualTif = order.tif;
				await route.fulfill({ json: { status: "ok", response: { type: "order", data: { statuses: [{ resting: { oid } }] } } } });
				broadcast(); return;
			}
			if (placements === 1 && !dragOnly) assert.equal(row.p, fixturePrice);
			else {
				assert.equal(placements, dragOnly ? 1 : 2);
				assert.equal(++reprices, 1);
				assert.notEqual(Number(row.p), Number(fixturePrice));
				assert(Number(row.p) > 0);
				assert.notEqual(row.c, history.get(dragOid).cloid, "repost has a fresh cloid");
				repricedPx = row.p;
			}
			assert.deepEqual({ ...row, c: undefined, p: undefined }, { a: 0, b: true, p: undefined, s: "0.02", r: false, t: { limit: { tif: "Gtc" } }, c: undefined });
			assert.equal(action.grouping, "na");
			const oid = placements === 1 && !dragOnly ? 99 : 100;
			order = { ...initial, oid, limitPx: row.p, cloid: row.c }; // STALE Alo WS after both replacements.
			actualTif = scenario === "unchanged" ? "Alo" : "Gtc";
			await route.fulfill({ json: { status: "ok", response: { type: "order", data: { statuses: [{ resting: { oid } }] } } } });
			broadcast();
		} catch (error) { violation = String(error); await route.abort(); }
	});
	await context.route("**/info", async (route) => {
		const data = route.request().postDataJSON();
		if (data?.user?.toLowerCase() !== owner) return route.continue();
		if (data.type === "extraAgents") return route.fulfill({ json: [{ name: "app", address: publicKey, validUntil: Date.now() + 86400000 }] });
		if (data.type === "maxBuilderFee") return route.fulfill({ json: 1000 });
		if (data.type === "frontendOpenOrders") return route.fulfill({ json: order ? [{ ...order, tif: actualTif }] : [] });
		if (data.type === "orderStatus") {
			assert([42, 99, 100].includes(data.oid));
			if (canceledOids.has(data.oid)) {
				if (streamOnly || unconfirmed) {
					await checkMoving();
					return route.fulfill({ json: { status: "unknownOid" } });
				}
				if (Date.now() < cancelLagUntil) {
					await checkMoving();
					if (readGlitch) { readGlitch = false; return route.fulfill({ status: 503, json: { error: "transient read failure fixture" } }); }
					return route.fulfill({ json: { status: "order", order: { order: history.get(data.oid), status: "open", statusTimestamp: Date.now() } } });
				}
				cancellationVerified = true;
				return route.fulfill({ json: { status: "order", order: { order: history.get(data.oid), status: "canceled", statusTimestamp: Date.now() } } });
			}
			assert.equal(data.oid, order.oid);
			if (streamOnly && data.oid === 100) return route.fulfill({ json: { status: "unknownOid" } });
			return route.fulfill({ json: { status: "order", order: { order: { ...order, tif: actualTif }, status: "open", statusTimestamp: Date.now() } } });
		}
		return route.continue();
	});
	await context.addInitScript(({ owner, publicKey, privateKey }) => {
		localStorage.setItem("hypeterminal:paper-mode", "live");
		localStorage.setItem("hyperliquid_agent_session_Mainnet", JSON.stringify({ address: owner }));
		localStorage.setItem(`hyperliquid_agent_Mainnet_${owner}`, JSON.stringify({ privateKey, publicKey }));
		window.ethereum = { on() {}, removeListener() {}, async request({ method }) {
			if (method === "eth_accounts" || method === "eth_requestAccounts") return [owner];
			if (method === "eth_chainId") return "0xa4b1";
			throw new Error(`Read-only provider: ${method} forbidden`);
		} };
		globalThis.__tifPaints = [];
		const original = CanvasRenderingContext2D.prototype.fillText;
		CanvasRenderingContext2D.prototype.fillText = function (text, x, y, ...args) {
			if (["Post Only", "Post Only !", "PO", "PO !", "GTC", "GTC…", "Moving…", "Changing…", "Unconfirmed", "MKT", "Trigger Market"].includes(text)) {
				const rect = this.canvas.getBoundingClientRect();
				const width = this.measureText(text).width;
				const cx = x + (this.textAlign === "center" ? 0 : this.textAlign === "right" ? -width / 2 : width / 2);
				const pt = this.getTransform().transformPoint({ x: cx, y });
				const half = this.getTransform().a * width / 2;
				globalThis.__tifPaints.push({ text, x: rect.left + pt.x * rect.width / this.canvas.width, y: rect.top + pt.y * rect.height / this.canvas.height,
					left: rect.left + (pt.x - half) * rect.width / this.canvas.width, right: rect.left + (pt.x + half) * rect.width / this.canvas.width,
					at: Date.now(), inCanvas: pt.x - half >= 0 && pt.x + half <= this.canvas.width && pt.y > 0 && pt.y < this.canvas.height });
				globalThis.__tifPaints = globalThis.__tifPaints.slice(-100);
			}
			return original.call(this, text, x, y, ...args);
		};
	}, { owner, publicKey, privateKey });
	const page = await context.newPage();
	page.setDefaultTimeout(10000);
	const errors = [];
	page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
	try {
		await page.goto(base, { waitUntil: "domcontentloaded", timeout: 30000 });
		await page.waitForTimeout(750);
		if (!mobile) {
			// Hydration/agent restoration can close the modal during connection. Drive
			// whichever connector step is actually visible, then REQUIRE session readiness.
			for (let attempt = 0; attempt < 6; attempt++) {
				if (await page.getByText("Enter size", { exact: true }).isVisible()) break;
				const more = page.getByText(/more wallets/);
				const injected = page.getByRole("button", { name: /^Injected/ });
				const connect = page.getByText("Connect Wallet", { exact: true }).first();
				if (await injected.isVisible()) await injected.click();
				else if (await more.isVisible()) await more.click();
				else if (await connect.isVisible()) await connect.click();
				await page.waitForTimeout(500);
			}
			await page.getByText("Enter size", { exact: true }).waitFor({ timeout: 15000 });
			await page.keyboard.press("Escape");
		}
		const chip = page.getByRole("button", { name: "Change order type", exact: true });
		await chip.waitFor({ timeout: 25000 });
		if (tpSl) {
			const marketLabel = mobile ? "MKT" : "Trigger Market";
			const limitLabel = tpSlMode === "Alo" ? postOnlyLabel : "GTC";
			const selectEngine = async (label) => {
				if (canvas !== "kline") return;
				// Reload defaults to TradingView. Account restoration can replace its iframe;
				// wait for a kline paint and repeat only this reversible UI choice if detached.
				for (let attempt = 0; attempt < 3; attempt++) {
					const iframe = page.locator('iframe[src^="blob:"]').first();
					await iframe.waitFor({ state: "attached", timeout: 20000 });
					await iframe.contentFrame().getByText("Default", { exact: true }).dispatchEvent("click").catch((error) => { if (!error.message.includes("Frame was detached")) throw error; });
					try {
						await page.waitForFunction((label) => globalThis.__tifPaints.some((p) => p.text === label && Date.now() - p.at < 1200 && p.inCanvas), label, { timeout: 5000 });
						return;
					} catch (error) { if (attempt === 2) throw error; }
				}
			};
			const waitLabel = async (label) => page.waitForFunction(({ canvas, label }) => canvas === "kline"
				? globalThis.__tifPaints.some((p) => p.text === label && Date.now() - p.at < 1200 && p.inCanvas)
				: document.querySelector('button[aria-label="Change order type"]')?.textContent === label,
				{ canvas, label }, { timeout: 20000 });
			const choose = async (label, choice) => {
				await waitLabel(label);
				if (canvas === "kline") {
					await page.waitForTimeout(500);
					const point = await page.evaluate((label) => globalThis.__tifPaints.filter((p) => p.text === label && p.inCanvas).at(-1), label);
					await page.touchscreen.tap(point.x, point.y);
				} else await chip.click();
				await page.getByRole("menuitem", { name: "Trigger Market", exact: true }).waitFor({ timeout: 10000 });
				assert.deepEqual(await page.getByRole("menuitem").allTextContents(), ["Post Only", "GTC", "Trigger Market"]);
				await page.getByRole("menuitem", { name: choice, exact: true }).click();
			};
			await selectEngine(marketLabel);
			await choose(marketLabel, tpSlMode === "Alo" ? "Post Only" : "GTC");
			await waitLabel(limitLabel);
			if (process.env.PROBE_SCREENSHOT_DIR) {
				mkdirSync(process.env.PROBE_SCREENSHOT_DIR, { recursive: true });
				await page.screenshot({ path: path.join(process.env.PROBE_SCREENSHOT_DIR, `tpsl-active-${canvas}-${scenario}.png`) });
			}
			assert.equal(cancels, 1); assert.equal(placements, 1); assert.equal(violation, undefined);
			const origins = await page.evaluate(() => JSON.parse(localStorage.getItem("hypeterminal-tpsl-origins"))?.state.origins);
			assert(Object.values(origins).some((origin) => origin.oid === 99 && origin.tpsl === tpSlKind));
			await page.reload({ waitUntil: "domcontentloaded" });
			await selectEngine(limitLabel);
			await choose(limitLabel, "Trigger Market");
			await waitLabel(marketLabel);
			assert.equal(cancels, 2); assert.equal(placements, 2); assert.equal(violation, undefined);
			assert.equal(order.isTrigger, true); assert.equal(order.reduceOnly, true);
			assert.deepEqual(errors, []);
			if (process.env.PROBE_SCREENSHOT_DIR) {
				mkdirSync(process.env.PROBE_SCREENSHOT_DIR, { recursive: true });
				await page.screenshot({ path: path.join(process.env.PROBE_SCREENSHOT_DIR, `tpsl-${canvas}-${scenario}.png`) });
			}
			console.log(`PASS: ${canvas} ${tpSlKind.toUpperCase()} -> ${tpSlMode} active limit -> reload -> trigger market; two verified cancel/reposts, no exchange passthrough`);
			return;
		}
		assert.equal(await chip.innerText(), dragOnly && !native ? "GTC" : postOnlyLabel);
		await page.waitForTimeout(1000);
		let menuAnchor;
		if (canvas === "kline") {
			const frame = page.frames().find((f) => f.url().startsWith("blob:"));
			await frame.getByText("Default", { exact: true }).dispatchEvent("click").catch((error) => { if (!error.message.includes("Frame was detached")) throw error; });
			await page.waitForFunction((label) => globalThis.__tifPaints.some((p) => p.text === label), dragOnly && !native ? "GTC" : postOnlyLabel, { timeout: 15000 });
			await page.waitForTimeout(1200);
			await page.waitForFunction(() => {
				const p = globalThis.__tifPaints.at(-1);
				return p && p.inCanvas && p.x > 0 && p.y > 0 && p.x < innerWidth && p.y < innerHeight && document.elementFromPoint(p.x, p.y)?.tagName === "CANVAS";
			}, null, { timeout: 15000 });
			const point = await page.evaluate(() => globalThis.__tifPaints.at(-1));
			menuAnchor = { left: point.x, top: point.y, bottom: point.y };
			if (!dragOnly) { if (mobile) await page.touchscreen.tap(point.x, point.y); else await page.mouse.click(point.x, point.y); }
		} else if (!dragOnly) {
			if (menuAnchorOnly) await chip.evaluate((element) => {
				// Locator clicks wait for stability; record the same event/rect the menu uses.
				element.addEventListener("click", () => {
					const rect = element.getBoundingClientRect();
					globalThis.__tifMenuClickAnchor = { left: rect.left, top: rect.top, bottom: rect.bottom };
				}, { once: true });
			});
			await chip.click();
			if (menuAnchorOnly) menuAnchor = await page.evaluate(() => globalThis.__tifMenuClickAnchor);
		}
		if (menuAnchorOnly) {
			const menu = page.getByRole("menu");
			await menu.waitFor();
			const box = await menu.boundingBox();
			const viewport = page.viewportSize();
			const gap = Math.min(Math.abs(box.y - menuAnchor.bottom), Math.abs(menuAnchor.top - box.y - box.height));
			assert(gap <= 12, `menu must touch its order label: gap=${gap}px`);
			assert(Math.abs(box.x - Math.max(8, Math.min(menuAnchor.left, viewport.width - box.width - 8))) <= 2, "menu follows the clicked label horizontally");
			assert(box.y >= 8 && box.y + box.height <= viewport.height - 8, "menu fits viewport vertically");
			assert.deepEqual(await menu.getByRole("menuitem").allTextContents(), ["Post Only", "GTC"]);
			assert.equal(cancels, 0); assert.equal(placements, 0); assert.equal(violation, undefined); assert.deepEqual(errors, []);
			if (process.env.PROBE_SCREENSHOT_DIR) {
				mkdirSync(process.env.PROBE_SCREENSHOT_DIR, { recursive: true });
				await page.screenshot({ path: path.join(process.env.PROBE_SCREENSHOT_DIR, `menu-${mobile ? "phone" : "desktop"}-${canvas}.png`) });
			}
			console.log(`PASS: ${mobile ? "phone" : "desktop"} ${canvas} menu anchored, gap=${gap}px; anchor=${JSON.stringify(menuAnchor)} menu=${JSON.stringify(box)}; zero writes`);
			return;
		}
		if (!dragOnly) await page.getByRole("menuitem", { name: "GTC", exact: true }).click();
		const expected = successful ? wantedLabel : "Post Only !";
		await page.waitForFunction(({ canvas, expected }) => canvas === "kline"
			? globalThis.__tifPaints.at(-1)?.text === expected
			: document.querySelector('button[aria-label="Change order type"]')?.textContent === expected,
		{ canvas, expected }, { timeout: 15000 });
		assert.equal(cancels, dragOnly ? 0 : 1);
		assert.equal(placements, dragOnly || scenario === "cancel-rejected" ? 0 : 1);
		assert.equal(violation, undefined);
		if (typePlaceholderOnly) {
			assert(placeholderChecks >= 3, "Changing placeholder stays visible during delayed cancellation with an empty book");
			assert.deepEqual(errors, []);
			console.log(`PASS: ${mobile ? "phone" : "desktop"} ${canvas} Changing placeholder, ${placeholderChecks} visible samples during empty book; one confirmed replacement; no exchange passthrough`);
			return;
		}
		if (successful) {
			if (!dragOnly) await page.getByText("BTC order #99 confirmed GTC by exchange", { exact: true }).waitFor();
			await page.waitForTimeout(dragOnly ? 300 : 16000);
			const label = canvas === "kline" ? await page.evaluate(() => globalThis.__tifPaints.at(-1)?.text) : await chip.innerText();
			assert.equal(label, wantedLabel, "correct TIF before drag");
			let point;
			if (canvas === "kline") {
				point = await page.evaluate(() => { const p = globalThis.__tifPaints.at(-1); return { x: p.x + 80, y: p.y }; });
			} else {
				const box = await page.locator(`[data-tv-line="order-${dragOid}"] .cursor-grab`).boundingBox();
				assert(box, "order's drag band exists");
				point = { x: box.x + box.width * 0.8, y: box.y + box.height / 2 };
			}
			if (mobile) {
				const cdp = await context.newCDPSession(page);
				await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
				for (let step = 1; step <= 6; step++) {
					await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: point.x, y: point.y - step * 5 }] });
					await page.waitForTimeout(30);
				}
				await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
				await cdp.detach();
			} else {
				await page.mouse.move(point.x, point.y);
				await page.mouse.down();
				await page.mouse.move(point.x, point.y - 30, { steps: 6 });
				await page.mouse.up();
			}
			if (unconfirmed) {
				await page.waitForFunction(() => [...document.querySelectorAll('[data-tv-line^="order-"]')].some((row) => row.textContent.includes("Unconfirmed")), null, { timeout: 20000 });
				const marker = page.locator('[data-tv-line="order-42"]');
				assert.equal(await marker.locator('.cursor-grab, button[aria-label="Change order type"], [data-box-key="cancel"]').count(), 0);
				assert.equal(cancels, 1); assert.equal(placements, 0); assert(placeholderChecks > 0);
				assert.equal(violation, undefined); assert.deepEqual(errors, []);
				console.log("PASS: phone failure marker survives removed order; no chart actions or duplicate writes");
				return;
			}
			await page.waitForFunction(({ canvas, wantedLabel }) => canvas === "kline"
				? globalThis.__tifPaints.at(-1)?.text === wantedLabel
				: document.querySelector('[data-tv-line="order-100"] button[aria-label="Change order type"]')?.textContent === wantedLabel,
			{ canvas, wantedLabel }, { timeout: 20000 });
			// Canvas can still show the previous paint before the request; wait for its new oid too.
			for (let i = 0; i < 200 && reprices === 0 && !violation; i++) await page.waitForTimeout(100);
			assert.equal(violation, undefined);
			assert.equal(reprices, 1, "actual drag submitted exactly one reprice");
			assert.equal(cancels, native ? 0 : dragOnly ? 1 : 2);
			assert.equal(placements, native ? 0 : dragOnly ? 1 : 2);
			if (!native) assert(placeholderChecks > 0, "Moving placeholder survived empty WS and transient cancellation read failure");
			assert(repricedPx);
			await page.waitForTimeout(700);
			assert.equal(canvas === "kline" ? await page.evaluate(() => globalThis.__tifPaints.at(-1)?.text) : await chip.innerText(), wantedLabel);
			if (!mobile) {
				await page.waitForTimeout(11000);
				assert.equal(canvas === "kline" ? await page.evaluate(() => globalThis.__tifPaints.at(-1)?.text) : await chip.innerText(), wantedLabel);
			}
			console.log(`PASS: actual ${mobile ? "touch" : "mouse"} ${canvas} drag preserves ${wantedLabel}, new oid 100, same remaining size; Moving placeholder checks=${placeholderChecks}`);
		} else assert.equal(await page.getByText(/confirmed GTC by exchange/).count(), 0);
		if (mobile) await page.locator('[aria-label="Primary navigation"]').getByText("Positions", { exact: true }).dispatchEvent("click");
		await page.getByRole("tab", { name: mobile ? /^Orders/ : /^Open Orders/ }).click();
		const cell = page.locator(`[data-order-tif="${order.oid}"]`);
		await cell.waitFor();
		assert((await cell.innerText()).startsWith(successful ? wantedLabel : "Post Only"));
		if (!successful) assert((await cell.innerText()).includes(scenario === "unchanged" ? "Type change not confirmed" : "Cancel rejected fixture"));
		assert.deepEqual(errors, []);
		console.log(`PASS: LIVE cancel/repost ${mobile ? "phone" : "desktop"} ${canvas} ${scenario}; Open Orders TIF verified`);
	} catch (error) {
		if (process.env.PROBE_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.PROBE_SCREENSHOT_DIR, `failure-${canvas}-${scenario}.png`) });
		console.error("UI at failure:", (await page.locator("body").innerText()).slice(-5000), { cancels, placements, reprices, placeholderChecks, cancellationVerified, violation, errors, paints: await page.evaluate(() => globalThis.__tifPaints.slice(-10)) });
		throw error;
	} finally { await context.close(); }
}
try {
	if (typePlaceholderOnly || menuAnchorOnly) {
		for (const mobile of [false, true]) for (const canvas of ["TradingView", "kline"]) await run(mobile, canvas);
	} else if (process.env.TPSL_ONLY === "1") {
		const engines = ["TradingView", "kline"].filter((canvas) => !process.env.TPSL_CANVAS || process.env.TPSL_CANVAS === canvas);
		assert(engines.length > 0, "TPSL_CANVAS must name a supported engine");
		for (const canvas of engines) for (const scenario of ["tpsl-po", "tpsl-gtc"]) await run(true, canvas, scenario);
	} else if (process.env.KLINE_TIF_ONLY === "1") await run(false, "kline");
	else {
	await run(false, "TradingView");
	if (process.env.DRAG_TIF_ONLY !== "1") {
		await run(false, "TradingView", "cancel-rejected");
		await run(false, "TradingView", "unchanged");
		await run(true, "TradingView");
		await run(false, "kline");
		await run(true, "kline");
		await run(false, "TradingView", "post-only");
		await run(false, "TradingView", "gtc-existing");
		await run(true, "TradingView", "stream-only");
		await run(true, "kline", "stream-only");
		await run(true, "TradingView", "cancel-unconfirmed");
	}
	}
} finally { await browser.close(); }
