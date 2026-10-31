/**
 * What's new (from Grok Bot's late-October update): Pages the agent makes, pins in Make, the ⌘/ shortcuts
 * sheet and "> " quotes in your own messages. Saves light/dark screenshots to /tmp/yo-pages/ for the PR (outside
 * the repo, so nothing regenerated gets committed).
 */
import { mkdirSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { openApp, openWorkspacePage, send } from "./helpers";

const SHOTS = "/tmp/yo-pages";
mkdirSync(SHOTS, { recursive: true });
const shot = async (page: Page, theme: string, name: string) => {
  await page.waitForTimeout(600); // let entrance animations settle
  await page.screenshot({ path: `${SHOTS}/${theme}-${name}.png` });
};
const mod = process.platform === "darwin" ? "Meta" : "Control";

for (const theme of ["light", "dark"] as const) {
  test(`a Page shows in the chat, opens full size and can be pinned in Make (${theme})`, async ({ page }) => {
    await openApp(page, { theme });
    await send(page, "Visualize my posting activity on X by hour");

    const card = page.getByTestId("page-card");
    await expect(card).toBeVisible();
    await expect(card).toContainText("Posting activity by hour");
    await expect(card).toContainText("Page · kept in Make");
    // The preview is the page itself, sandboxed, and you can't click into it.
    const preview = card.getByTestId("page-preview");
    await expect(preview).toHaveAttribute("sandbox", "allow-scripts");
    await expect(preview).toHaveAttribute("tabindex", "-1");
    await expect(preview.contentFrame().locator("h1")).toHaveText("Posting activity by hour");
    await expect(page.getByText("7 pm", { exact: false }).first()).toBeVisible();
    await shot(page, theme, "01-page-card");

    // Open: the full page, with Pin, Download and Close.
    await card.getByRole("button", { name: "Open", exact: true }).click();
    const viewer = page.getByTestId("page-viewer");
    await expect(viewer).toBeVisible();
    const frame = viewer.getByTestId("page-frame");
    await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    await expect(frame.contentFrame().getByText("Best hour")).toBeVisible();
    await expect(viewer.getByRole("link", { name: "Download the page" })).toBeVisible();
    await shot(page, theme, "02-page-viewer");
    await viewer.getByTestId("pin-button").click();
    await expect(viewer.getByTestId("pin-button")).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Escape");
    await expect(viewer).toHaveCount(0);

    // Make: the pinned Page comes first, marked, with a Page label.
    await openWorkspacePage(page, "artifacts");
    const first = page.getByTestId("artifacts-grid").locator("> div").first();
    await expect(first).toHaveAttribute("data-kind", "page");
    await expect(first.getByTestId("pinned-badge")).toBeVisible();
    await expect(first).toContainText("Page");
    await shot(page, theme, "03-files-pinned");

    // Pin another file: the newest pin goes on top; unpinning drops it back to its place.
    const brief = page.locator('[data-record-id="art_1"]');
    await brief.getByTestId("pin-button").click();
    await expect(page.getByTestId("artifacts-grid").locator("> div").first()).toHaveAttribute(
      "data-record-id",
      "art_1",
    );
    await brief.getByTestId("pin-button").click();
    await expect(brief.getByTestId("pinned-badge")).toHaveCount(0);
    await expect(page.getByTestId("artifacts-grid").locator("> div").first()).toHaveAttribute(
      "data-kind",
      "page",
    );

    // Clicking a Page in Make opens it too.
    await first.getByRole("button", { name: /Open the page/ }).click();
    await expect(page.getByTestId("page-viewer")).toBeVisible();
  });

  test(`${"⌘"}/ lists every shortcut, and "> " lines show as a quote (${theme})`, async ({ page }) => {
    await openApp(page, { theme });
    await page.keyboard.press(`${mod}+Slash`);
    const sheet = page.getByTestId("shortcuts-dialog");
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText("Keyboard shortcuts");
    await expect(sheet).toContainText("Search and commands");
    await expect(sheet).toContainText("Start a quote");
    await shot(page, theme, "04-shortcuts");
    await page.keyboard.press(`${mod}+Slash`);
    await expect(sheet).toHaveCount(0);

    // The palette lists it as well.
    await page.keyboard.press(`${mod}+k`);
    await page.keyboard.type("shortcuts");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("shortcuts-dialog")).toBeVisible();
    await page.keyboard.press("Escape");

    await page.getByTestId("composer-input").fill("> Ship it Friday\n> and tell Sam\nWhat do you think?");
    await page.getByTestId("composer-input").press("Enter");
    const quote = page.getByTestId("user-quote").last();
    await expect(quote).toHaveText("Ship it Friday\nand tell Sam");
    await expect(quote.locator("xpath=..")).toContainText("What do you think?");
    await shot(page, theme, "05-quote");
  });
}
