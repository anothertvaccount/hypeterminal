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
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
try {
	await page.goto("http://localhost:3000/");
	await page.waitForFunction(() => Boolean(globalThis.__hlTvWidget), null, { timeout: 25000 });
	await page.waitForTimeout(4000);

	const state = await page.evaluate(
		() =>
			new Promise((res) => {
				globalThis.__hlTvWidget.save((s) => res(s));
			}),
	);
	console.log("layout:", JSON.stringify(state.layout), "charts:", state.charts?.length);
	console.log(
		"pane0 axes: left=",
		JSON.stringify(state.charts?.[0]?.panes?.[0]?.leftAxisesState?.length),
		"right=",
		JSON.stringify(state.charts?.[0]?.panes?.[0]?.rightAxisesState?.length),
	);

	// Move the main axis to the LEFT exactly as a captured left-side state would look.
	const crafted = structuredClone(state);
	for (const pane of crafted.charts?.[0]?.panes ?? []) {
		if ((pane.leftAxisesState?.length ?? 0) === 0 && (pane.rightAxisesState?.length ?? 0) > 0) {
			pane.leftAxisesState = pane.rightAxisesState;
			pane.rightAxisesState = [];
		}
	}
	await page.evaluate((s) => localStorage.setItem("tv-chart-v1", JSON.stringify(s)), crafted);
	await page.reload({ waitUntil: "domcontentloaded" });
	await page.waitForFunction(() => Boolean(globalThis.__hlTvWidget), null, { timeout: 25000 });
	await page.waitForTimeout(5000);

	const snap = await page.evaluate(() => {
		const out = {};
		try {
			const m = globalThis.__hlTvCal?.();
			out.cal = m ? { axisLeft: Math.round(m.axis.left), range: [Math.round(m.priceTop), Math.round(m.priceBottom)] } : null;
		} catch (e) {
			out.cal = String(e).slice(0, 120);
		}
		try {
			out.rightScales = globalThis.__hlTvWidget.activeChart().getPanes().map((p) => p.getRightPriceScales?.().length);
			out.leftScales = globalThis.__hlTvWidget.activeChart().getPanes().map((p) => p.getLeftPriceScales?.().length);
		} catch (e) {
			out.scales = String(e).slice(0, 140);
		}
		const frame = [...document.querySelectorAll("iframe")].find((f) => f.getBoundingClientRect().width > 300);
		if (frame) {
			const fr = frame.getBoundingClientRect();
			const el = frame.contentDocument?.querySelector(".price-axis");
			out.axisDom = el ? { xInFrame: Math.round(el.getBoundingClientRect().x - fr.left), frameW: Math.round(fr.width) } : { el: null };
		}
		return out;
	});
	console.log("LEFT-STATE AFTER RELOAD:", JSON.stringify(snap));

	// Feature smoke: axis cross (needs calibration).
	const m = await page.evaluate(() => {
		const t = globalThis.__hlTvCal?.();
		return t ? { x: t.axis.left + t.axis.width / 2, y: t.axis.top + t.axis.height / 3 } : null;
	});
	if (m) {
		await page.mouse.move(m.x, m.y, { steps: 5 });
		await page.waitForTimeout(500);
		console.log("SMOKE cross visible:", (await page.getByRole("button", { name: /^Set order price/ }).count()) > 0);
	} else {
		console.log("SMOKE: NO MEASUREMENT — all price-pixel features dead");
	}
	// Does the axis actually RENDER on the left now? Screenshot for the eyes.
	await page.screenshot({ path: "tv-left-state.png" });
	console.log("shot saved tv-left-state.png");
} catch (e) {
	console.log("PROBE ERR", String(e).slice(0, 300));
} finally {
	await browser.close();
}
