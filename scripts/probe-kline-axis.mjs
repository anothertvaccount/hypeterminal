import { readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const pnpmRoot = path.join(process.cwd(), "node_modules", ".pnpm");
const entry = readdirSync(pnpmRoot).find((name) => name.startsWith("playwright@"));
const playwright = await import(
	pathToFileURL(path.join(pnpmRoot, entry, "node_modules", "playwright", "index.js")).href
);
const { chromium } = playwright.default ?? playwright;
function findChromium() {
	const msRoot = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "ms-playwright") : "";
	try {
		const builds = readdirSync(msRoot)
			.filter((name) => name.startsWith("chromium-") && !name.includes("headless"))
			.sort()
			.reverse();
		for (const build of builds) {
			const candidate = path.join(msRoot, build, "chrome-win", "chrome.exe");
			try {
				if (readdirSync(path.dirname(candidate)).includes("chrome.exe")) return candidate;
			} catch {}
		}
	} catch {}
	return "C:/Program Files/Google/Chrome/Application/chrome.exe";
}
const browser = await chromium.launch({ headless: true, executablePath: findChromium() });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await context.newPage();
try {
	await page.goto("http://localhost:3000/");
	await page.waitForSelector('[aria-label="Primary navigation"]', { timeout: 30000 });
	// kline mounts in the Chart section (default view here after boot)
	await page.waitForFunction(() => Boolean(globalThis.__hlChart), null, { timeout: 20000 });
	await page.waitForTimeout(1500);

	const measure = () =>
		page.evaluate(() => {
			const chart = globalThis.__hlChart;
			const container = globalThis.__hlContainer;
			const r = container.getBoundingClientRect();
			const y = Math.round(r.top + r.height * 0.4);
			const x = Math.round(r.right - 15);
			const converted = chart.convertFromPixel([{ y }], { paneId: "candle_pane", absolute: true });
			const point = Array.isArray(converted) ? converted[0] : converted;
			const price = typeof point?.value === "number" ? point.value : null;
			return { x, y, price };
		});
	const before = await measure();
	console.log("before:", JSON.stringify(before));

	// --- lever test: PaneGap changes the autoscaled price range? ---
	await page.evaluate(() => {
		globalThis.__hlChart.setPaneOptions({ id: "candle_pane", gap: { top: 120, bottom: 120 } });
	});
	await page.waitForTimeout(400);
	const afterGap = await measure();
	console.log("after gap{120,120}:", JSON.stringify(afterGap), "changed:", afterGap.price !== before.price);
	await page.evaluate(() => {
		globalThis.__hlChart.setPaneOptions({ id: "candle_pane", gap: { top: -60, bottom: -60 } });
	});
	await page.waitForTimeout(400);
	const afterNegGap = await measure();
	console.log("after gap{-60,-60}:", JSON.stringify(afterNegGap), "changed:", afterNegGap.price !== afterGap.price);
	await page.evaluate(() => {
		globalThis.__hlChart.setPaneOptions({ id: "candle_pane", gap: { top: 0, bottom: 0 } });
	});
	await page.waitForTimeout(400);

	// --- enable kline's axis scroll/zoom option, then retry both inputs ---
	await page.evaluate(() => {
		globalThis.__hlChart.setPaneOptions({ id: "candle_pane", axisOptions: { scrollZoomEnabled: true } });
	});
	await page.waitForTimeout(300);

	// --- synthetic wheel on the axis DOM: does kline scale price on wheel? ---
	const wheelRes = await page.evaluate(() => {
		const chart = globalThis.__hlChart;
		let el = null;
		try {
			el = chart.getDom("candle_pane", "yAxis");
		} catch {
			el = null;
		}
		if (!el) return { ok: false, why: "no axis dom" };
		const r = el.getBoundingClientRect();
		const cx = r.left + r.width / 2;
		const cy = r.top + r.height / 2;
		for (let i = 0; i < 6; i++) {
			el.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
		}
		return { ok: true, rect: { w: Math.round(r.width), h: Math.round(r.height) } };
	});
	await page.waitForTimeout(400);
	const afterWheel = await measure();
	console.log("axis dom:", JSON.stringify(wheelRes), "after wheel:", afterWheel.price, "changed:", Math.abs(afterWheel.price - afterGap.price) > 5);

	// --- mouse drag on the axis ---
	await page.mouse.move(before.x, before.y);
	await page.mouse.down();
	for (let i = 1; i <= 10; i++) await page.mouse.move(before.x, before.y - i * 12);
	await page.mouse.up();
	await page.waitForTimeout(400);
	const afterMouse = await measure();
	console.log("after mouse-drag:", JSON.stringify(afterMouse), "changed:", Math.abs(afterMouse.price - before.price) > 1);

	// --- touch drag on the axis (CDP) ---
	const cdp = await context.newCDPSession(page);
	const t = before;
	await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: t.x, y: t.y }] });
	for (let i = 1; i <= 10; i++) {
		await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: t.x, y: t.y - i * 12 }] });
		await page.waitForTimeout(16);
	}
	await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
	await page.waitForTimeout(400);
	const afterTouch = await measure();
	console.log("after touch-drag:", JSON.stringify(afterTouch), "changed:", Math.abs(afterTouch.price - before.price) > 1);
} catch (e) {
	console.log("PROBE ERR", String(e).slice(0, 300));
} finally {
	await browser.close();
}
