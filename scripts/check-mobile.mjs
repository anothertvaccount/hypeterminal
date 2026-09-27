/**
 * Mobile/touch parity checks (dev server must be running):
 *   node scripts/check-mobile.mjs
 *
 * iPhone-class viewport with hasTouch — quick size buttons, advanced order types
 * (Chase Limit + Post-Only TIF + Scale ladder), the touch price-axis menu, and
 * Chase Close on a position card.
 */
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
let fails = 0;
const check = (label, ok, detail = "") => {
	if (!ok) fails += 1;
	console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` (${detail})` : ""}`);
};
const step = (label, detail) => console.log(`--- ${label}${detail ? ` ${JSON.stringify(detail)}` : ""}`);

const browser = await chromium.launch({ headless: true, executablePath: findChromium() });
const context = await browser.newContext({
	viewport: { width: 390, height: 844 },
	isMobile: true,
	hasTouch: true,
	deviceScaleFactor: 3,
	userAgent:
		"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
});
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 160)));
try {
	const BASE = process.argv[2] ?? "http://localhost:3000";
	await page.goto(`${BASE}/`);
	await page.waitForSelector('[aria-label="Primary navigation"]', { timeout: 30000 });
	step("mobile shell mounted");
	// The trade form lives behind the bottom-nav "Trade" section.
	await page.locator('[aria-label="Primary navigation"]').getByText("Trade", { exact: true }).tap();
	await page.waitForTimeout(600);
	// --- wallet list on mobile (inspected while disconnected) ---
	{
		const connect = page.getByText("Connect Wallet", { exact: true });
		if ((await connect.count()) > 0) {
			await connect.first().tap();
			await page.waitForTimeout(600);
			const dialog = page.getByRole("dialog").last();
			const text = await dialog.innerText().catch(() => "");
			check(
				"mobile wallet list offers WalletConnect",
				text.includes("WalletConnect"),
				text.split(String.fromCharCode(10))[0],
			);
			check(
				"mobile wallet list hides non-working connectors (Injected / Coinbase)",
				!text.includes("Inject") && !text.includes("Coinbase"),
			);
			await page.keyboard.press("Escape").catch(() => undefined);
			await page.waitForTimeout(300);
		} else {
			console.log("SKIP: already connected, no wallet list to inspect");
		}
	}

	let walletless = false;
	if ((await page.getByText("Connect Wallet", { exact: true }).count()) > 0) {
		await page.getByText("Connect Wallet", { exact: true }).first().tap();
		await page.waitForTimeout(500);
		const mock = page.getByText("Mock Wallet (Testing)");
		if ((await mock.count()) > 0) {
			await mock.tap();
			await page.locator('button:has-text("Mock Wallet")').last().tap();
			await page.waitForTimeout(800);
		} else {
			// Production builds ship no mock connectors — walletless mode: run the
			// checks that don't require a session (types, sections, touch axis).
			walletless = true;
			await page.keyboard.press("Escape").catch(() => undefined);
			await page.waitForTimeout(300);
		}
	}
	check("mobile shell + wallet ready", (await page.locator('input[placeholder="0.00"]').count()) > 0);

	// --- TP/SL toggle seeds ±2% off the limit, exactly like the desktop form ---
	if (!(await page.evaluate(() => Boolean(globalThis.__hlOrderEntry)))) {
		console.log("SKIP: TP/SL seeding check needs the dev store hooks");
	} else {
		await page.getByRole("button", { name: "Order type" }).tap();
		await page.waitForTimeout(250);
		await page.getByText("Limit", { exact: true }).first().tap();
		await page.waitForTimeout(400);
		await page.evaluate(() => {
			globalThis.__hlOrderEntry.getState().actions.setLimitPrice("84000");
		});
		await page.waitForTimeout(400);
		await page.getByRole("checkbox", { name: /TP\/SL/i }).first().tap();
		await page.waitForTimeout(700);
		const tpsl = await page.evaluate(() => {
			const s = globalThis.__hlOrderEntry.getState();
			return {
				enabled: s.tpSlEnabled,
				tp: Number(s.tpPrice),
				sl: Number(s.slPrice),
				limit: Number(s.limitPrice),
				rows: /take profit|stop loss|TP|SL/i.test(document.body.innerText),
			};
		});
		check(
			"TP/SL toggle turns on the section",
			tpsl.enabled && tpsl.rows,
			JSON.stringify(tpsl),
		);
		check(
			"TP/SL defaults seed +/-2% off the limit",
			Math.abs(tpsl.tp - tpsl.limit * 1.02) < tpsl.limit * 0.001 &&
				Math.abs(tpsl.sl - tpsl.limit * 0.98) < tpsl.limit * 0.001,
			`tp=${tpsl.tp} sl=${tpsl.sl} limit=${tpsl.limit}`,
		);
		// Leave the form clean for the following checks.
		await page.getByRole("checkbox", { name: /TP\/SL/i }).first().tap();
		await page.waitForTimeout(300);
	}

	// --- typed prices reach the shared store (that is what draws the chart preview) ---
	if (!(await page.evaluate(() => Boolean(globalThis.__hlOrderEntry)))) {
		console.log("SKIP: form write-through check needs the dev store hooks");
	} else {
		await page.evaluate(() => {
			const a = globalThis.__hlOrderEntry.getState().actions;
			a.setOrderType("limit");
			a.setSide("buy");
		});
		await page.waitForTimeout(400);
		await page.locator('input[placeholder="0.00"]').nth(1).fill("84000");
		await page.waitForTimeout(500);
		const storedLimit = await page.evaluate(() => globalThis.__hlOrderEntry.getState().limitPrice);
		check("typing a limit price writes through to the store (chart preview source)", storedLimit === "84000", storedLimit);
	}

	// --- scale TP/SL validate against the ladder, not the hidden limit field ---
	if (!(await page.evaluate(() => Boolean(globalThis.__hlOrderEntry)))) {
		console.log("SKIP: scale TP/SL check needs the dev store hooks");
	} else {
		await page.evaluate(() => {
			const a = globalThis.__hlOrderEntry.getState().actions;
			a.setOrderType("scale");
			a.setSize("0.01");
			a.setScaleStart("83000");
			a.setScaleEnd("85000");
			a.setTpSlEnabled(true);
			a.setTpPrice("86000");
			a.setSlPrice("82000");
		});
		await page.waitForTimeout(900);
		const scaleErrors = await page.evaluate(() =>
			document.body.innerText
				.split(String.fromCharCode(10))
				.map((line) => line.trim())
				.filter((line) => line.startsWith("TP must be") || line.startsWith("SL must be")),
		);
		check(
			"scale TP above all rungs / SL below all rungs validates",
			scaleErrors.length === 0,
			JSON.stringify(scaleErrors),
		);
		// Leave a clean limit form behind.
		await page.evaluate(() => {
			const a = globalThis.__hlOrderEntry.getState().actions;
			a.setTpSlEnabled(false);
			a.setOrderType("limit");
		});
		await page.waitForTimeout(300);
	}

	// --- Nuke ("close everything") is reachable from the mobile account view ---
	if (walletless) {
		console.log("SKIP: nuke check needs a session (mock is dev-only)");
	} else {
		await page.locator('[aria-label="Primary navigation"]').getByText("Account", { exact: true }).tap();
		// Anchor on the button's stable aria-label (the labelled variant renders the
		// word twice, so the accessible name is not a reliable selector).
		const nuke = page.locator('button[aria-label="Nuke account"]');
		const nukeVisible = await nuke
			.first()
			.waitFor({ timeout: 45_000 })
			.then(() => true)
			.catch(() => false);
		check("mobile account view has the nuke action", nukeVisible);
		if ((await nuke.count()) > 0) {
			await nuke.first().tap();
			await page.waitForTimeout(400);
			const confirmVisible = await page.getByText("Are you sure?").count();
			check("nuke asks for confirmation on mobile", confirmVisible > 0);
			const no = page.getByRole("button", { name: /^No$/ });
			if ((await no.count()) > 0) await no.first().tap();
			await page.waitForTimeout(300);
		}
		await page.locator('[aria-label="Primary navigation"]').getByText("Trade", { exact: true }).tap();
		await page.waitForTimeout(600);
	}

	// --- quick size buttons ---
	const add50 = page.getByRole("button", { name: "Add 50 USD to size" });
	check("quick size buttons rendered", (await add50.count()) > 0);
	if ((await add50.count()) > 0 && walletless) {
		console.log("SKIP: size-fill needs a wallet session (mock is dev-only)");
	}
	if ((await add50.count()) > 0 && !walletless) {
		await add50.first().scrollIntoViewIfNeeded();
		await add50.first().tap();
		await page.waitForTimeout(300);
		const sizeVal = await page.locator('input[placeholder="0.00"]').first().inputValue();
		check("tapping $50 fills the size field", Number(sizeVal) > 0, `size=${sizeVal}`);
	}
	const clearSize = page.getByRole("button", { name: "Clear size" });
	check("CC clear button rendered", (await clearSize.count()) > 0);

	// --- order types: Chase Limit + Post-Only TIF ---
	await page.getByRole("button", { name: "Order type" }).tap();
	await page.waitForTimeout(300);
	check("order-type menu offers Chase Limit", (await page.getByText("Chase Limit", { exact: true }).count()) > 0);
	await page.getByText("Chase Limit", { exact: true }).tap();
	await page.waitForTimeout(400);
	const triggerText = await page.locator('button[aria-label="Order type"]').innerText();
	check("order type switched to Chase Limit", triggerText.includes("Chase Limit"), JSON.stringify(triggerText));
	check("TIF row shows Post Only for chase", (await page.getByText("Post Only", { exact: true }).count()) > 0);
	// A chase prices itself from the mark/book — it must not ask for a price, and
	// the submit must unlock with size alone (no manual limit price).
	const priceLabels = await page.getByText("Limit price", { exact: false }).count().catch(() => 0);
	check("chase limit shows no limit-price field", priceLabels === 0, `labels=${priceLabels}`);
	await page.waitForTimeout(300);
	const priceError = await page.getByText("Enter limit price").count().catch(() => 0);
	check("chase is not blocked by a price requirement", priceError === 0, `errors=${priceError}`);

	// --- scale ladder section ---
	await page.getByRole("button", { name: "Order type" }).tap();
	await page.waitForTimeout(300);
	await page.getByText("Scale", { exact: true }).tap();
	await page.waitForTimeout(400);
	const hint = await page.getByText(/Click the chart to set the (Start|End) Price/).count();
	check("scale ladder section + chart-pick hint", hint > 0);

	// --- touch price-axis menu (chart lives in the Chart section) ---
	await page.locator('[aria-label="Primary navigation"]').getByText("Chart", { exact: true }).tap();
	// TV is the default canvas now (mobile parity) — kline stays as fallback.
	await page.waitForFunction(
		() =>
			Boolean(globalThis.__hlTvWidget) ||
			Boolean(globalThis.__hlChart) ||
			[...document.querySelectorAll('iframe[src*="blob:"]')].some(
				(f) => f.getBoundingClientRect().width > 300,
			),
		null,
		{ timeout: 30000 },
	);
	await page.waitForTimeout(4500); // widget ready + calibration
	const axisBase = await page.evaluate(() => {
		// TV (default): calibration exposes the price-axis rect.
		try {
			const m = globalThis.__hlTvCal?.();
			if (m?.axis) {
				return { left: m.axis.left, top: m.axis.top, right: m.axis.right ?? m.axis.left + m.axis.width, via: "tv-cal" };
			}
		} catch {
			// fall through
		}
		const dev = globalThis.__hlContainer;
		if (dev) {
			const r = dev.getBoundingClientRect();
			return { left: r.left, top: r.top, right: r.right, via: "kline-dev" };
		}
		// Production without dev hooks: the TV blob iframe spans the chart; its
		// price axis hugs the right edge (~60px wide).
		const frame = [...document.querySelectorAll('iframe[src*="blob:"]')].find(
			(f) => f.getBoundingClientRect().width > 300,
		);
		if (!frame) return null;
		const r = frame.getBoundingClientRect();
		return { left: r.right - 60, top: r.top, right: r.right, via: "tv-iframe" };
	});
	if (!axisBase) throw new Error("no chart axis found");
	const cross = page.getByRole("button", { name: /^Set order price/ });
	for (let attempt = 0; attempt < 3 && (await cross.count()) === 0; attempt++) {
		await page.touchscreen.tap(axisBase.right - 25, axisBase.top + 220);
		await page.waitForTimeout(600);
	}
	check("tap on price axis shows the cross", (await cross.count()) > 0);
	if ((await cross.count()) > 0) {
		for (let attempt = 0; attempt < 4 && (await page.getByText("Limit Buy").count()) === 0; attempt++) {
			const box = await cross.first().boundingBox();
			if (!box) break;
			await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
			await page.waitForTimeout(700);
		}
		check("tapping the cross opens the axis menu", (await page.getByText("Limit Buy").count()) > 0);
		await page.keyboard.press("Escape").catch(() => {});
		await page.touchscreen.tap(axisBase.left + 80, axisBase.top + 40);
		await page.waitForTimeout(300);
	}

	// --- TV's native y-axis zoom via touch drag (desktop-parity feature) ---
	{
		// close the menu first
		await page.keyboard.press("Escape").catch(() => undefined);
		await page.touchscreen.tap(axisBase.left - 60, axisBase.top + 60);
		await page.waitForTimeout(400);
		const beforeRange = await page.evaluate(() => {
			const m = globalThis.__hlTvCal?.();
			return m ? { top: m.priceTop, bottom: m.priceBottom } : null;
		});
		if (beforeRange && axisBase) {
			const x = Math.round((axisBase.left + axisBase.right) / 2);
			const y = axisBase.top + 220;
			const cdp = await context.newCDPSession(page);
			await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
			for (let i = 1; i <= 12; i++) {
				await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - i * 12 }] });
				await page.waitForTimeout(16);
			}
			await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
			await page.waitForTimeout(900);
			const afterRange = await page.evaluate(() => {
				const m = globalThis.__hlTvCal?.();
				return m ? { top: m.priceTop, bottom: m.priceBottom } : null;
			});
			const spanBefore = Math.abs(beforeRange.top - beforeRange.bottom);
			const spanAfter = afterRange ? Math.abs(afterRange.top - afterRange.bottom) : -1;
			check(
				`TV y-axis touch drag zooms the scale (${Math.round(spanBefore)} -> ${Math.round(spanAfter)})`,
				afterRange !== null && Math.abs(spanAfter - spanBefore) > 2,
			);
		} else {
			console.log("SKIP: axis drag check needs dev calibration (TV native drag verified on desktop suite)");
		}
	}

	// --- order line UX: the label fits the plot and its ✕ works by touch ---
	if (!(await page.evaluate(() => Boolean(globalThis.__hlPaper)))) {
		console.log("SKIP: order-line checks need the dev paper store");
	} else {
		await page.locator('[aria-label="Primary navigation"]').getByText("Chart", { exact: true }).tap();
		await page.waitForTimeout(1500);
		await page.evaluate(() => {
			const st = globalThis.__hlPaper;
			st.setState({ actions: { ...st.getState().actions, fillCrossedOrders: () => [] } });
			const m = globalThis.__hlTvCal?.();
			st.setState({
				openOrders: [
					{
						oid: 555999,
						assetId: 0,
						coin: "BTC",
						dex: "",
						isBuy: true,
						size: 0.02,
						limitPx: m.priceBottom + (m.priceTop - m.priceBottom) * 0.5,
						reduceOnly: false,
						tif: "Gtc",
						placedAt: Date.now(),
						leverage: 10,
						marginMode: "cross",
					},
				],
			});
		});
		const cancelCell = page.locator("[data-box-key=cancel]").first();
		await cancelCell.waitFor({ timeout: 15_000 }).catch(() => undefined);
		const geometry = await page.evaluate(() => {
			const box = document.querySelector("[data-tv-strip-box]")?.getBoundingClientRect();
			const cell = document.querySelector("[data-box-key=cancel]")?.getBoundingClientRect();
			return box && cell
				? { inside: cell.right <= box.right + 1 && cell.left >= box.left - 1, boxW: Math.round(box.width) }
				: null;
		});
		check("order label fits inside the plot width (phone)", geometry?.inside === true, JSON.stringify(geometry));
		if (geometry?.inside) {
			const box = await cancelCell.boundingBox();
			if (box) {
				await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
				await page.waitForTimeout(700);
				const gone = await page.evaluate(() => globalThis.__hlPaper.getState().openOrders.length === 0);
				check("tapping the ✕ cancels the order by touch", gone);
			}
		}
		await page.evaluate(() => globalThis.__hlPaper.setState({ openOrders: [] }));
		await page.locator('[aria-label="Primary navigation"]').getByText("Trade", { exact: true }).tap();
		await page.waitForTimeout(600);
	}

	// --- edge-follow: a touch drag must continue past the chart's bottom edge ---
	{
		// Drop the form's own preview line first so the only grab band on the
		// canvas belongs to the order we seed below.
		await page.locator('[aria-label="Primary navigation"]').getByText("Trade", { exact: true }).tap();
		await page.waitForTimeout(500);
		await page.getByRole("button", { name: "Order type" }).tap();
		await page.waitForTimeout(250);
		await page.getByText("Market", { exact: true }).first().tap();
		await page.waitForTimeout(500);
		await page.locator('[aria-label="Primary navigation"]').getByText("Chart", { exact: true }).tap();
		await page.waitForTimeout(1200);
		const seeded = await page.evaluate(() => {
			if (!globalThis.__hlPaper) return false; // prod build: no dev hooks
			const m = globalThis.__hlTvCal?.();
			if (!m) return false;
			const span = m.priceTop - m.priceBottom;
			globalThis.__hlPaper.setState({
				openOrders: [
					{
						oid: 901234,
						assetId: 0,
						coin: "BTC",
						dex: "",
						isBuy: true,
						size: 0.01,
						limitPx: m.priceTop - span * 0.5,
						reduceOnly: false,
						tif: "Gtc",
						placedAt: Date.now(),
						leverage: 10,
						marginMode: "cross",
					},
				],
			});
			const midPrice = m.priceTop - span * 0.5;
			return {
				top: m.priceTop,
				bottom: m.priceBottom,
				plotBottom: m.plot.top + m.plot.height,
				// y where the seeded order line sits — lets the test pick THIS row's
				// grab band rather than the form preview's.
				expectY: m.plot.top + ((m.priceTop - midPrice) / span) * m.plot.height,
			};
		});
		if (!seeded) {
			console.log("SKIP: edge-follow needs the dev paper store");
		} else {
			const band = await page
				.waitForFunction(
					(expectY) => {
						const bands = [...document.querySelectorAll("div")]
							.filter((d) => String(d.className).includes("cursor-grab"))
							.map((d) => d.getBoundingClientRect())
							.filter((r) => r.width > 0)
							.map((r) => ({ x: Math.round(r.left + 60), y: Math.round(r.top + r.height / 2), d: Math.abs(r.top + r.height / 2 - expectY) }));
						if (bands.length === 0) return null;
						bands.sort((a, b) => a.d - b.d);
						return { x: bands[0].x, y: bands[0].y };
					},
					seeded.expectY,
					{ timeout: 15000 },
				)
				.then((h) => h.jsonValue())
				.catch(() => null);
			if (!band) {
				check("draggable order row is grabbable on touch", false, "no grab band");
			} else {
				const cdp = await context.newCDPSession(page);
				const endY = Math.min(842, seeded.plotBottom + 150);
				await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: band.x, y: band.y }] });
				for (let i = 1; i <= 20; i++) {
					await cdp.send("Input.dispatchTouchEvent", {
						type: "touchMove",
						touchPoints: [{ x: band.x, y: Math.round(band.y + ((endY - band.y) * i) / 20) }],
					});
					await page.waitForTimeout(20);
				}
				await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
				await page.waitForTimeout(500);
				const dragged = await page.evaluate(() =>
					globalThis.__hlPaper.getState().openOrders.map((o) => Math.round(o.limitPx)),
				);
				check(
					"dragging a line past the chart bottom keeps following the finger (edge-follow)",
					dragged.length > 0 && dragged[0] < seeded.bottom - 100,
					`${dragged[0]} vs chart bottom ${Math.round(seeded.bottom)}`,
				);
			}
			await page.evaluate(() => globalThis.__hlPaper.setState({ openOrders: [] }));
		}
	}

	// --- Chase Close on a position card (needs a session + a paper/live position) ---
	if (walletless) {
		console.log("SKIP: chase-close section needs a wallet session (mock is dev-only)");
	} else {
		await page.evaluate(() => {
			globalThis.__hlPaper.setState({
				positions: [
					{ assetId: 0, coin: "BTC", dex: "", szi: 0.02, entryPx: 85000, leverage: 10, marginMode: "cross" },
				],
			});
		});
		await page.waitForTimeout(1500); // marks subscription needs a beat (the card needs a mark)
		const nav = page.locator('[aria-label="Primary navigation"]');
		const posNav = nav.getByText("Positions", { exact: true });
		if ((await posNav.count()) > 0) {
			await posNav.first().tap();
			await page.waitForTimeout(600);
		}
		const chaseCloseBtn = page.getByRole("button", { name: "Chase Close" });
		if ((await chaseCloseBtn.count()) === 0) {
			// fallback: the positions tab may already be in view
			const tab = page.getByRole("tab", { name: "Positions" });
			if ((await tab.count()) > 0) await tab.first().tap();
			await page.waitForTimeout(500);
		}
		check("position card offers Chase Close", (await page.getByRole("button", { name: "Chase Close" }).count()) > 0);
		// The mids subscription starts with the section — wait for the mark (button enables).
		await page
			.waitForFunction(
				() => {
					const b = [...document.querySelectorAll("button")].find((x) => x.textContent?.includes("Chase Close"));
					return Boolean(b && !b.disabled);
				},
				null,
				{ timeout: 10000 },
			)
			.catch(() => undefined);
		if (walletless) {
			console.log("SKIP: chase-close placement needs a wallet session (mock is dev-only)");
		} else if ((await page.getByRole("button", { name: "Chase Close" }).count()) > 0) {
			await page.getByRole("button", { name: "Chase Close" }).first().scrollIntoViewIfNeeded();
			await page.getByRole("button", { name: "Chase Close" }).first().tap();
			await page.waitForTimeout(900);
			const leg = await page.evaluate(() =>
				globalThis.__hlPaper.getState().openOrders.filter((o) => !o.isTrigger && o.reduceOnly),
			);
			const lastRow = await page.evaluate(() => {
				const q = globalThis.__hlQueue?.getState().orders ?? [];
				return q[q.length - 1] ?? null;
			});
			const legOk = leg.length === 1 && Number(leg[0].size) === 0.02 && leg[0].tif === "Alo";
			if (!legOk) {
				const diag = await page.evaluate(() => ({
					orderType: globalThis.__hlOrderEntry?.getState().orderType,
					reduceOnly: globalThis.__hlOrderEntry?.getState().reduceOnly,
					size: globalThis.__hlOrderEntry?.getState().size,
					forms: document.querySelectorAll("form[data-order-form]").length,
					toasts: (document.body.innerText.match(/Chase close started|minimum order size/g) ?? []).slice(0, 2),
					submitCall: globalThis.__hlMobileSubmit ?? null,
					sizeField: document.querySelector('input[placeholder="0.00"]')?.value ?? null,
					mid: (() => {
						const b = [...document.querySelectorAll("button")].find((x) => x.textContent?.includes("Chase Close"));
						return b ? (b.disabled ? "disabled" : "enabled") : "missing";
					})(),
				}));
				console.log("   diag:", JSON.stringify({ ...diag, queue: lastRow }));
			}
			check(
				"mobile Chase Close rests a post-only reduce order",
				legOk,
				JSON.stringify(leg.map((o) => `${o.size}@${o.limitPx}:${o.tif}`)),
			);
		}
	}
	check("no page errors during mobile flow", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
} catch (e) {
	fails += 1;
	console.log("FAIL(critical):", String(e).slice(0, 300));
} finally {
	await browser.close();
}
console.log(fails === 0 ? "MOBILE CHECK PASS" : `${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
