// Campaign Wiki review / canon / "what links here" fixture: the duplicate review page (per session chat, keep one,
// 409 conflict and cross-session refusals, skip), the campaign Canon page (grouped by page, Unpin writes to the
// fact's own session), the older-server empty states, and the article's "What links here" block. Desktop and 390px.
import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { startFixtureServer, stopFixtureServer } from "../lib/fixture-server.mjs";
import { VIEWPORTS, fixtureDir, outputDir } from "../lib/fixture-paths.mjs";

const root = fixtureDir(import.meta.url);
const out = outputDir(import.meta.url);
const { server, ready } = startFixtureServer(path.join(root, "server.mjs"));
const { base } = await ready;
const browser = await chromium.launch({ headless: true });
const WAIT = { timeout: 10000 };
const checks = [];
const screenshots = [];
const record = (name, pass, detail = "") => checks.push({ name, pass: Boolean(pass), detail });
const shot = async (page, name, fullPage = false) => { await page.screenshot({ path: path.join(out, `${name}.png`), fullPage }); screenshots.push(`${name}.png`); };
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const step = async (name, fn) => { try { await fn(); } catch (error) { record(`${name} (step aborted)`, false, String(error?.message ?? error).split("\n").slice(0, 4).join(" ")); } };
const mock = (page, fn) => page.evaluate(fn);
const RAW = /\b(fact-dup|fact-canon|entity-\d|dup-(gate|occupation|ferry)|chat-session)/;
const frontPage = async (page, query = "") => {
  await page.goto(`${base}${query}`);
  await page.locator("[data-campaign-wiki-entity-list]").waitFor(WAIT);
  if (!(await page.locator("[data-campaign-wiki-overview]").isVisible().catch(() => false)))
    await page.getByRole("button", { name: "Front page", exact: true }).click();
  await page.locator("[data-campaign-wiki-overview]").waitFor(WAIT);
};
const openReview = async (page, query = "") => {
  await frontPage(page, query);
  const tools = page.locator("[data-campaign-wiki-overview-tools]");
  if ((await tools.getAttribute("open")) === null) await tools.locator("summary").click();
  await tools.getByRole("button", { name: /Review duplicates/ }).click();
  await page.locator("[data-campaign-wiki-review]").waitFor(WAIT);
};
const openCanon = async (page, query = "") => {
  await frontPage(page, query);
  await page.locator("[data-campaign-wiki-overview]").getByRole("button", { name: /^Canon/ }).click();
  await page.locator("[data-campaign-wiki-canon]").waitFor(WAIT);
};
const group = (page, id) => page.locator(`[data-campaign-wiki-duplicate-group="${id}"]`);

try {
  const desktop = await browser.newPage({ viewport: VIEWPORTS.desktop });

  await step("front page entry points", async () => {
    await frontPage(desktop);
    const tools = desktop.locator("[data-campaign-wiki-overview-tools]");
    await tools.locator("[data-campaign-wiki-review-badge]").waitFor(WAIT);
    record("tools summary shows the duplicate count", (await tools.locator("[data-campaign-wiki-review-badge]").innerText()).trim() === "3");
    record("quick links include Canon", await desktop.locator("[data-campaign-wiki-overview]").getByRole("button", { name: /^Canon/ }).isVisible());
  });

  await step("desktop review", async () => {
    await openReview(desktop);
    await group(desktop, "dup-ferry").waitFor(WAIT);
    await desktop.locator('[data-campaign-wiki-duplicate-option="keep"]').nth(2).waitFor(WAIT);
    const groups = await desktop.locator("[data-campaign-wiki-duplicate-group]").count();
    record("review lists every session's groups", groups === 3, `groups=${groups}`);
    const chats = await mock(desktop, () => [...new Set(window.__wikiMock.reviewListChats)].sort());
    record("review reads sessions 1-3 only (no branch, no later session)", JSON.stringify(chats) === JSON.stringify(["chat-demo", "chat-session-1", "chat-session-2"]), JSON.stringify(chats));
    const body = await desktop.locator("[data-campaign-wiki-review]").innerText();
    record("groups name their pages, never raw ids", /Ariadne Vale/.test(body) && /Character 3/.test(body) && /Location 1/.test(body) && !RAW.test(body), body.slice(0, 300).replace(/\s+/g, " "));
    record("plain values read as text, not JSON", body.includes("Archivist of the north") && !body.includes('"Archivist'));
    record("groups carry their session", (await group(desktop, "dup-ferry").innerText()).includes("Session 1") && (await group(desktop, "dup-gate").innerText()).includes("Session 3"));
    const gateKeep = await group(desktop, "dup-gate").locator('[data-campaign-wiki-duplicate-option="keep"]').innerText();
    record("default keep is the best-sourced version", gateKeep.includes("swore an oath") && /3 quotes/.test(gateKeep), gateKeep.replace(/\s+/g, " "));
    const occKeep = await group(desktop, "dup-occupation").locator('[data-campaign-wiki-duplicate-option="keep"]').innerText();
    record("a pinned version is kept by default", /Pinned/.test(occKeep), occKeep.replace(/\s+/g, " "));
    await shot(desktop, "review-desktop-viewport");
    await shot(desktop, "review-desktop", true);
    record("review no horizontal overflow (desktop)", await noOverflow(desktop));

    await group(desktop, "dup-gate").getByText("Ariadne swore to guard the northern gate until the thaw.", { exact: true }).click();
    await group(desktop, "dup-gate").getByRole("button", { name: /Keep selected, retire 1/ }).click();
    await desktop.getByText("Kept one fact and retired 1.", { exact: true }).waitFor(WAIT);
    const resolved = await mock(desktop, () => window.__wikiMock.reviewResolves.at(-1));
    record("resolve keeps the chosen fact in its session chat with every revision", resolved?.status === 200 && resolved.chatId === "chat-demo" && resolved.groupId === "dup-gate" && resolved.body.keepFactId === "fact-dup-gate-1" && JSON.stringify(resolved.body.retireFactIds) === '["fact-dup-gate-2"]' && resolved.body.expectedRevisions["fact-dup-gate-1"] === 2 && resolved.body.expectedRevisions["fact-dup-gate-2"] === 2, JSON.stringify(resolved));
    await desktop.waitForFunction(() => !document.querySelector('[data-campaign-wiki-duplicate-group="dup-gate"]'), undefined, WAIT);
    record("a resolved group leaves the list", true);

    await mock(desktop, () => { window.__wikiMock.reviewConflictOnce = true; });
    await group(desktop, "dup-occupation").getByRole("button", { name: /Keep selected, retire 1/ }).click();
    await group(desktop, "dup-occupation").getByRole("alert").waitFor(WAIT);
    const conflict = await group(desktop, "dup-occupation").getByRole("alert").innerText();
    record("a revision conflict asks for a reload", /changed since they were loaded/.test(conflict), conflict);
    await group(desktop, "dup-occupation").getByRole("button", { name: "Reload", exact: true }).click();
    await desktop.waitForTimeout(400);
    await group(desktop, "dup-occupation").getByRole("button", { name: /Keep selected, retire 1/ }).click();
    await desktop.waitForFunction(() => !document.querySelector('[data-campaign-wiki-duplicate-group="dup-occupation"]'), undefined, WAIT);
    const retried = await mock(desktop, () => window.__wikiMock.reviewResolves.at(-1));
    record("after reload the resolve sends the new revisions", retried?.status === 200 && retried.body.expectedRevisions["fact-dup-occ-1"] === 3, JSON.stringify(retried?.body));

    await mock(desktop, () => { window.__wikiMock.reviewCrossSessionOnce = true; });
    await group(desktop, "dup-ferry").getByRole("button", { name: /Keep selected, retire 2/ }).click();
    await group(desktop, "dup-ferry").getByRole("alert").waitFor(WAIT);
    const cross = await group(desktop, "dup-ferry").getByRole("alert").innerText();
    const crossRequest = await mock(desktop, () => window.__wikiMock.reviewResolves.at(-1));
    record("a cross-session refusal shows the lead and the server's reason, no reload", cross.includes("Not saved: this change points at a record from another session.") && cross.includes("Add it there first") && !/Reload/.test(cross), cross);
    record("an older session's group resolves in that session's chat", crossRequest?.chatId === "chat-session-1", JSON.stringify(crossRequest));
    await shot(desktop, "review-desktop-cross-session-viewport");

    await group(desktop, "dup-ferry").getByRole("button", { name: "Skip", exact: true }).click();
    await desktop.getByText("1 skipped", { exact: true }).waitFor(WAIT);
    record("skip hides a group for now", (await desktop.locator("[data-campaign-wiki-duplicate-group]").count()) === 0);
    await desktop.getByRole("button", { name: "Show again", exact: true }).click();
    await group(desktop, "dup-ferry").waitFor(WAIT);
    record("skipped groups come back on request", true);
  });

  await step("desktop review empty", async () => {
    await openReview(desktop, "?review=none");
    await desktop.getByText("No duplicates to review", { exact: true }).waitFor(WAIT);
    record("no groups: calm empty state", true);
  });

  await step("desktop canon", async () => {
    await openCanon(desktop);
    await desktop.locator('[data-campaign-wiki-canon-group="entity-1"]').waitFor(WAIT);
    const canon = desktop.locator("[data-campaign-wiki-canon]");
    const text = await canon.innerText();
    const groups = await canon.locator("[data-campaign-wiki-canon-group]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-campaign-wiki-canon-group")));
    record("canon groups pinned facts by page", JSON.stringify(groups) === '["entity-0","entity-1"]' && text.includes("Ariadne Vale") && text.includes("Location 1") && !RAW.test(text), JSON.stringify(groups));
    record("canon lists every pinned fact with its session", text.includes("Ariadne is the last sworn archivist of the north.") && text.includes("The ferryman never crosses after dark.") && /S1/.test(text) && /S3/.test(text), text.slice(0, 400).replace(/\s+/g, " "));
    await shot(desktop, "canon-desktop-viewport");
    record("canon no horizontal overflow (desktop)", await noOverflow(desktop));
    await canon.locator('[data-campaign-wiki-canon-fact="fact-canon-ferry"]').getByRole("button", { name: "Unpin", exact: true }).click();
    await desktop.waitForFunction(() => !document.querySelector('[data-campaign-wiki-canon-fact="fact-canon-ferry"]'), undefined, WAIT);
    const ferry = await mock(desktop, () => window.__wikiMock.sessionMutations.at(-1));
    record("unpin writes to the fact's own session", ferry?.chatId === "chat-session-1" && ferry.body.recordId === "fact-canon-ferry" && ferry.body.patch.value.pinned === false && ferry.body.patch.manualLock === false && ferry.body.expectedRevision === 3, JSON.stringify(ferry));
    await canon.locator('[data-campaign-wiki-canon-fact="fact-canon-toll"]').getByRole("button", { name: "Unpin", exact: true }).click();
    await desktop.waitForFunction(() => !document.querySelector('[data-campaign-wiki-canon-fact="fact-canon-toll"]'), undefined, WAIT);
    const toll = await mock(desktop, () => window.__wikiMock.sessionMutations.at(-1));
    record("unpin keeps an earlier hand lock", toll?.body.patch.manualLock === true && toll.body.patch.value.lockedBeforePin === undefined, JSON.stringify(toll?.body.patch));
    await canon.locator('[data-campaign-wiki-canon-group="entity-0"]').getByRole("button", { name: /Ariadne Vale/ }).click();
    await desktop.locator('[data-component="campaign-wiki-article"]').waitFor(WAIT);
    record("a canon page heading opens the page", (await desktop.locator('[data-component="campaign-wiki-article"] h2').first().innerText()).trim() === "Ariadne Vale");
  });

  await step("older server", async () => {
    await openCanon(desktop, "?review=legacy");
    await desktop.getByText("Canon needs a server update", { exact: true }).waitFor(WAIT);
    record("canon without the facts route says it needs a server update", true);
    const detailFetches = await desktop.evaluate(() => performance.getEntriesByType("resource").filter((entry) => /\/memory\/entities\/[^/?]+\?/.test(entry.name)).length);
    record("canon never walks every page on an older server", detailFetches < 5, `detail requests=${detailFetches}`);
    await shot(desktop, "canon-legacy-desktop-viewport");
    await openReview(desktop, "?review=legacy");
    await desktop.getByText("Duplicate review needs a server update", { exact: true }).waitFor(WAIT);
    record("review without the route says it needs a server update", true);
    record("no badge without the route", (await desktop.locator("[data-campaign-wiki-review-badge]").count()) === 0);
  });

  await step("desktop what links here", async () => {
    await desktop.goto(base);
    await desktop.locator("[data-campaign-wiki-entity-list]").getByRole("button", { name: /Ariadne Vale/ }).click();
    const links = desktop.locator("[data-campaign-wiki-links-here]");
    await links.waitFor(WAIT);
    await links.getByText(/12 events/).waitFor(WAIT);
    const text = await links.innerText();
    const kinds = await links.locator("[data-campaign-wiki-links-kind]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-campaign-wiki-links-kind")));
    record("links here groups linking pages by kind", JSON.stringify(kinds) === '["character","location","item"]', JSON.stringify(kinds));
    record("links here says why each page links", /Character 3/.test(text) && /2 shared events/.test(text) && /Location 1/.test(text) && /Allied with/.test(text) && !RAW.test(text), text.replace(/\s+/g, " "));
    await links.scrollIntoViewIfNeeded();
    await shot(desktop, "links-here-desktop-viewport");
    await links.getByRole("button", { name: /Character 3/ }).click();
    await desktop.waitForFunction(() => document.querySelector('[data-component="campaign-wiki-article"] h2')?.textContent?.trim() === "Character 3", undefined, WAIT);
    record("a linking page opens on click", true);
    await desktop.goto(`${base}?review=legacy`);
    await desktop.locator("[data-campaign-wiki-entity-list]").getByRole("button", { name: /Ariadne Vale/ }).click();
    await desktop.locator("[data-campaign-wiki-links-here]").waitFor(WAIT);
    record("links here still lists pages without the references route", (await desktop.locator("[data-campaign-wiki-links-here]").innerText()).includes("Character 3"));
  });
  await desktop.close();

  const mobile = await browser.newPage({ viewport: VIEWPORTS.mobileNarrow, isMobile: true, hasTouch: true });
  await step("mobile 390 review", async () => {
    await openReview(mobile);
    await mobile.locator('[data-campaign-wiki-duplicate-option="keep"]').nth(2).waitFor(WAIT);
    await shot(mobile, "review-mobile-viewport-390x844");
    await shot(mobile, "review-mobile-390x844", true);
    record("mobile review no horizontal overflow", await noOverflow(mobile));
    const button = await group(mobile, "dup-gate").getByRole("button", { name: /Keep selected/ }).boundingBox();
    record("mobile resolve button is reachable", Boolean(button && button.x >= 0 && button.x + button.width <= 390 && button.height >= 36), JSON.stringify(button));
  });
  await step("mobile 390 canon", async () => {
    await openCanon(mobile);
    await mobile.locator('[data-campaign-wiki-canon-group="entity-1"]').waitFor(WAIT);
    await shot(mobile, "canon-mobile-viewport-390x844");
    record("mobile canon no horizontal overflow", await noOverflow(mobile));
    const unpin = await mobile.locator('[data-campaign-wiki-canon-fact="fact-5"]').getByRole("button", { name: "Unpin", exact: true }).boundingBox();
    record("mobile unpin is reachable", Boolean(unpin && unpin.x >= 0 && unpin.x + unpin.width <= 390), JSON.stringify(unpin));
  });
  await step("mobile 390 links here", async () => {
    await mobile.goto(base);
    await mobile.locator("[data-campaign-wiki-entity-list]").getByRole("button", { name: /Ariadne Vale/ }).click();
    const links = mobile.locator("[data-campaign-wiki-links-here]");
    await links.waitFor(WAIT);
    await links.getByText(/12 events/).waitFor(WAIT);
    await links.scrollIntoViewIfNeeded();
    await shot(mobile, "links-here-mobile-viewport-390x844");
    record("mobile links here no horizontal overflow", await noOverflow(mobile));
  });
  await mobile.close();

  const output = { generatedAt: new Date().toISOString(), base, viewports: [VIEWPORTS.desktop, VIEWPORTS.mobileNarrow], checks, pass: checks.every((item) => item.pass), screenshots, note: "Fixture-only API responses (window.fetch mock); no production server, database, or provider calls." };
  await fs.writeFile(path.join(out, "review-canon-results.json"), JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
  if (!output.pass) process.exitCode = 1;
} catch (error) { console.error(error); await fs.writeFile(path.join(out, "review-canon-error.txt"), String(error?.stack ?? error)); process.exitCode = 1; }
finally { await browser.close(); await stopFixtureServer(server); }
