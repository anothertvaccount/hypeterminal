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
	return "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
}

const browser = await chromium.launch({ headless: true, executablePath: findChromium() });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
try {
	await page.goto("http://localhost:3000/", { waitUntil: "domcontentloaded" });
	await page.waitForFunction(() => globalThis.__hlOrderEntry && globalThis.__hlContainer, null, {
		timeout: 30000,
	});
	await page.waitForTimeout(4000);
	// Switch to the TradingView canvas first, then seed the limit + TP/SL drafts.
	const initialToggle = page.getByRole("button", { name: "TradingView", exact: true });
	if ((await initialToggle.count()) > 0) await initialToggle.first().click(); // leave the kline backup
	// (TradingView is the default chart — nothing to click when it already is)
	await page.waitForFunction(() => Boolean(globalThis.__hlTvWidget), null, { timeout: 30000 });
	await page.waitForFunction(() => globalThis.__hlTvCal?.() != null, null, { timeout: 30000 });
	await page.mouse.move(420, 400, { steps: 4 });
	await page.waitForTimeout(400);
	await page.evaluate(() => {
		const a = globalThis.__hlOrderEntry.getState().actions;
		a.setOrderType("scale");
		a.setSide("buy");
		a.setSize("0.01");
		a.setScaleStart("83000");
		a.setScaleEnd("85000");
		a.setScaleLevels(4);
		a.setScalePreview(true);
	});
	await page.waitForTimeout(600);
	try {
		await page.getByText("Price Distribution").first().scrollIntoViewIfNeeded({ timeout: 3000 });
	} catch {}
	await page.waitForTimeout(1200);
	const diag = await page.evaluate(() => {
		const s = globalThis.__hlOrderEntry.getState();
		return {
			orderType: s.orderType,
			limit: s.limitPrice,
			scaleStart: s.scaleStart,
			scaleEnd: s.scaleEnd,
			scalePreview: s.scalePreview,
			tpSlEnabled: s.tpSlEnabled,
			tp: s.tpPrice,
			sl: s.slPrice,
			previews: Object.values(globalThis.__hlBoxLog ?? {})
				.filter((r) => r.name === "previewLine")
				.map((r) => ({ value: r.value, boxes: r.boxes.length })),
			others: Object.values(globalThis.__hlBoxLog ?? {})
				.filter((r) => r.name !== "previewLine" && r.name !== "orderLine" && r.name !== "positionLine" && r.name !== "liquidationLine")
				.map((r) => ({ name: r.name, value: r.value })),
		};
	});
	console.log("diag:", JSON.stringify(diag));
	await page.screenshot({ path: "preview-tv.png" });
	console.log("saved preview-tv.png");
} finally {
	if (errors.length > 0) console.log("page errors:", errors.slice(0, 5));
	await browser.close();
}
