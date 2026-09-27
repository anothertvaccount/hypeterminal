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
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));

const snapshot = async (label) => {
	const s = await page.evaluate(() => {
		const out = {};
		try {
			const m = globalThis.__hlTvCal?.();
			out.cal = m
				? { axisLeft: Math.round(m.axis.left), axisW: Math.round(m.axis.width), range: [Math.round(m.priceTop), Math.round(m.priceBottom)] }
				: null;
		} catch (e) {
			out.cal = String(e).slice(0, 120);
		}
		try {
			const panes = globalThis.__hlTvWidget.activeChart().getPanes();
			out.rightScales = panes.map((p) => (p.getRightPriceScales ? p.getRightPriceScales().length : "n/a"));
		} catch (e) {
			out.rightScales = String(e).slice(0, 140);
		}
		try {
			const frame = [...document.querySelectorAll("iframe")].find((f) => f.getBoundingClientRect().width > 300);
			if (!frame) out.axisDom = "no frame";
			else {
				const fr = frame.getBoundingClientRect();
				const doc = frame.contentDocument;
				const el = doc?.querySelector(".price-axis") ?? doc?.querySelector('[class*="price-axis"]');
				out.axisDom = el
					? { xInFrame: Math.round(el.getBoundingClientRect().x - fr.left), w: Math.round(el.getBoundingClientRect().width), frameW: Math.round(fr.width) }
					: { el: null, frameW: Math.round(fr.width) };
			}
		} catch (e) {
			out.axisDom = String(e).slice(0, 140);
		}
		out.errors = 0;
		return out;
	});
	console.log(label, JSON.stringify(s));
	return s;
};

const axisHoverSmoke = async (label) => {
	const m = await page.evaluate(() => {
		const t = globalThis.__hlTvCal?.();
		return t ? { x: t.axis.left + t.axis.width / 2, y: t.axis.top + t.axis.height / 3 } : null;
	});
	if (!m) {
		console.log(label, "SMOKE: no measurement");
		return false;
	}
	await page.mouse.move(m.x, m.y, { steps: 5 });
	await page.waitForTimeout(500);
	const cross = await page.getByRole("button", { name: /^Set order price/ }).count();
	console.log(label, `SMOKE: axis cross visible = ${cross > 0}`);
	return cross > 0;
};

try {
	await page.goto("http://localhost:3000/");
	await page.waitForFunction(() => Boolean(globalThis.__hlTvWidget), null, { timeout: 25000 });
	await page.waitForTimeout(4000); // chart ready + first paints
	await snapshot("FRESH   ");
	await axisHoverSmoke("FRESH   ");

	// Capture what widget.save() produces and scan it for axis/scale/position fields.
	const state = await page.evaluate(
		() =>
			new Promise((res) => {
				try {
					globalThis.__hlTvWidget.save((s) => res(s));
				} catch (e) {
					res({ __err: String(e) });
				}
			}),
	);
	console.log("STATE top keys:", Object.keys(state ?? {}).join(","));
	const hits = [];
	const scan = (obj, p, depth) => {
		if (depth > 6 || hits.length > 60 || !obj || typeof obj !== "object") return;
		for (const [k, v] of Object.entries(obj)) {
			if (/price|axis|scale|position|side|left|right|pane/i.test(k)) {
				hits.push(`${p}.${k} = ${JSON.stringify(v)?.slice(0, 90)}`);
			}
			if (v && typeof v === "object") scan(v, `${p}.${k}`, depth + 1);
		}
	};
	scan(state, "$", 0);
	console.log("STATE scan hits:\n" + hits.join("\n"));

	// Persist exactly like the app does, then reload with it.
	await page.evaluate((s) => localStorage.setItem("tv-chart-v1", JSON.stringify(s)), state);
	await page.reload({ waitUntil: "domcontentloaded" });
	await page.waitForFunction(() => Boolean(globalThis.__hlTvWidget), null, { timeout: 25000 });
	await page.waitForTimeout(5000); // load() applied
	await snapshot("RELOAD  ");
	await axisHoverSmoke("RELOAD  ");

	// Native drag-to-scale after reload (the feature the user says is dead).
	const drag = await page.evaluate(() => {
		const t = globalThis.__hlTvCal?.();
		return t ? { x: t.axis.left + t.axis.width / 2, y: t.axis.top + t.axis.height * 0.6, before: [t.priceTop, t.priceBottom] } : null;
	});
	if (drag) {
		await page.mouse.move(drag.x, drag.y, { steps: 4 });
		await page.mouse.down();
		await page.mouse.move(drag.x, drag.y - 140, { steps: 12 });
		await page.mouse.up();
		await page.waitForTimeout(900);
		const after = await page.evaluate(() => {
			const t = globalThis.__hlTvCal?.();
			return t ? [t.priceTop, t.priceBottom] : null;
		});
		const changed = after && (Math.abs(after[0] - drag.before[0]) > 1 || Math.abs(after[1] - drag.before[1]) > 1);
		console.log("RELOAD   drag-to-scale changed:", JSON.stringify({ before: drag.before, after, changed }));
	} else {
		console.log("RELOAD   drag: no measurement at all");
	}
	console.log("errors:", JSON.stringify(errors.slice(0, 5)));
} catch (e) {
	console.log("PROBE ERR", String(e).slice(0, 300), JSON.stringify(errors.slice(-4)));
} finally {
	await browser.close();
}
