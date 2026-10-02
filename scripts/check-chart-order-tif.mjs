// Production-build regression probe. Uses simulated orders only, including on live URLs.
// BASE_URL=http://localhost:3100/ node scripts/check-chart-order-tif.mjs
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const pnpmRoot = path.join(process.cwd(), "node_modules", ".pnpm");
const entry = readdirSync(pnpmRoot).find((name) => name.startsWith("playwright@"));
const { chromium } = await import(pathToFileURL(path.join(pnpmRoot, entry, "node_modules/playwright/index.mjs")).href);
const msRoot = path.join(process.env.LOCALAPPDATA ?? "", "ms-playwright");
const executablePath = (existsSync(msRoot) ? readdirSync(msRoot) : [])
	.filter((name) => name.startsWith("chromium-") && !name.includes("headless"))
	.map((name) => path.join(msRoot, name, "chrome-win/chrome.exe"))
	.find(existsSync) ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const browser = await chromium.launch({ headless: true, executablePath });
const base = process.env.BASE_URL ?? "http://localhost:3100/";

async function readOrder(page) {
	return page.evaluate(() => JSON.parse(localStorage.getItem("hypeterminal:paper-trading-v1"))?.state.openOrders[0]);
}

async function prepare(page, mobile) {
	await page.goto(base, { waitUntil: "domcontentloaded", timeout: 30_000 });
	if (mobile) await page.locator('[aria-label="Primary navigation"]').getByText("Trade", { exact: true }).dispatchEvent("click");
	else {
		for (let attempt = 0; attempt < 6; attempt++) {
			if (await page.getByText("Enter size", { exact: true }).isVisible()) break;
			const injected = page.getByRole("button", { name: /^Injected/ });
			const more = page.getByText(/more wallets/);
			const connect = page.getByText("Connect Wallet", { exact: true }).first();
			if (await injected.isVisible()) await injected.click();
			else if (await more.isVisible()) await more.click();
			else if (await connect.isVisible()) await connect.click();
			await page.waitForTimeout(500);
		}
		await page.getByText("Enter size", { exact: true }).waitFor({ timeout: 15000 });
		await page.keyboard.press("Escape");
	}
	await page.getByRole("button", { name: "Order type", exact: true }).click();
	await page.getByText("Limit", { exact: true }).first().click();
	const form = page.locator("[data-order-form]");
	await form.getByText("Mid", { exact: true }).click();
	const price = form.locator('input[placeholder="0.00"]').nth(mobile ? 1 : 0);
	const current = Number(await price.inputValue());
	assert(current > 0, "limit price seeded from the mark");
	await price.fill(String(Math.floor(current * 0.9995)));
	await page.getByRole("button", { name: "25%", exact: true }).click();
	const submit = form.getByRole("button", { name: /^(Long|Place Long Order)$/ }).last();
	console.log("submit:", await submit.innerText());
	await submit.click();
	await page.waitForFunction(() => JSON.parse(localStorage.getItem("hypeterminal:paper-trading-v1"))?.state.openOrders.length === 1, null, { timeout: 15_000 });
	const order = await readOrder(page);
	assert.equal(order.tif, "Alo");
	// Hide the draft so only the already-placed order is interactive.
	await page.getByRole("button", { name: "Order type", exact: true }).click();
	await page.getByText("Market", { exact: true }).first().click();
	if (mobile) await page.locator('[aria-label="Primary navigation"]').getByText("Chart", { exact: true }).dispatchEvent("click");
	await page.getByRole("button", { name: "Change order type", exact: true }).waitFor({ timeout: 25_000 });
	assert.equal(await page.getByRole('button', { name: 'Change order type', exact: true }).innerText(), mobile ? 'PO' : 'Post Only', 'responsive Post Only chart label');
	const label = await page.locator('[data-tv-line^="order-"] [data-tv-strip]').innerText();
	assert(!/\bLimit\b/i.test(label), 'TradingView order label omits redundant Limit word');
	assert(label.includes('USD') && label.includes('✕'), 'TradingView keeps order data and cancel');
	return order;
}

async function pickTv(page, label, mobile) {
	const chip = page.getByRole("button", { name: "Change order type", exact: true });
	if (mobile) {
		const box = await chip.boundingBox();
		assert(box, "visible TradingView chip");
		await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
	} else await chip.click();
	const menu = page.getByRole("menu");
	assert.deepEqual(await menu.getByRole("menuitem").allTextContents(), ["Post Only", "GTC"]);
	// Keep it open across market ticks, as a real user would.
	await page.waitForTimeout(1500);
	const option = menu.getByRole("menuitem", { name: label, exact: true });
	if (mobile) {
		const box = await option.boundingBox();
		assert(box, "visible type option");
		await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
	} else await option.click();
}

async function assertStable(page, order, mobile, canvas) {
	let elapsed = 0;
	for (const ms of [400, 1500, 3000]) {
		await page.waitForTimeout(ms - elapsed);
		elapsed = ms;
		if (canvas === "TradingView") {
			assert.equal(await page.getByRole("button", { name: "Change order type", exact: true }).innerText(), "GTC", `chip at +${ms}ms`);
		} else {
			const painted = await page.evaluate(() => globalThis.__tifPaints.filter((p) => p.text === "GTC" && Date.now() - p.at < 5000).length);
			assert(painted > 0, `kline canvas painted GTC at +${ms}ms`);
		}
		const next = await readOrder(page);
		assert(next, "order still rests");
		assert.deepEqual({ ...next, tif: order.tif }, order, "same oid/size/price and all other fields");
		assert.equal(next.tif, "Gtc");
		console.log(`PASS: ${mobile ? "phone" : "desktop"} ${canvas} GTC at +${ms}ms, same oid/size/price`);
	}
}

async function switchToKline(page) {
	await page.locator('iframe[src^="blob:"]').waitFor({ timeout: 25000 });
	const frame = page.frames().find((f) => f !== page.mainFrame() && f.url().startsWith("blob:"));
	assert(frame, "TradingView iframe");
	await frame.getByText("Default", { exact: true }).dispatchEvent("click").catch((error) => {
		// Switching source synchronously disposes the widget iframe that received the click.
		if (!error.message.includes("Frame was detached")) throw error;
	});
}

async function checkKline(page, order, mobile) {
	await pickTv(page, "Post Only", mobile);
	await switchToKline(page);
	const postOnlyLabel = mobile ? 'PO' : 'Post Only';
	await page.waitForFunction((label) => globalThis.__tifPaints.some((p) => p.text === label), postOnlyLabel, { timeout: 15_000 });
	await page.waitForTimeout(1200);
	const paintedLabels = await page.evaluate(() => globalThis.__orderLabelPaints.filter((p) => Date.now() - p.at < 5000));
	assert(paintedLabels.some((p) => p.text.includes('USD')), 'kline painted order data');
	assert(!paintedLabels.some((p) => /\bLimit\b/i.test(p.text)), 'kline order label omits redundant Limit word');
	// Initial chart-range hydration can briefly paint an offscreen price coordinate.
	// Only tap an actual visible canvas hit, never the startup placeholder transform.
	await page.waitForFunction((label) => {
		const p = globalThis.__tifPaints.filter((item) => item.text === label).at(-1);
		return p && p.inCanvas && p.x > 0 && p.y > 0 && p.x < innerWidth && p.y < innerHeight && document.elementFromPoint(p.x, p.y)?.tagName === "CANVAS";
	}, postOnlyLabel, { timeout: 15000 });
	const point = await page.evaluate((label) => {
		const p = globalThis.__tifPaints.filter((item) => item.text === label).at(-1);
		return { ...p, hit: document.elementFromPoint(p.x, p.y)?.tagName };
	}, postOnlyLabel);
	console.log("kline canvas point:", point);
	if (mobile) await page.touchscreen.tap(point.x, point.y);
	else await page.mouse.click(point.x, point.y);
	await page.getByRole("menu").waitFor({ timeout: 5000 });
	assert.deepEqual(await page.getByRole("menuitem").allTextContents(), ["Post Only", "GTC"]);
	if (process.env.PO_ONLY === '1') {
		await page.keyboard.press('Escape');
		if (mobile && process.env.PROBE_SCREENSHOT_DIR) {
			mkdirSync(process.env.PROBE_SCREENSHOT_DIR, { recursive: true });
			await page.screenshot({ path: path.join(process.env.PROBE_SCREENSHOT_DIR, 'phone-kline-PO.png') });
		}
		console.log(`PASS: ${mobile ? 'phone PO' : 'desktop Post Only'} chart labels on both engines; full menu labels`);
		return;
	}
	const option = page.getByRole("menuitem", { name: "GTC", exact: true });
	if (mobile) {
		const box = await option.boundingBox();
		assert(box, "visible kline type option");
		await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
	} else await option.click();
	await assertStable(page, order, mobile, "kline");
}

async function checkStickyEntry(page, mobile) {
	if (mobile) await page.locator('[aria-label="Primary navigation"]').getByText("Trade", { exact: true }).dispatchEvent("click");
	await page.getByRole("button", { name: "Order type", exact: true }).click();
	await page.getByText("Limit", { exact: true }).first().click();
	const form = page.locator('[data-order-form]');
	const tif = form.getByRole('combobox').filter({ hasText: /^(Post Only|GTC|IOC)$/ });
	const price = form.locator('input[placeholder="0.00"]').nth(mobile ? 1 : 0);
	for (const label of ['GTC', 'IOC']) {
		await tif.click();
		await page.getByRole('option', { name: label, exact: true }).click();
		for (let submission = 0; submission < 2; submission++) {
			await form.getByText('Mid', { exact: true }).click();
			const mark = Number(await price.inputValue());
			await price.fill(String(Math.round(mark * (label === 'IOC' ? 1.001 : 0.999))));
			await page.getByRole('button', { name: '25%', exact: true }).click();
			await form.getByRole('button', { name: /^(Long|Place Long Order)$/ }).last().click();
			await page.waitForFunction(({ mobile }) => {
				const inputs = document.querySelectorAll('[data-order-form] input[placeholder="0.00"]');
				return inputs[mobile ? 1 : 0]?.value === '';
			}, { mobile });
			assert.equal(await tif.innerText(), label, `entry retains ${label} after submission ${submission + 1}`);
		}
	}
	console.log(`PASS: ${mobile ? 'phone' : 'desktop'} real paper form retains GTC and IOC across two submissions each`);
}

async function visibleCancelBox(page, order, engine) {
	if (engine === 'TradingView') {
		const cell = page.locator(`[data-tv-line="order-${order.oid}"] [data-box-key="cancel"]`);
		await cell.waitFor();
		return cell.boundingBox();
	}
	await page.waitForFunction(() => {
		const p = globalThis.__tifPaints.filter((item) => item.text === '✕').at(-1);
		return p && p.inCanvas && Date.now() - p.at < 1000 && p.x > 0 && p.y > 0 && p.x < innerWidth && p.y < innerHeight && document.elementFromPoint(p.x, p.y)?.tagName === 'CANVAS';
	});
	return page.evaluate(() => {
			const p = globalThis.__tifPaints.filter((item) => item.text === '✕').at(-1);
			return p ? { x: p.x - p.width / 2 - 5, y: p.y - 9, width: p.width + 10, height: 18 } : null;
		});
}

async function checkMobileAxisSeparation(page, order, engine) {
	const cancel = await visibleCancelBox(page, order, engine);
	assert(cancel, `${engine} visible cancel cell`);
	const y = cancel.y + cancel.height / 2;
	const cross = page.getByRole('button', { name: /^Set order price/ });
	for (let attempt = 0; attempt < 3; attempt++) {
		await page.touchscreen.tap(page.viewportSize().width - 25, y);
		await page.waitForTimeout(300);
		if (await cross.isVisible()) break;
	}
	const crossBox = await cross.boundingBox();
	assert(crossBox, `${engine} axis price picker at order height`);
	assert(Math.abs(crossBox.y + crossBox.height / 2 - y) < 2, `${engine} picker shares cancel height`);
	const gap = crossBox.x - (cancel.x + cancel.width + (engine === 'TradingView' ? 6 : 0));
	assert(gap > 0, `${engine} cancel touch box clears picker, gap=${gap}`);
	if (process.env.PROBE_SCREENSHOT_DIR) {
		mkdirSync(process.env.PROBE_SCREENSHOT_DIR, { recursive: true });
		await page.screenshot({ path: path.join(process.env.PROBE_SCREENSHOT_DIR, `phone-${engine}-axis-spacing.png`) });
	}
	await page.touchscreen.tap(crossBox.x + crossBox.width / 2, crossBox.y + crossBox.height / 2);
	const buy = page.getByRole('button', { name: /^Limit Buy/ });
	await buy.waitFor();
	assert.equal((await readOrder(page)).oid, order.oid, `${engine} picker leaves placed order intact`);
	// Test both targets on this same chart instance before form navigation remounts it.
	await page.keyboard.press('Escape');
	await page.waitForTimeout(400);
	const nextCancel = await visibleCancelBox(page, order, engine);
	assert(nextCancel, `${engine} cancel remains visible`);
	await page.touchscreen.tap(nextCancel.x + nextCancel.width / 2, nextCancel.y + nextCancel.height / 2);
	await page.waitForFunction(() => JSON.parse(localStorage.getItem('hypeterminal:paper-trading-v1'))?.state.openOrders.length === 0);
	assert.equal(await buy.count(), 0, `${engine} cancel does not open price menu`);
	await page.touchscreen.tap(page.viewportSize().width - 25, y);
	await cross.waitFor();
	const picker = await cross.boundingBox();
	await page.touchscreen.tap(picker.x + picker.width / 2, picker.y + picker.height / 2);
	await buy.waitFor();
	const pickedPrice = (await cross.getAttribute('aria-label')).replace('Set order price ', '');
	await buy.tap();
	assert.equal(await page.locator('[data-order-form] input[placeholder="0.00"]').nth(1).inputValue(), pickedPrice, `${engine} picker fills limit price`);
	await page.getByRole('button', { name: 'Order type', exact: true }).click();
	await page.getByText('Market', { exact: true }).first().click();
	console.log(`PASS: phone ${engine} separate picker/cancel touches at same height, ${gap.toFixed(1)}px clear gap`);
}

try {
	for (const mobile of [true, false]) {
		const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1600, height: 950 }, isMobile: mobile, hasTouch: mobile, serviceWorkers: "block" });
		await context.addInitScript(() => {
			// Never place real exchange orders; fresh contexts have no wallet credentials.
			localStorage.setItem("hypeterminal:paper-mode", "paper");
			// Read-only account pointer activates the preview balance; no wallet or signing key.
			for (const env of ["Mainnet", "Testnet"]) {
				localStorage.setItem(`hyperliquid_agent_session_${env}`, JSON.stringify({ address: "0x0000000000000000000000000000000000000001" }));
			}
			// Read-only injected provider for desktop preview; signing methods deliberately fail.
			window.ethereum = {
				on() {},
				removeListener() {},
				async request({ method }) {
					if (method === "eth_accounts" || method === "eth_requestAccounts") return ["0x0000000000000000000000000000000000000001"];
					if (method === "eth_chainId") return "0xa4b1";
					if (method === "net_version") return "42161";
					throw new Error(`Read-only preview provider: ${method} forbidden`);
				},
			};
			globalThis.__tifPaints = [];
			globalThis.__orderLabelPaints = [];
			const original = CanvasRenderingContext2D.prototype.fillText;
			CanvasRenderingContext2D.prototype.fillText = function (text, x, y, ...args) {
				if (/USD|\bLimit\b/i.test(text)) {
					globalThis.__orderLabelPaints.push({ text, at: Date.now() });
					globalThis.__orderLabelPaints = globalThis.__orderLabelPaints.slice(-200);
				}
				if (text === "Post Only" || text === "PO" || text === "GTC" || text === "✕") {
					const rect = this.canvas.getBoundingClientRect();
					const width = this.measureText(text).width;
					const cx = x + (this.textAlign === "center" ? 0 : this.textAlign === "right" ? -width / 2 : width / 2);
					const pt = this.getTransform().transformPoint({ x: cx, y });
					globalThis.__tifPaints.push({ text, width: width * this.getTransform().a * rect.width / this.canvas.width, x: rect.left + pt.x * rect.width / this.canvas.width, y: rect.top + pt.y * rect.height / this.canvas.height, at: Date.now(), inCanvas: pt.x > 0 && pt.y > 0 && pt.x < this.canvas.width && pt.y < this.canvas.height });
					globalThis.__tifPaints = globalThis.__tifPaints.slice(-100);
				}
				return original.call(this, text, x, y, ...args);
			};
		});
		await context.route("**/exchange", (route) => route.abort()); // Fail closed: paper probes cannot reach the exchange.
		const page = await context.newPage();
		page.setDefaultTimeout(10_000);
		page.on("pageerror", (error) => console.error("PAGE ERROR:", error.message));
		let order = await prepare(page, mobile);
		console.log("resting order:", order);
		if (process.env.PO_ONLY === '1') {
			if (mobile && process.env.PROBE_SCREENSHOT_DIR) {
				mkdirSync(process.env.PROBE_SCREENSHOT_DIR, { recursive: true });
				await page.screenshot({ path: path.join(process.env.PROBE_SCREENSHOT_DIR, 'phone-TradingView-PO.png') });
			}
			await checkKline(page, order, mobile);
			await context.close();
			continue;
		}
		await pickTv(page, "GTC", mobile);
		await assertStable(page, order, mobile, "TradingView");
		if (mobile) {
			await checkMobileAxisSeparation(page, order, 'TradingView');
			order = await prepare(page, mobile);
		}
		await checkKline(page, order, mobile);
		if (mobile) await checkMobileAxisSeparation(page, order, 'kline');
		await checkStickyEntry(page, mobile);
		await context.close();
	}
} catch (error) {
	for (const context of browser.contexts()) {
		for (const page of context.pages()) {
			console.error("UI at failure:", (await page.locator("body").innerText()).slice(-6000));
			await page.screenshot({ path: "chart-tif-failure.png" });
		}
	}
	throw error;
} finally {
	await browser.close();
}
