import { readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Browser check for the hotkeys (dev server must be running):
 *   node scripts/check-hotkeys.mjs
 *
 * Covers: form submit keys, form toggles (q/w), the typing guard, cancel keys,
 * hold-key + chart click, positionless V/B being inert, and the help overlay
 * (including the master enable toggle).
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
			} catch {
				// continue
			}
		}
	} catch {
		// fall through
	}
	return "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
}


/**
 * TradingView loads by default now — the kline-based suites need the default
 * (backup) canvas. Switches via the TV header's "Default" label; no-op when the
 * widget is unavailable (the app auto-falls back to kline on its own).
 */
async function ensureDefaultCanvas(page) {
	if ((await page.getByRole("button", { name: "TradingView", exact: true }).count()) > 0) return;
	try {
		await page.waitForFunction(() => Boolean(globalThis.__hlTvWidget), null, { timeout: 20000 });
		await page.frameLocator('iframe[src*="blob:"]').getByText("Default", { exact: true }).first().click({ timeout: 5000 });
	} catch {
		return;
	}
	await page.getByRole("button", { name: "TradingView", exact: true }).first().waitFor({ timeout: 15000 });
}

const browser = await chromium.launch({ headless: true, executablePath: findChromium() });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

let failures = 0;
const step = (label, value) => console.log(`${label}:`, JSON.stringify(value));
const soundLog = () => page.evaluate(() => (globalThis.__hlSoundLog ?? []).slice());
const check = (ok, message) => {
	console.log(`${ok ? "PASS" : "FAIL"}: ${message}`);
	if (!ok) failures += 1;
};
const orderCount = () => page.evaluate(() => globalThis.__hlPaper.getState().openOrders.length);
const entryState = () =>
	page.evaluate(() => {
		const s = globalThis.__hlOrderEntry.getState();
		return {
			tif: s.tif,
			reduceOnly: s.reduceOnly,
			limitPrice: s.limitPrice,
			side: s.side,
			orderType: s.orderType,
			size: s.size,
			sizeMode: s.sizeMode,
		};
	});
const setEntry = (patch) => page.evaluate((p) => globalThis.__hlOrderEntry.getState().actions && Object.entries(p).forEach(([k, v]) => globalThis.__hlOrderEntry.getState().actions[`set${k[0].toUpperCase()}${k.slice(1)}`](v)), patch);

try {
	// The app is hosted on the VPS; point this at a base URL to check another host
	// without editing the script. NOTE: it still needs a DEV server, because it reads
	// the dev-only debug hooks (__hlChart / __hlPaper / __hlOrderEntry), which a
	// production build does not expose.
	const baseUrl = process.env.BASE_URL ?? "http://localhost:3000";
	await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
	await page.waitForTimeout(5000);
	await ensureDefaultCanvas(page);

	const boot = await page.evaluate(() => ({
		chart: !!globalThis.__hlChart,
		paper: !!globalThis.__hlPaper,
		entry: !!globalThis.__hlOrderEntry,
		form: !!document.querySelector("form[data-order-form]"),
	}));
	stepBoot(boot);
	check(boot.chart && boot.paper && boot.entry && boot.form, "dev hooks + order form present");
	if (!boot.chart || !boot.paper || !boot.entry || !boot.form) process.exit(1);

	// Connect the mock wallet so canSubmit passes (same flow as the other suites).
	if ((await page.getByText("Connect Wallet", { exact: true }).count()) > 0) {
		await page.getByText("Connect Wallet", { exact: true }).first().click();
		await page.getByText("Mock Wallet (Testing)").click();
		await page.locator('button:has-text("Mock Wallet")').last().click();
		await page
			.waitForFunction(() => !document.body.innerText.includes("Mock Wallet (Testing)"), { timeout: 10_000 })
			.catch(() => undefined);
	}

	// Seed a valid, non-crossing limit order setup (size + price far below the mark),
	// with reduce-only ON to prove the sticky-preference fix end to end.
	await page.evaluate(() => {
		globalThis.__hlSoundLog?.splice(0);
		const actions = globalThis.__hlOrderEntry.getState().actions;
		actions.setOrderType("limit");
		actions.setSide("buy");
		actions.setSize("0.001");
		actions.setLimitPrice("70000");
		actions.setReduceOnly(true);
	});

	// --- Alt+Shift+A: place buy order (submits the form) ---
	const beforeSubmit = await orderCount();
	await page.keyboard.press("Alt+Shift+A");
	await page.waitForTimeout(1200);
	const afterSubmit = await orderCount();
	check(afterSubmit === beforeSubmit + 1, `Alt+Shift+A places a limit buy (${beforeSubmit} -> ${afterSubmit})`);
	const afterSubmitState = await entryState();
	check(
		afterSubmitState.reduceOnly === true,
		`reduce-only survives order submission (stays ${afterSubmitState.reduceOnly})`,
	);
	check(
		afterSubmitState.size === "0.001",
		`size survives order submission (${JSON.stringify(afterSubmitState.size)})`,
	);
	const logAfterSubmit = await soundLog();
	const notifAfterSubmit = await page.evaluate(() =>
		(globalThis.__hlNotif?.getState().items ?? []).map((i) => `${i.side}:${i.market}:${i.size}:${i.kind ?? "-"}`),
	);
	check(
		logAfterSubmit.includes("action"),
		`resting limit placement plays the action tick (log=${logAfterSubmit.join(",")} notif=${notifAfterSubmit.join("|")})`,
	);

	// --- Q / W toggles ---
	const beforeTif = (await entryState()).tif;
	await page.keyboard.press("q");
	await page.waitForTimeout(200);
	const afterTif = (await entryState()).tif;
	check(afterTif !== beforeTif, `q toggles post-only (${beforeTif} -> ${afterTif})`);

	const beforeReduce = (await entryState()).reduceOnly;
	await page.keyboard.press("w");
	await page.waitForTimeout(200);
	const afterReduce = (await entryState()).reduceOnly;
	check(afterReduce !== beforeReduce, `w toggles reduce-only (${beforeReduce} -> ${afterReduce})`);
	await page.keyboard.press("w"); // restore to sticky ON

	// --- Toolbar hotkey toggle: the top-bar keyboard button gates every key ---
	const toolbarButton = page.getByRole("button", { name: "Hotkeys", exact: true });
	await toolbarButton.click();
	await page.waitForTimeout(200);
	const tifWhenOff = (await entryState()).tif;
	await page.keyboard.press("q");
	await page.waitForTimeout(200);
	check((await entryState()).tif === tifWhenOff, "toolbar toggle off: q stops working");
	await toolbarButton.click();
	await page.waitForTimeout(200);
	await page.keyboard.press("q");
	await page.waitForTimeout(200);
	check((await entryState()).tif !== tifWhenOff, "toolbar toggle on: q works again");

	// --- Typing guard: a keydown inside an input must not fire the hotkey ---
	const guard = await page.evaluate(() => {
		const actions = globalThis.__hlOrderEntry.getState().actions;
		actions.setReduceOnly(false);
		const input = document.querySelector("form[data-order-form] input");
		if (!input) return { found: false, reduceOnly: false };
		input.focus();
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "w", bubbles: true }));
		return { found: true, reduceOnly: globalThis.__hlOrderEntry.getState().reduceOnly };
	});
	check(guard.found && guard.reduceOnly === false, "typing W inside an input does not toggle reduce-only");
	await page.evaluate(() => document.activeElement?.blur?.());

	// --- X: cancel the most recent resting limit; P cancels the rest ---
	await page.evaluate(() => {
		const store = globalThis.__hlPaper;
		const state = store.getState();
		store.setState({
			openOrders: [
				...state.openOrders,
				{
					oid: 999999201,
					assetId: 0,
					coin: "BTC",
					dex: "",
					isBuy: true,
					size: 1,
					limitPx: 69000,
					reduceOnly: false,
					leverage: 10,
					marginMode: "cross",
					tif: "Gtc",
					placedAt: Date.now() + 1_000_000,
				},
			],
		});
	});
	await page.evaluate(() => globalThis.__hlSoundLog?.splice(0));
	const preCancelOrders = await page.evaluate(() =>
		globalThis.__hlPaper.getState().openOrders.map((o) => ({ oid: o.oid, px: o.limitPx, tif: o.tif, trig: !!o.isTrigger })),
	);
	step("orders before X", preCancelOrders);
	const beforeCancel = await orderCount();
	await page.keyboard.press("x");
	await page.waitForTimeout(300);
	const afterX = await orderCount();
	check(afterX === beforeCancel - 1, `X cancels the newest resting order (${beforeCancel} -> ${afterX})`);
	const logAfterCancel = await soundLog();
	check(logAfterCancel.includes("action"), `cancelling plays the action tick (${logAfterCancel.join(",")})`);

	await page.keyboard.press("p");
	await page.waitForTimeout(300);
	const afterP = await orderCount();
	check(afterP === 0, `P cancels every resting order (-> ${afterP})`);

	// --- Hold A + click the chart: places a limit buy at the clicked price ---
	// (The earlier submit's resetForm cleared the size field — reseed it first.)
	await page.evaluate(() => globalThis.__hlOrderEntry.getState().actions.setSize("0.001"));
	// Queue-based assertions: a buy limit above the mark can fill INSTANTLY in
	// preview, so counting resting orders was a coin-flip. The queue row proves the
	// click submitted either way.
	const holdQueueBefore = await page.evaluate(() => (globalThis.__hlQueue?.getState().orders ?? []).length);
	await page.keyboard.down("a");
	const heldDuringDown = await page.evaluate(() => globalThis.__hlHold?.get() ?? "no-hook");
	await page.mouse.click(600, 300);
	await page.keyboard.up("a");
	await page.waitForTimeout(1200);
	const clickState = await page.evaluate(() => ({
		orders: globalThis.__hlPaper.getState().openOrders.length,
		list: globalThis.__hlPaper.getState().openOrders.map((o) => ({ oid: o.oid, px: o.limitPx })),
		limitPrice: globalThis.__hlOrderEntry.getState().limitPrice,
		size: globalThis.__hlOrderEntry.getState().size,
		orderType: globalThis.__hlOrderEntry.getState().orderType,
		side: globalThis.__hlOrderEntry.getState().side,
	}));
	step(`held during keydown: ${heldDuringDown}`, clickState);
	const holdQueueAfter = await page.evaluate((before) => {
		const q = globalThis.__hlQueue?.getState().orders ?? [];
		const last = q[q.length - 1];
		return {
			count: q.length,
			last: last ? `${last.status}:${last.price ?? ""}` : null,
			lastPrice: Number(last?.price ?? 0),
			added: q.slice(before).map((o) => `${o.status}:${o.orderType}:${o.price ?? ""}:${o.error ?? ""}`),
			upCount: globalThis.__hlUpCount ?? 0,
			submitCount: globalThis.__hlSubmitCount ?? 0,
		};
	}, holdQueueBefore);
	check(
		holdQueueAfter.count === holdQueueBefore + 1 && (holdQueueAfter.last ?? "").startsWith("success"),
		`hold A + click places a limit (delta ${holdQueueAfter.count - holdQueueBefore}: ups ${holdQueueAfter.upCount}, submits ${holdQueueAfter.submitCount}, ${holdQueueAfter.added.join(" | ")})`,
	);
	check(
		holdQueueAfter.lastPrice > 0 && holdQueueAfter.lastPrice !== 70000,
		`click submitted at the clicked price (${holdQueueAfter.lastPrice})`,
	);

	// --- B with no position must do nothing ---
	await page.keyboard.press("p"); // clear orders again
	await page.waitForTimeout(200);
	// Flatten any position from a raced instant fill — B must be provably inert.
	await page.evaluate(() => globalThis.__hlPaper.setState({ positions: [] }));
	await page.keyboard.down("b");
	await page.mouse.click(620, 320);
	await page.keyboard.up("b");
	await page.waitForTimeout(800);
	const tpOrders = await page.evaluate(
		() => globalThis.__hlPaper.getState().openOrders.filter((o) => o.isTrigger).length,
	);
	check(tpOrders === 0, "hold B + click is inert without a position");

	// --- Rapid hold+click spam: EVERY click must place. The clicks land ~3px apart,
	// so later ones sit on the resting lines just created — stamps/preview drags used
	// to eat them silently.
	await page.evaluate(() => {
		const a = globalThis.__hlOrderEntry.getState().actions;
		a.setOrderType("limit");
		a.setSize("0.001");
	});
	const spamBefore = await page.evaluate(() => ({
		queue: (globalThis.__hlQueue?.getState().orders ?? []).length,
		open: globalThis.__hlPaper.getState().openOrders.length,
	}));
	await page.keyboard.down("a");
	for (let i = 0; i < 5; i += 1) {
		await page.mouse.click(600, 600 + i * 3); // low on the chart → prices below the mark (they rest)
		await page.waitForTimeout(150);
	}
	await page.keyboard.up("a");
	await page.waitForTimeout(1000);
	const spamAfter = await page.evaluate(() => ({
		queue: (globalThis.__hlQueue?.getState().orders ?? []).length,
		open: globalThis.__hlPaper.getState().openOrders.length,
	}));
	check(
		spamAfter.queue - spamBefore.queue === 5 && spamAfter.open - spamBefore.open === 5,
		`5 rapid hold+click orders all place (${spamAfter.queue - spamBefore.queue} queued, ${spamAfter.open - spamBefore.open} resting)`,
	);

	// --- Settings → Hotkeys page: capture-to-rebind (q → j), old key dies, reset restores ---
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await page.waitForTimeout(500);
	check(
		(await page.getByText("Quick add amounts (USD)").count()) > 0,
		"settings exposes the editable size-button amounts",
	);

	// Default limit size (Settings → Default size): $100 out of the box, editable + persisted.
	const readDefaultSizeField = () =>
		page.evaluate(() => {
			const label = [...document.querySelectorAll("*")].find(
				(el) => el.children.length === 0 && el.textContent?.trim() === "Limit order size (USD)",
			);
			let node = label;
			while (node && !node.querySelector("input")) node = node.parentElement;
			const input = node?.querySelector("input");
			return input ? input.value : null;
		});
	const setDefaultSizeField = (value) =>
		page.evaluate((next) => {
			const label = [...document.querySelectorAll("*")].find(
				(el) => el.children.length === 0 && el.textContent?.trim() === "Limit order size (USD)",
			);
			let node = label;
			while (node && !node.querySelector("input")) node = node.parentElement;
			const input = node?.querySelector("input");
			if (!input) return;
			const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
			setter.call(input, next);
			input.dispatchEvent(new Event("input", { bubbles: true }));
		}, value);
	const readPersistedDefaultSize = () =>
		page.evaluate(() => {
			try {
				return JSON.parse(localStorage.getItem("global-settings-v2") ?? "{}").state?.defaultLimitSizeUsd ?? null;
			} catch {
				return null;
			}
		});
	check((await readDefaultSizeField()) === "100", "Settings shows the $100 default limit size");
	await setDefaultSizeField("150");
	await page.waitForTimeout(300);
	check((await readPersistedDefaultSize()) === 150, "editing the default limit size persists");
	await setDefaultSizeField("100");
	await page.waitForTimeout(300);
	await page.getByText("Hotkeys", { exact: true }).first().click(); // the page nav segment
	await page.waitForTimeout(300);
	const rebindRow = page.getByRole("button", { name: "Rebind Toggle post only" });
	check((await rebindRow.count()) > 0, "settings has its own Hotkeys page with bindable rows");
	await rebindRow.click();
	await page.keyboard.press("j");
	await page.waitForTimeout(300);
	const chipText = (await page.getByRole("button", { name: "Rebind Toggle post only" }).innerText()).trim();
	check(chipText === "J", `capture mode stored the pressed key (${chipText})`);

	const tifBeforeJ = (await entryState()).tif;
	await page.keyboard.press("j");
	await page.waitForTimeout(200);
	const tifAfterJ = (await entryState()).tif;
	check(tifAfterJ !== tifBeforeJ, "rebound key j toggles post-only");
	await page.keyboard.press("q");
	await page.waitForTimeout(200);
	check((await entryState()).tif === tifAfterJ, "the replaced default key q no longer fires");

	await page.getByRole("button", { name: "Reset", exact: true }).click();
	await page.waitForTimeout(200);
	check(
		(await page.getByRole("button", { name: "Rebind Market buy" }).count()) > 0 &&
			(await page.getByRole("button", { name: "Rebind Flatten positions" }).count()) > 0,
		"formerly unbound actions are now bindable rows",
	);
	for (const [label, key] of [
		["Rebind Market buy", "m"],
		["Rebind Market close active position", "c"],
		["Rebind Flatten positions", "f"],
		["Rebind Size preset 1", "1"],
	]) {
		await page.getByRole("button", { name: label }).click();
		await page.keyboard.press(key);
		await page.waitForTimeout(200);
		const chip = (await page.getByRole("button", { name: label }).innerText()).trim();
		check(chip === key.toUpperCase(), `bound ${label.replace("Rebind ", "")} to ${key} (${chip})`);
	}
	await page.keyboard.press("q");
	await page.waitForTimeout(200);
	check((await entryState()).tif !== tifAfterJ, "Reset restores the default keys");

	await page.keyboard.press("Escape");
	await page.waitForTimeout(300);
	check(
		(await page.getByText("Restore default keys").count()) === 0,
		"Escape closes the settings dialog",
	);


	// --- Nuke button: badge counts paper orders; confirm dialog; Yes closes all ---
	await page.evaluate(() => {
		const s = globalThis.__hlPaper;
		s.setState({
			positions: [
				{ assetId: 0, coin: globalThis.__hlSymbol, dex: "", szi: 0.02, entryPx: 85000, leverage: 10, marginMode: "cross" },
			],
			openOrders: [
				{ oid: 999999301, assetId: 0, coin: globalThis.__hlSymbol, dex: "", isBuy: true, size: 1, limitPx: 69000, reduceOnly: false, leverage: 10, marginMode: "cross", tif: "Gtc", placedAt: Date.now() },
			],
		});
	});
	await page.waitForTimeout(400);
	const ordersTabText = await page.evaluate(() => {
		const tab = [...document.querySelectorAll('[role="tab"]')].find((el) => el.textContent?.includes("Open Orders"));
		return tab?.textContent ?? "";
	});
	check(/\(1\)/.test(ordersTabText), `Open Orders badge counts preview orders (${ordersTabText.trim()})`);

	await page.getByRole("button", { name: "Nuke account" }).click();
	await page.waitForTimeout(300);
	check((await page.getByRole("dialog", { name: "Are you sure?" }).count()) > 0, "nuke asks Are you sure? with Yes/No");
	await page.getByRole("button", { name: "No", exact: true }).click();
	await page.waitForTimeout(300);
	const intact = await page.evaluate(() => ({
		o: globalThis.__hlPaper.getState().openOrders.length,
		p: globalThis.__hlPaper.getState().positions.length,
	}));
	check(intact.o === 1 && intact.p === 1, `No leaves everything alone (${JSON.stringify(intact)})`);

	await page.getByRole("button", { name: "Nuke account" }).click();
	await page.waitForTimeout(300);
	await page.getByRole("button", { name: "Yes", exact: true }).click();
	await page.waitForTimeout(1200);
	const nuked = await page.evaluate(() => ({
		o: globalThis.__hlPaper.getState().openOrders.length,
		p: globalThis.__hlPaper.getState().positions.length,
	}));
	check(nuked.o === 0 && nuked.p === 0, `Yes cancels every order and closes every position (${JSON.stringify(nuked)})`);
	check((await page.getByRole("dialog", { name: "Are you sure?" }).count()) === 0, "dialog closes after the nuke");
	if (nuked.p > 0) {
		// Pinpoint a leftover position: does useUserPositions see it (positions-tab
		// badge), did the close plan fire (fill notification), and what does a direct
		// nuke call report?
		const diag = await page.evaluate(async () => {
			const posTab = [...document.querySelectorAll('[role="tab"]')].find((el) => el.textContent?.includes("Positions"));
			const manual = globalThis.__hlNuke ? await globalThis.__hlNuke() : null;
			return {
				positionsBadge: posTab?.textContent ?? "",
				notif: (globalThis.__hlNotif?.getState().items ?? []).map((i) => `${i.side}:${i.market}:${i.kind}`),
				store: globalThis.__hlPaper.getState().positions.map((p) => `${p.coin}:${p.szi}`),
				manual: manual ? JSON.stringify(manual) : "no-handle",
			};
		});
		step("nuke leftover diag", diag);
	}

	// --- Quick size chips (quote mode = exact USD math) + CC clear ---
	await page.evaluate(() => {
		const actions = globalThis.__hlOrderEntry.getState().actions;
		actions.setSizeMode("quote");
		actions.setSize("10");
	});
	await page.getByRole("button", { name: "Add 50 USD to size" }).click();
	await page.waitForTimeout(150);
	const afterChip = await page.evaluate(() => globalThis.__hlOrderEntry.getState().size);
	check(afterChip === "60", `size chip adds its USD amount (${afterChip})`);
	await page.getByRole("button", { name: "Clear size" }).click();
	await page.waitForTimeout(150);
	const afterClear = await page.evaluate(() => globalThis.__hlOrderEntry.getState().size);
	check(afterClear === "", `CC clears the size (${JSON.stringify(afterClear)})`);
	await page.evaluate(() => globalThis.__hlOrderEntry.getState().actions.setSizeMode("base"));

	// --- Bound-without-default actions: preset sets size, m/c/f manage a position ---
	await page.keyboard.press("1");
	await page.waitForTimeout(200);
	const presetState = await entryState();
	check(
		presetState.size === "5" && presetState.sizeMode === "quote",
		`preset 1 applies the configured amount (${presetState.size} ${presetState.sizeMode})`,
	);

	// The $5 preset is below the $10 min-notional — size up so the market order can submit.
	await page.evaluate(() => globalThis.__hlOrderEntry.getState().actions.setSize("50"));
	const positionsBefore = await page.evaluate(() => globalThis.__hlPaper.getState().positions.length);
	await page.evaluate(() => globalThis.__hlSoundLog?.splice(0));
	await page.keyboard.press("m");
	await page.waitForTimeout(900);
	const afterMarket = await page.evaluate(() => globalThis.__hlPaper.getState().positions.length);
	check(afterMarket === positionsBefore + 1, `bound m places a market buy (${positionsBefore} -> ${afterMarket})`);
	const logMarket = await soundLog();
	check(logMarket.includes("fill"), `market fill plays the fill chime (${logMarket.join(",")})`);

	await page.keyboard.press("c");
	await page.waitForTimeout(900);
	const afterClose = await page.evaluate(() => globalThis.__hlPaper.getState().positions.length);
	check(afterClose === positionsBefore, `bound c market-closes the position (-> ${afterClose})`);

	await page.keyboard.press("m");
	await page.waitForTimeout(900);
	await page.keyboard.press("f");
	await page.waitForTimeout(900);
	const afterFlatten = await page.evaluate(() => globalThis.__hlPaper.getState().positions.length);
	check(afterFlatten === positionsBefore, `bound f flattens positions (-> ${afterFlatten})`);


	// --- Chase limit: placement → engine re-price → timeout → Chase tab history ---
	await page.evaluate(() => {
		const s = globalThis.__hlPaper;
		// Neutralize fill firing so placement/timeout assertions are deterministic
		// (the engine's re-pricing still runs against the real book).
		s.setState({ actions: { ...s.getState().actions, fillCrossedOrders: () => [] } });
		globalThis.__chaseTimeoutMs = 2500;
		const a = globalThis.__hlOrderEntry.getState().actions;
		a.setOrderType("chaseLimit");
		a.setSide("buy");
		a.setSize("0.001");
		a.setReduceOnly(false);
		a.setTif("Alo");
		globalThis.__hlSoundLog?.splice(0);
	});
	await page.evaluate(() => document.querySelector("form[data-order-form]").requestSubmit());
	await page.waitForTimeout(700);
	const chaseDiag = await page.evaluate(() => ({
		queue: (globalThis.__hlQueue?.getState().orders ?? []).map((o) => `${o.status}:${o.orderType}:${o.error ?? ""}`),
		entry: globalThis.__hlChase?.getState().entry ?? null,
		size: globalThis.__hlOrderEntry.getState().size,
		mode: globalThis.__hlOrderEntry.getState().sizeMode,
		tif: globalThis.__hlOrderEntry.getState().tif,
		orders: globalThis.__hlPaper.getState().openOrders.map((o) => `${o.isBuy ? "B" : "A"}:${o.size}:${o.limitPx}`),
	}));
	step("chase submit diag", chaseDiag);
	const chaseRows = await page.evaluate(() =>
		globalThis.__hlPaper
			.getState()
			.openOrders.filter((o) => !o.isTrigger && o.isBuy && o.size === 0.001)
			.map((o) => ({ tif: o.tif, r: o.reduceOnly, px: o.limitPx })),
	);
	check(
		chaseRows.length === 1 && chaseRows[0].tif === "Alo" && chaseRows[0].r === false,
		`chase keeps the form's post-only (Alo) and rests it (${JSON.stringify(chaseRows[0] ?? null)})`,
	);
	await page.waitForTimeout(1200);
	const chasedPx = await page.evaluate(() => {
		const o = globalThis.__hlPaper
			.getState()
			.openOrders.find((x) => !x.isTrigger && x.isBuy && x.size === 0.001);
		return o?.limitPx ?? null;
	});
	step("chase re-priced toward the top of the book", { placed: chaseRows[0]?.px, after: chasedPx });

	// Reduce-only placement with a long in the book: sell-side (chase the ask).
	await page.evaluate(() => {
		const s = globalThis.__hlPaper;
		const state = s.getState();
		s.setState({
			positions: [
				{ assetId: 0, coin: globalThis.__hlSymbol, dex: "", szi: 0.02, entryPx: 85000, leverage: 10, marginMode: "cross" },
			],
		});
		const a = globalThis.__hlOrderEntry.getState().actions;
		a.setSide("sell");
		a.setSize("0.001");
		a.setReduceOnly(true);
		globalThis.__hlSoundLog?.splice(0);
	});
	await page.evaluate(() => document.querySelector("form[data-order-form]").requestSubmit());
	await page.waitForTimeout(500);
	const reduceRows = await page.evaluate(() =>
		globalThis.__hlPaper
			.getState()
			.openOrders.filter((o) => !o.isTrigger && !o.isBuy && o.reduceOnly)
			.map((o) => ({ r: o.reduceOnly, tif: o.tif })),
	);
	check(
		reduceRows.length >= 1 && reduceRows[0].r === true && reduceRows[0].tif === "Alo",
		`reduce-only chase placement (${JSON.stringify(reduceRows[0] ?? null)})`,
	);

	await page.waitForTimeout(700);
	const chaseSound = await soundLog();
	check(chaseSound.includes("action"), `cancellations play the action tick (${chaseSound.join(",")})`);

	// The reduce chase is a CLOSE chase (reduceOnly): it must keep riding well past
	// the entry-style timeout — that is the whole point (never strand the position).
	await page.waitForTimeout(2400); // chase2 age now >2.5s
	const ride = await page.evaluate(() => ({
		rows: globalThis.__hlPaper
			.getState()
			.openOrders.filter((o) => !o.isTrigger && o.size === 0.001)
			.map((o) => `${o.isBuy ? "B" : "S"}:${o.size}:r${o.reduceOnly}:${o.tif}`),
		entry: globalThis.__hlChase.getState().entry ?? null,
		hist: (globalThis.__hlChase.getState().history ?? []).map((h) => `${h.outcome}:${h.size}`),
	}));
	check(
		ride.rows.length === 1 && ride.rows[0].startsWith("S") && ride.rows[0].includes("rtrue") && ride.entry?.mode === "close",
		`close chases keep riding past the entry timeout (${JSON.stringify(ride)})`,
	);
	check(!ride.hist.includes("timeout"), "a close chase never records a timeout");

	await page.keyboard.press("p"); // P cancels the riding close chase
	await page.waitForTimeout(600);
	const rideGone = await page.evaluate(
		() => globalThis.__hlPaper.getState().openOrders.filter((o) => !o.isTrigger && o.size === 0.001).length === 0,
	);
	check(rideGone, "P cancels the riding close chase");

	// Chase tab: directly to the right of Order History.
	await page.getByRole("tab", { name: "Chase" }).click();
	await page.waitForTimeout(500);
	const chaseTabText = await page.evaluate(() => document.body.innerText);
	check(chaseTabText.includes("Cancelled"), "Chase tab history shows the handed-off Cancelled record");
	check(!chaseTabText.includes("Timed out"), "history has no bogus timeout record");
	check(chaseTabText.includes("0.001"), "history row includes the chase size");

	// --- Help overlay: "?" opens, master toggle gates keys, Escape closes ---
	await page.keyboard.press("?");
	await page.waitForTimeout(300);
	const helpVisible = await page.getByRole("dialog", { name: "Keyboard shortcuts" }).count();
	check(helpVisible > 0, "? opens the shortcuts help");

	// Disable hotkeys: q must stop working.
	await page.getByRole("button", { name: /Hotkeys on/ }).click();
	await page.waitForTimeout(200);
	const tifWhileOff = (await entryState()).tif;
	await page.keyboard.press("q");
	await page.waitForTimeout(200);
	check((await entryState()).tif === tifWhileOff, "disabled hotkeys ignore keys");
	// Re-enable for cleanliness.
	await page.getByRole("button", { name: /Hotkeys off/ }).click();
	await page.waitForTimeout(200);

	await page.keyboard.press("Escape");
	await page.waitForTimeout(300);
	check((await page.getByRole("dialog", { name: "Keyboard shortcuts" }).count()) === 0, "Escape closes the help");

	check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ""}`);
	// --- Size memory: last size survives refresh; default only if never used ---
	await page.evaluate(() => {
		const a = globalThis.__hlOrderEntry.getState().actions;
		a.setOrderType("limit");
		a.setSize("0.0042");
	});
	await page.reload({ waitUntil: "domcontentloaded" });
	await page.waitForFunction(() => Boolean(globalThis.__hlOrderEntry), null, { timeout: 30000 });
	const restoredSize = await page.evaluate(() => globalThis.__hlOrderEntry.getState().size);
	check(restoredSize === "0.0042", `last used size remembered after refresh (${restoredSize})`);

	await page.evaluate(() => globalThis.__hlOrderEntry.getState().actions.setSize(""));
	await page.reload({ waitUntil: "domcontentloaded" });
	await page.waitForFunction(() => Boolean(globalThis.__hlOrderEntry), null, { timeout: 30000 });
	await page
		.waitForFunction(() => globalThis.__hlOrderEntry.getState().size.trim() !== "", null, { timeout: 15000 })
		.catch(() => undefined);
	const seededState = await page.evaluate(() => {
		const s = globalThis.__hlOrderEntry.getState();
		return { size: s.size, mode: s.sizeMode, orderType: s.orderType };
	});
	check(
		seededState.orderType === "limit" &&
			Number(seededState.size) > 0 &&
			(seededState.mode !== "quote" || seededState.size === "100"),
		`default limit size seeds after refresh with an empty size (${JSON.stringify(seededState)})`,
	);

	// --- Order queue popup: manual close + auto-dismiss (dev-shortened window) ---
	await page.evaluate(() => {
		globalThis.__hlOrderToastDismissMs = 1200;
		globalThis.__hlQueue.getState().actions.addOrder({
			market: "BTC",
			side: "buy",
			size: "0.001",
			price: "84000",
			orderType: "limit",
			status: "failed",
			error: "auto-dismiss test",
			completedAt: Date.now(),
		});
	});
	await page.waitForTimeout(250);
	check((await page.getByText("Order Queue").count()) > 0, "order queue popup appears with activity");
	await page.waitForTimeout(1900);
	check((await page.getByText("Order Queue").count()) === 0, "order queue popup auto-dismisses after the quiet window");

	await page.evaluate(() => {
		globalThis.__hlQueue.getState().actions.addOrder({
			market: "BTC",
			side: "buy",
			size: "0.001",
			price: "84000",
			orderType: "limit",
			status: "failed",
			error: "manual close test",
			completedAt: Date.now(),
		});
	});
	await page.waitForTimeout(250);
	check((await page.getByText("Order Queue").count()) > 0, "order queue reappears on new activity");
	await page.getByRole("button", { name: "Dismiss order queue" }).click();
	await page.waitForTimeout(250);
	check((await page.getByText("Order Queue").count()) === 0, "manual close hides the popup immediately");

	// --- Post-only chase close: runs past the entry timeout; dust explains itself ---
	// The mid-run reload drops the mock connection — the positions table (and the
	// row's close menu) only exists while connected.
	if ((await page.getByText("Connect Wallet", { exact: true }).count()) > 0) {
		await page.getByText("Connect Wallet", { exact: true }).first().click();
		await page.getByText("Mock Wallet (Testing)").click();
		await page.locator('button:has-text("Mock Wallet")').last().click();
		await page.waitForTimeout(800);
	}
	await page.getByRole("tab", { name: "Positions" }).click();
	await page.waitForTimeout(400);
	await page.getByRole("button", { name: "Position close actions" }).click();
	await page.waitForTimeout(250);
	await page.getByText("Chase Close", { exact: true }).click();
	await page.waitForTimeout(900);
	const closeLeg = await page.evaluate(() =>
		globalThis.__hlPaper.getState().openOrders.filter((o) => !o.isTrigger && o.reduceOnly),
	);
	check(
		closeLeg.length === 1 && Number(closeLeg[0].size) === 0.02 && closeLeg[0].tif === "Alo",
		`chase close rests a post-only reduce order (${JSON.stringify(closeLeg.map((o) => `${o.size}@${o.limitPx}:${o.tif}`))})`,
	);
	await page.waitForTimeout(1700); // well past __chaseTimeoutMs — an ENTRY chase would have cancelled
	const stillResting = await page.evaluate(
		() => globalThis.__hlPaper.getState().openOrders.filter((o) => !o.isTrigger && o.reduceOnly).length,
	);
	check(
		stillResting === 1,
		`close chase ignores the entry timeout — keeps going until flat (${stillResting} resting)`,
	);

	// Sub-$10 remainder: no order can close it — say so explicitly.
	await page.keyboard.press("p"); // cancel the resting chase (P = cancel all resting)
	await page.waitForTimeout(400);
	await page.evaluate(() => {
		globalThis.__hlPaper.setState({
			positions: [
				{ assetId: 0, coin: "BTC", dex: "", szi: 0.000004, entryPx: 85000, leverage: 10, marginMode: "cross" },
			],
		});
	});
	await page.waitForTimeout(800);
	await page.getByRole("button", { name: "Position close actions" }).click();
	await page.waitForTimeout(250);
	await page.getByText("Chase Close", { exact: true }).click();
	await page.waitForTimeout(600);
	const dustRow = await page.evaluate(() => {
		const q = globalThis.__hlQueue?.getState().orders ?? [];
		const last = q[q.length - 1];
		return {
			error: last?.error ?? "",
			open: globalThis.__hlPaper.getState().openOrders.filter((o) => !o.isTrigger && o.reduceOnly).length,
		};
	});
	check(
		/minimum order size/i.test(dustRow.error) && dustRow.open === 0,
		`sub-$10 remainder explains itself, no chase started (${dustRow.error.slice(0, 80)})`,
	);
	await page.evaluate(() => {
		globalThis.__hlPaper.setState({ positions: [] });
	});

	console.log(failures === 0 ? "\nHOTKEYS CHECK PASS" : `\n${failures} CHECK(S) FAILED`);
	process.exitCode = failures === 0 ? 0 : 1;
} finally {
	await browser.close();
}

function stepBoot(value) {
	console.log("boot:", JSON.stringify(value));
}
