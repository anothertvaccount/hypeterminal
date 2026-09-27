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
	await page.waitForFunction(() => Boolean(globalThis.__hlTvWidget), null, { timeout: 30000 });
	await page.waitForTimeout(5000);
	const axis = await page.evaluate(() => {
		const m = globalThis.__hlTvCal?.();
		return m?.axis ? { left: m.axis.left, top: m.axis.top, right: m.axis.left + m.axis.width, width: m.axis.width } : null;
	});
	console.log("axis:", JSON.stringify(axis));
	await page.touchscreen.tap(axis.right - 25, axis.top + 200);
	await page.waitForTimeout(600);
	const cross = page.getByRole("button", { name: /^Set order price/ });
	const crossCount = await cross.count();
	console.log("cross count:", crossCount);
	if (crossCount > 0) {
		const box = await cross.first().boundingBox();
		console.log("cross box:", JSON.stringify(box));
		const hit = await page.evaluate(([x, y]) => {
			const el = document.elementFromPoint(x, y);
			return el ? { tag: el.tagName, cls: String(el.className).slice(0, 80), aria: el.getAttribute("aria-label") } : null;
		}, [box.x + box.width / 2, box.y + box.height / 2]);
		console.log("elementFromPoint at cross:", JSON.stringify(hit));
		await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
		await page.waitForTimeout(700);
		console.log("menu after tap:", await page.getByText("Limit Buy").count());
		// also try a real mouse click for comparison
		await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
		await page.waitForTimeout(500);
		console.log("menu after mouse click:", await page.getByText("Limit Buy").count());
	}
} catch (e) {
	console.log("ERR", String(e).slice(0, 300));
} finally {
	await browser.close();
}
