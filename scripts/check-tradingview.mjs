import { readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * TradingView canvas parity suite: every trading feature added to the default
 * canvas must behave identically on the TradingView widget —
 *  form draft previews (limit / TP / SL / scale ladder) with drag → field,
 *  resting order labels + ✕ cancel + drag-to-reprice,
 *  position line with press-drag TP/SL buttons + ghost chip,
 *  the price-axis cross + menu, and hold-key + click chart actions.
 * All prices come from the calibration fit, so the drag assertions double as
 * fit/orientation verification.
 */

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

const failures = [];
function check(condition, label) {
	if (condition) console.log(`PASS: ${label}`);
	else {
		failures.push(label);
		console.log(`FAIL: ${label}`);
	}
}
function step(label, data) {
	console.log(`---- ${label}: ${JSON.stringify(data)}`);
}

const browser = await chromium.launch({ headless: true, executablePath: findChromium() });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const logs = [];
page.on("console", (m) => {
	if (m.type() === "error" || m.type() === "warning") logs.push(`[${m.type()}] ${m.text()}`);
});
page.on("pageerror", (e) => logs.push(`[pageerror] ${e}`));

try {
	await page.goto("http://localhost:3000/", { waitUntil: "domcontentloaded" });
	await page.waitForFunction(() => Boolean(globalThis.__hlOrderEntry), null, { timeout: 30000 });
	await page.waitForTimeout(3000);

	// The order form needs an account (preview balance) before submits are enabled.
	if ((await page.getByText("Connect Wallet", { exact: true }).count()) > 0) {
		await page.getByText("Connect Wallet", { exact: true }).first().click();
		await page.getByText("Mock Wallet (Testing)").click();
		await page.locator('button:has-text("Mock Wallet")').last().click();
		await page
			.waitForFunction(() => !document.body.innerText.includes("Mock Wallet (Testing)"), { timeout: 10_000 })
			.catch(() => undefined);
	}
	await page.waitForTimeout(800);

	// --- Switch to the TradingView canvas ---
	const klineToggleAtBoot = page.getByRole("button", { name: "TradingView", exact: true });
	if ((await klineToggleAtBoot.count()) > 0) await klineToggleAtBoot.first().click(); // leave the kline backup
	// (TradingView is the default chart — nothing to click when it already is)
	await page.waitForFunction(() => Boolean(globalThis.__hlTvWidget), null, { timeout: 30000 });
	await page.waitForFunction(() => globalThis.__hlTvCal?.() != null, null, { timeout: 30000 });
	step("calibration", await page.evaluate(() => globalThis.__hlTvCal?.() ?? null));
	check(true, "TV widget loads with a price fit (pointer-free calibration)");

	// Nudge the crosshair (bridge events) over the plot.
	await page.mouse.move(400, 400, { steps: 4 });
	await page.waitForTimeout(300);

	// --- 1) Form draft previews: limit + TP/SL ---
	await page.evaluate(() => {
		const a = globalThis.__hlOrderEntry.getState().actions;
		a.setOrderType("limit");
		a.setSide("buy");
		a.setSize("0.001");
		a.setLimitPrice("84000");
		a.setTpSlEnabled(true, { base: 84000, priceDecimals: 1 });
	});
	await page.waitForTimeout(700);
	const draftKinds = await page.evaluate(() =>
		[...document.querySelectorAll("[data-tv-line]")].map((el) => el.getAttribute("data-kind")),
	);
	step("draft rows", draftKinds);
	check(draftKinds.includes("draft:limit"), "limit preview line renders on the TV canvas");
	check(draftKinds.includes("draft:tp") && draftKinds.includes("draft:sl"), "TP/SL preview lines render");
	const previewNumbers = await page.evaluate(() => ({
		tp: document.querySelector('[data-kind="draft:tp"] [data-tv-strip]')?.textContent ?? "",
		sl: document.querySelector('[data-kind="draft:sl"] [data-tv-strip]')?.textContent ?? "",
		limit: document.querySelector('[data-kind="draft:limit"] [data-tv-strip]')?.textContent ?? "",
	}));
	check(
		/\+\d+(\.\d+)? USD/.test(previewNumbers.tp),
		`TP preview shows size-aware realized PnL (${previewNumbers.tp})`,
	);
	check(/-\d+(\.\d+)? USD/.test(previewNumbers.sl), `SL preview shows the loss if hit (${previewNumbers.sl})`);
	check(/USD/.test(previewNumbers.limit), `limit preview shows the order notional (${previewNumbers.limit})`);

	// Strip anchor: centered within the plot's LEFT half (default-canvas parity).
	const anchor = await page.evaluate(() => {
		const m = globalThis.__hlTvCal?.();
		return m ? { left: m.plot.left, right: m.plot.right } : null;
	});
	const stripBox = await page.locator('[data-kind="draft:limit"] [data-tv-strip]').boundingBox();
	if (anchor && stripBox) {
		const stripCenter = stripBox.x + stripBox.width / 2;
		const plotCenter = (anchor.left + anchor.right) / 2;
		const leftHalfCenter = anchor.left + (anchor.right - anchor.left) / 4;
		check(
			Math.abs(stripCenter - leftHalfCenter) < 40,
			`strip sits centered in the plot's left half (center ${Math.round(stripCenter)}, target ${Math.round(leftHalfCenter)})`,
		);
		check(stripCenter < plotCenter, `strip stays left of center (${Math.round(stripCenter)} < ${Math.round(plotCenter)})`);
	} else {
		check(false, "strip anchor measurable");
		check(false, "strip stays left of center");
	}

	// Page scroll: rows must stay glued to their price line (viewport-space fit +
	// host rect both read per frame). Guarded — skips when the page isn't scrollable.
	const scrollBefore = await page.evaluate(() => {
		const y = window.scrollY;
		window.scrollBy(0, 240);
		return y;
	});
	await page.waitForTimeout(500); // smooth-scroll settle (scrollY is async under scroll-behavior)
	const scrollAfter = await page.evaluate(() => window.scrollY);
	if (scrollAfter !== scrollBefore) {
		const glued = await page.evaluate(() => {
			const m = globalThis.__hlTvCal?.();
			const el = document.querySelector('[data-kind="draft:limit"] [data-tv-strip]');
			if (!m || !el) return null;
			const r = el.getBoundingClientRect();
			const t = (m.priceTop - 84000) / (m.priceTop - m.priceBottom);
			const expected = m.plot.top + t * (m.plot.bottom - m.plot.top);
			return { center: r.y + r.height / 2, expected };
		});
		check(
			glued != null && Math.abs(glued.center - glued.expected) < 8,
			`rows stay glued to their price during page scroll (center ${glued ? Math.round(glued.center) : "?"}, expected ${glued ? Math.round(glued.expected) : "?"})`,
		);
		// Restore the original scroll position: the remaining checks assume the
		// geometry measured before the scroll probe.
		await page.evaluate((y) => window.scrollTo({ top: y, behavior: "instant" }), scrollBefore);
		await page.waitForTimeout(300);
		const restored = await page.evaluate(() => window.scrollY);
		check(restored === scrollBefore, `scroll position restored for the remaining checks (${restored})`);
	} else {
		console.log("note: page not scrollable in this viewport — scroll glue check skipped");
	}
	// --- 2) Drag the limit draft → the form field follows (fit orientation check) ---
	const limitBox = await page
		.locator('[data-kind="draft:limit"] [data-box-key="preview"]')
		.first()
		.boundingBox()
		.catch(() => null);
	const limitCell = limitBox ?? (await page.locator('[data-kind="draft:limit"]').first().boundingBox());
	check(Boolean(limitCell), "limit preview strip is grabbable");
	if (limitCell) {
		const startX = limitCell.x + limitCell.width / 2;
		const startY = limitCell.y + limitCell.height / 2;
		await page.mouse.move(startX, startY);
		await page.mouse.down();
		await page.mouse.move(startX, startY + 80, { steps: 10 });
		await page.waitForTimeout(250);
		await page.mouse.up();
		await page.waitForTimeout(500);
		const afterDrag = await page.evaluate(() => Number(globalThis.__hlOrderEntry.getState().limitPrice));
		check(
			Number.isFinite(afterDrag) && afterDrag > 0 && afterDrag < 84000,
			`dragging the limit preview down lowers the limit field (${afterDrag})`,
		);
	}

	// --- 3) Scale ladder via the Preview button ---
	await page.evaluate(() => {
		const a = globalThis.__hlOrderEntry.getState().actions;
		a.setTpSlEnabled(false);
		a.setOrderType("scale");
		a.setScaleStart("83000");
		a.setScaleEnd("85000");
		a.setScaleLevels(4);
		a.setScalePreview(true);
	});
	await page.waitForTimeout(700);
	const ladder = await page.evaluate(() => {
		const rows = [...document.querySelectorAll('[data-tv-line][data-kind^="draft:scale"]')];
		return { total: rows.length, visible: rows.filter((el) => getComputedStyle(el).visibility !== "hidden").length };
	});
	check(
		ladder.total === 4 && ladder.visible === 4,
		`scale ladder previews render on TV (${ladder.visible}/${ladder.total} visible)`,
	);
	const rungText = await page.evaluate(
		() => document.querySelector('[data-tv-line][data-kind="draft:scaleMid"] [data-tv-strip]')?.textContent ?? "",
	);
	check(/0\.00025/.test(rungText), `scale rung preview shows the size of ONE order (${rungText})`);
	await page.evaluate(() => globalThis.__hlOrderEntry.getState().actions.setScalePreview(false));

	// --- 4) Resting order: label row + ✕ cancel + drag-to-reprice ---
	// Inject well BELOW the mark (30% up the visible range): a crossing limit would
	// fill instantly and the row would vanish mid-check.
	const injectedPrice = await page.evaluate(() => {
		const m = globalThis.__hlTvCal?.();
		const price = m
			? Math.round((m.priceBottom + (m.priceTop - m.priceBottom) * 0.3) * 10) / 10
			: 78000;
		globalThis.__hlInjectedOrderPrice = price;
		globalThis.__hlPaper.setState({
			openOrders: [
				{
					oid: 999999101,
					assetId: 0,
					coin: "BTC",
					dex: "",
					isBuy: true,
					size: 1,
					limitPx: price,
					reduceOnly: false,
					leverage: 10,
					marginMode: "cross",
					tif: "Gtc",
					placedAt: Date.now(),
				},
			],
		});
		return price;
	});
	await page
		.waitForFunction(() => document.querySelector('[data-tv-line="order-999999101"]') != null, null, { timeout: 5000 })
		.catch(() => undefined);
	const orderRow = page.locator('[data-tv-line="order-999999101"]');
	check((await orderRow.count()) > 0, `resting order line renders with its label (${injectedPrice})`);

	// Drag-to-reprice (order row, on the line body right of the strip).
	const orderBox = await orderRow.boundingBox();
	if (orderBox) {
		const bodyX = orderBox.x + orderBox.width - 160;
		const bodyY = orderBox.y;
		await page.mouse.move(bodyX, bodyY);
		await page.mouse.down();
		await page.mouse.move(bodyX, bodyY + 60, { steps: 8 });
		await page.waitForTimeout(250);
		await page.mouse.up();
		await page.waitForTimeout(600);
		const repriced = await page.evaluate(
			() => globalThis.__hlPaper.getState().openOrders.find((o) => o.oid === 999999101)?.limitPx,
		);
		check(
			repriced !== undefined && repriced !== injectedPrice,
			`order drag reprices on TV (${injectedPrice} -> ${repriced})`,
		);
	} else {
		check(false, "order line box measurable");
	}

	// ✕ cancel.
	const cancelBox = await page
		.locator('[data-tv-line="order-999999101"] [data-box-key="cancel"]')
		.boundingBox()
		.catch(() => null);
	check(Boolean(cancelBox), "order ✕ box renders");
	if (cancelBox) {
		await page.mouse.click(cancelBox.x + cancelBox.width / 2, cancelBox.y + cancelBox.height / 2);
		await page.waitForTimeout(600);
		const remaining = await page.evaluate(
			() => globalThis.__hlPaper.getState().openOrders.filter((o) => o.oid === 999999101).length,
		);
		check(remaining === 0, "✕ click cancels the order from the TV canvas");
	}

	// --- 5) Position line: TP press-drag places a trigger (ghost visible mid-drag) ---
	await page.evaluate(() => {
		globalThis.__hlPaper.setState({
			positions: [{ assetId: 0, coin: "BTC", dex: "", szi: 0.02, entryPx: 85000, leverage: 10, marginMode: "cross" }],
		});
	});
	await page.waitForTimeout(600);
	check((await page.locator('[data-tv-line="position"]').count()) > 0, "position line renders on TV");
	const tpBox = await page.locator('[data-tv-line="position"] [data-box-key="tp"]').boundingBox();
	check(Boolean(tpBox), "position TP button renders");
	if (tpBox) {
		const tx = tpBox.x + tpBox.width / 2;
		const ty = tpBox.y + tpBox.height / 2;
		await page.mouse.move(tx, ty);
		await page.mouse.down();
		await page.mouse.move(tx, ty - 90, { steps: 10 });
		await page.waitForTimeout(250);
		const ghostVisible = await page.evaluate(() => {
			const el = document.querySelector("[data-tv-ghost]");
			return el != null && getComputedStyle(el).visibility !== "hidden";
		});
		check(ghostVisible, "ghost chip follows the pointer during the TP drag");
		await page.mouse.up();
		await page.waitForTimeout(700);
		const trigger = await page.evaluate(() =>
			globalThis.__hlPaper.getState().openOrders.filter((o) => o.isTrigger && o.tpsl === "tp" && o.triggerPx > 85000),
		);
		check(trigger.length >= 1, `TP press-drag places the trigger (${JSON.stringify(trigger.map((t) => t.triggerPx))})`);
	}


	// --- 5b) SL drag on the long ---
	const slBox = await page.locator('[data-tv-line="position"] [data-box-key="sl"]').boundingBox();
	check(Boolean(slBox), "position SL button renders");
	if (slBox) {
		const sx = slBox.x + slBox.width / 2;
		const sy = slBox.y + slBox.height / 2;
		await page.mouse.move(sx, sy);
		await page.mouse.down();
		await page.mouse.move(sx, sy + 110, { steps: 10 });
		await page.waitForTimeout(250);
		await page.mouse.up();
		await page.waitForTimeout(700);
		const slTrigger = await page.evaluate(() =>
			globalThis.__hlPaper.getState().openOrders.filter((o) => o.isTrigger && o.tpsl === "sl"),
		);
		check(slTrigger.length === 1, `SL press-drag places a stop trigger (${slTrigger.length})`);
		check(
			slTrigger.length === 1 && slTrigger[0].triggerPx < 85000,
			`SL trigger sits below the entry for a long (${slTrigger[0]?.triggerPx})`,
		);
	}

	// --- 5c) Short position: TP drag must place a buy-side TP below the entry ---
	await page.evaluate(() => {
		const s = globalThis.__hlPaper;
		const pos = s.getState().positions[0];
		if (pos) s.setState({ positions: [{ ...pos, szi: -Math.abs(pos.szi) }] });
	});
	await page.waitForTimeout(700);
	const shortTpBox = await page.locator('[data-tv-line="position"] [data-box-key="tp"]').boundingBox();
	check(Boolean(shortTpBox), "tp button renders on the short position");
	if (shortTpBox) {
		const tx2 = shortTpBox.x + shortTpBox.width / 2;
		const ty2 = shortTpBox.y + shortTpBox.height / 2;
		await page.mouse.move(tx2, ty2);
		await page.mouse.down();
		await page.mouse.move(tx2, ty2 + 110, { steps: 10 });
		await page.waitForTimeout(250);
		await page.mouse.up();
		await page.waitForTimeout(700);
		const shortTp = await page.evaluate(() =>
			globalThis.__hlPaper.getState().openOrders.filter((o) => o.isTrigger && o.tpsl === "tp" && o.isBuy),
		);
		check(shortTp.length >= 1, `short TP press-drag places a buy-side trigger (${shortTp.length})`);
		check(
			shortTp.length >= 1 && shortTp[0].triggerPx < 85000,
			`short TP trigger sits below the entry (${shortTp[0]?.triggerPx})`,
		);
	}
	// Restore the long (position line section ends here).
	await page.evaluate(() => {
		const s = globalThis.__hlPaper;
		const pos = s.getState().positions[0];
		if (pos) s.setState({ positions: [{ ...pos, szi: Math.abs(pos.szi) }] });
	});
	await page.waitForTimeout(500);

	// --- 6) Price axis: cross + menu (bridged from the iframe) AND native drag-to-scale ---
	const axis = await page.evaluate(() => {
		const m = globalThis.__hlTvCal?.();
		return m
			? { left: m.axis.left, top: m.axis.top, width: m.axis.width, height: m.axis.height, range: { top: m.priceTop, bottom: m.priceBottom } }
			: null;
	});
	step("axis", axis);
	check(Boolean(axis), "calibration exposes the TV price axis rect");
	if (axis) {
		await page.mouse.move(axis.left + axis.width / 2, axis.top + axis.height / 3, { steps: 5 });
		await page.waitForTimeout(500);
		const cross = page.getByRole("button", { name: /^Set order price/ });
		check((await cross.count()) > 0, "hovering the TV price axis shows the cross");
		if ((await cross.count()) > 0) {
			await cross.first().click();
			await page.waitForTimeout(300);
			const menuPick = page.getByRole("button", { name: /Limit Buy/ });
			check((await menuPick.count()) > 0, "axis menu opens with Limit Buy/Sell");
			if ((await menuPick.count()) > 0) {
				await menuPick.first().click();
				await page.waitForTimeout(300);
				const picked = await page.evaluate(() => Number(globalThis.__hlOrderEntry.getState().limitPrice));
				check(Number.isFinite(picked) && picked > 0, `axis menu prefill writes the limit price (${picked})`);
			}
		}

		// Native axis interaction: a vertical drag on the axis must change the visible
		// price range — this is the regression guard for "anything covering the axis
		// swallows TV's own drag-to-scale".
		const dragX = axis.left + axis.width / 2;
		const dragY = axis.top + axis.height * 0.6;
		const dragHit = await page.evaluate(
			([x, y]) => {
				const top = document.elementFromPoint(x, y);
				const frame = [...document.querySelectorAll("iframe")].find((f) => f.getBoundingClientRect().width > 300);
				const fr = frame?.getBoundingClientRect();
				const inner = frame && fr ? frame.contentDocument?.elementFromPoint(x - fr.left, y - fr.top) : null;
				return {
					top: top ? `${top.tagName}.${String(top.className).slice(0, 50)}` : null,
					inner: inner ? `${inner.tagName}.${String(inner.className).slice(0, 50)}` : null,
				};
			},
			[dragX, dragY],
		);
		step("axis drag hit", dragHit);
		await page.mouse.move(dragX, dragY, { steps: 4 });
		await page.mouse.down();
		await page.mouse.move(dragX, dragY - 120, { steps: 12 });
		await page.waitForTimeout(300);
		await page.mouse.move(dragX, dragY - 170, { steps: 5 });
		await page.mouse.up();
		await page.waitForTimeout(900); // 400ms calibration poll + margin
		const after = await page.evaluate(() => {
			const m = globalThis.__hlTvCal?.();
			return m ? { top: m.priceTop, bottom: m.priceBottom } : null;
		});
		const changed = Boolean(
			after &&
				(Math.abs(after.top - axis.range.top) > 1 || Math.abs(after.bottom - axis.range.bottom) > 1),
		);
		step("axis drag range", { before: axis.range, after });
		check(changed, "price-axis drag-to-scale works (TV native)");
	}

	// --- 7) Hold-key + click (capture layer only while held) ---
	const queueBefore = await page.evaluate(() => (globalThis.__hlQueue?.getState().orders ?? []).length);
	await page.keyboard.down("a");
	await page.waitForTimeout(250);
	const holdVisible = await page.evaluate(() => {
		const el = document.querySelector("[data-tv-hold]");
		return el != null && getComputedStyle(el).display !== "none";
	});
	check(holdVisible, "hold A arms the TV chart click layer");
	if (holdVisible) {
		// Click the plot's centre from the live fit — fixed coordinates break the
		// moment anything shifts the layout.
		const holdPoint = await page.evaluate(() => {
			const m = globalThis.__hlTvCal?.();
			if (!m) return null;
			return { x: (m.plot.left + m.plot.right) / 2, y: (m.plot.top + m.plot.bottom) / 2 };
		});
		if (holdPoint) await page.mouse.click(holdPoint.x, holdPoint.y);
		await page.waitForTimeout(400);
	}
	await page.keyboard.up("a");
	await page.waitForTimeout(500);
	const holdGone = await page.evaluate(() => document.querySelector("[data-tv-hold]") === null);
	check(holdGone, "releasing the key removes the capture layer (TV interaction untouched)");
	// The clicked limit may rest OR fill instantly (crossing the mark) — the queue
	// proves the action ran either way.
	const holdDiag = await page.evaluate(() => {
		const q = globalThis.__hlQueue?.getState().orders ?? [];
		const last = q[q.length - 1];
		return {
			queueLen: q.length,
			last: last ? `${last.status}:${last.orderType}:${last.price ?? ""}` : null,
			openOrders: globalThis.__hlPaper.getState().openOrders.length,
		};
	});
	step("hold click diag", holdDiag);
	check(
		holdDiag.queueLen > queueBefore && holdDiag.last?.startsWith("success"),
		`hold A + click submits at the clicked price (${holdDiag.last})`,
	);

	// --- 7b) Indicator layout persists across a reload (adapter → localStorage) ---
	const studiesBefore = await page.evaluate(() => globalThis.__hlTvWidget.activeChart().getAllStudies().length);
	await page.evaluate(() => {
		globalThis.__hlTvWidget.activeChart().createStudy("MACD", false, false);
	});
	await page.waitForFunction(
		(n) => globalThis.__hlTvWidget.activeChart().getAllStudies().length > n,
		studiesBefore,
		{ timeout: 8000 },
	).catch(() => undefined);
	const studiesAdded = await page.evaluate(() => globalThis.__hlTvWidget.activeChart().getAllStudies().length);
	check(studiesAdded > studiesBefore, `indicator added to the canvas (${studiesBefore} -> ${studiesAdded})`);
	// The library autosaves through the adapter (auto_save_delay: 1).
	await page
		.waitForFunction(
			() => {
				try {
					const raw = localStorage.getItem("tv-chart-v1");
					if (!raw) return false;
					const parsed = JSON.parse(raw);
					// Must be the POST-study save (an earlier autosave from the axis drag is stale).
					return Boolean(parsed && typeof parsed === "object" && JSON.stringify(parsed).includes("MACD"));
				} catch {
					return false;
				}
			},
			null,
			{ timeout: 8000 },
		)
		.catch(() => undefined);
	const saved = await page.evaluate(() => {
		try {
			const raw = localStorage.getItem("tv-chart-v1");
			if (!raw) return null;
			const parsed = JSON.parse(raw);
			return { keys: Object.keys(parsed ?? {}).length, bytes: raw.length, hasMacd: JSON.stringify(parsed).includes("MACD") };
		} catch {
			return null;
		}
	});
	check(
		saved !== null && saved.keys > 0 && saved.bytes > 10 && saved.hasMacd,
		`chart layout is auto-saved to localStorage (${JSON.stringify(saved)})`,
	);

	await page.reload({ waitUntil: "domcontentloaded" });
	await page.waitForFunction(() => Boolean(globalThis.__hlTvWidget), null, { timeout: 30000 });
	await page.waitForFunction(() => globalThis.__hlTvCal?.() != null, null, { timeout: 30000 }).catch(() => undefined);
	// Restored studies are applied once the chart data is ready — poll, don't sleep.
	await page
		.waitForFunction(
			(target) => {
				try {
					return globalThis.__hlTvWidget.activeChart().getAllStudies().length >= target;
				} catch {
					return false;
				}
			},
			studiesAdded,
			{ timeout: 15000 },
		)
		.catch(() => undefined);
	const studiesRestored = await page.evaluate(() => globalThis.__hlTvWidget.activeChart().getAllStudies().length);
	check(
		studiesRestored >= studiesAdded,
		`indicators survive a page reload (${studiesAdded} -> ${studiesRestored})`,
	);

	// The saved state must not pin the canvas to the symbol it was captured on —
	// switching markets rebuilds the widget and the chart must follow.
	await page.getByText("ETH-USDC", { exact: true }).first().click();
	await page.waitForTimeout(3500);
	const tvSymbol = await page.evaluate(() => globalThis.__hlTvWidget.activeChart().symbol());
	check(tvSymbol === "ETH", `market switch follows while persisted state is loaded (${tvSymbol})`);

	// --- 7c) A poisoned saved state must self-heal: TV stores each pane's axes in
	// leftAxisesState/rightAxisesState, and a left-captured main axis renders the
	// y-axis on the wrong side while killing getRightPriceScales() — no range, no
	// calibration, every price-pixel feature dead. Seed exactly that state.
	const poison = await page.evaluate(() => {
		const raw = localStorage.getItem("tv-chart-v1");
		if (!raw) return { ok: false, why: "no state" };
		const state = JSON.parse(raw);
		let moved = 0;
		for (const chart of state.charts ?? []) {
			for (const pane of chart?.panes ?? []) {
				if (
					Array.isArray(pane?.leftAxisesState) &&
					pane.leftAxisesState.length === 0 &&
					Array.isArray(pane?.rightAxisesState) &&
					pane.rightAxisesState.length > 0
				) {
					pane.leftAxisesState = pane.rightAxisesState;
					pane.rightAxisesState = [];
					moved += 1;
				}
			}
		}
		if (moved === 0) return { ok: false, why: "nothing to poison" };
		localStorage.setItem("tv-chart-v1", JSON.stringify(state));
		return { ok: true, moved };
	});
	check(poison.ok, `left-axis poison seeded into the saved state (${JSON.stringify(poison)})`);
	await page.reload({ waitUntil: "domcontentloaded" });
	await page.waitForFunction(() => Boolean(globalThis.__hlTvWidget), null, { timeout: 30000 });
	await page.waitForFunction(() => globalThis.__hlTvCal?.() != null, null, { timeout: 30000 }).catch(() => undefined);
	await page.waitForTimeout(2000);
	const healedState = await page.evaluate(() => {
		const m = globalThis.__hlTvCal?.();
		const frame = [...document.querySelectorAll("iframe")].find((f) => f.getBoundingClientRect().width > 300);
		const fr = frame?.getBoundingClientRect();
		const el = frame?.contentDocument?.querySelector(".price-axis");
		return {
			cal: m
				? { left: Math.round(m.axis.left), top: Math.round(m.axis.top), width: Math.round(m.axis.width), height: Math.round(m.axis.height) }
				: null,
			axisRightSide: el && fr ? el.getBoundingClientRect().x - fr.left > fr.width / 2 : null,
		};
	});
	check(
		Boolean(healedState.cal) && healedState.axisRightSide === true,
		`left-axis state self-heals on load — calibration + y-axis back on the right (${JSON.stringify(healedState)})`,
	);
	// And the axis must be interactive again (the exact feature the poison kills).
	if (healedState.cal) {
		const { left, top, width, height } = healedState.cal;
		await page.mouse.move(left + width / 2, top + height / 3, { steps: 5 });
		await page.waitForTimeout(500);
	}
	const healedCross = await page.getByRole("button", { name: /^Set order price/ }).count();
	check(healedCross > 0, "axis menu works again after healing");

	// --- 8) Switch BACK to Default via the TV header button (the widget's own UI) ---
	// This doubles as the overlay hit-test regression: if the layer root ever covers
	// the iframe again, this click never reaches the header and the switch hangs.
	const frames = await page.locator('iframe[src*="blob:"]').count();
	check(frames > 0, "TV widget iframe present");
	try {
		const tvFrame = page.frameLocator('iframe[src*="blob:"]');
		await tvFrame.getByText("Default", { exact: true }).first().click({ timeout: 5000 });
		await page.waitForFunction(() => document.querySelectorAll('iframe[src*="blob:"]').length === 0, null, {
			timeout: 15000,
		});
		check(true, "TV header Default button switches back to the default canvas");
		// kline mounts via a lazy chunk now (TV boots first) — wait for its toolbar.
		await page.getByRole("button", { name: "TradingView", exact: true }).first().waitFor({ timeout: 15000 });
		const klineToggle = await page.getByRole("button", { name: "TradingView", exact: true }).count();
		check(klineToggle > 0, "default canvas toolbar is back (source toggle present)");
	} catch (error) {
		check(false, `TV header Default button switches back to the default canvas (${String(error).slice(0, 120)})`);
		check(false, "default canvas toolbar is back (source toggle present)");
	}

	console.log(failures.length === 0 ? "\nTV PARITY CHECK PASS" : `\n${failures.length} CHECK(S) FAILED`);
	process.exitCode = failures.length === 0 ? 0 : 1;
} finally {
	if (logs.length > 0) console.log("---- page logs ----");
	for (const line of logs.slice(-30)) console.log(line);
	await browser.close();
}
