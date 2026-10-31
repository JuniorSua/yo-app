/**
 * Make (the Duet refresh): everything Yo made, by kind, with filter chips; the + menu that opens the chat with a
 * line to finish; the kind on the chat's page card; and the warning on an approval whose message carries a card
 * number. Saves light/dark screenshots (desktop and phone) to /tmp/duet-shots/make/ (outside the repo).
 */
import { mkdirSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { openApp, send } from "./helpers";

const SHOTS = "/tmp/duet-shots/make";
mkdirSync(SHOTS, { recursive: true });
const shot = async (page: Page, name: string) => {
  await page.waitForTimeout(600); // let entrance animations (and the thumbnails) settle
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
};

const openMake = async (page: Page) => {
  await page.getByTestId("rail-make").click();
  await expect(page.getByRole("heading", { name: "Make", exact: true })).toBeVisible();
};

for (const theme of ["light", "dark"] as const) {
  test(`Make shows what Yo made by kind, and the + opens the chat with a line to finish (${theme})`, async ({
    page,
  }) => {
    await openApp(page, { theme });
    await openMake(page);
    await expect(page.getByText("What Yo made for you.")).toBeVisible();

    // All first, then a chip only for the kinds there are (no bug reports yet).
    const filters = page.getByTestId("make-filters");
    await expect(filters.getByRole("button")).toHaveText([
      "All",
      "Pages",
      "Dashboards",
      "Slides",
      "Docs",
      "Designs",
      "Files",
    ]);
    await expect(page.getByTestId("make-filter-all")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("make-filter-bug")).toHaveCount(0);
    const grid = page.getByTestId("artifacts-grid");
    const cards = grid.locator("> div");
    await expect(grid.locator('[data-make-kind="slides"]')).toContainText("Kyoto in five slides");
    await expect(grid.locator('[data-make-kind="slides"]')).toContainText("Slides ·");
    await expect(grid.locator('[data-make-kind="dashboard"]')).toContainText("Dashboard ·");
    await expect(grid.locator('[data-make-kind="doc"]').getByTestId("page-preview")).toBeVisible();
    await shot(page, `${theme}-01-make`);

    // One kind at a time.
    await page.getByTestId("make-filter-dashboard").click();
    await expect(page.getByTestId("make-filter-dashboard")).toHaveAttribute("aria-pressed", "true");
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText("Monthly budget at a glance");
    await page.getByTestId("make-filter-file").click();
    await expect(cards).toHaveCount(5);
    await expect(grid.locator('[data-kind="page"]')).toHaveCount(0);
    await shot(page, `${theme}-02-files`);
    await page.getByTestId("make-filter-all").click();
    await expect(cards).toHaveCount(10);

    // The +: what Yo can make. Escape folds it away.
    await page.getByTestId("make-fab").click();
    const menu = page.getByTestId("make-menu");
    await expect(menu.getByRole("button")).toHaveText(["Dashboard", "Slides", "Doc", "Web page", "Design"]);
    await shot(page, `${theme}-03-menu`);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);

    // Picking one opens the chat with its line in the message box, focused, the cursor at the end.
    await page.getByTestId("make-fab").click();
    await page.getByTestId("make-kind-slides").click();
    await expect(menu).toHaveCount(0);
    const input = page.getByTestId("composer-input");
    await expect(input).toHaveValue("Make a deck about ");
    await expect(input).toBeFocused();
    expect(await input.evaluate((el) => (el as HTMLTextAreaElement).selectionStart)).toBe(18);
    await page.keyboard.type("our spring garden");
    await shot(page, `${theme}-04-prefilled`);
    await page.keyboard.press("Enter");

    // The page card in the chat says what kind it is.
    const card = page.getByTestId("page-card");
    await expect(card).toContainText("Spring garden");
    await expect(card).toContainText("Slides · kept in Make");
    await shot(page, `${theme}-05-page-card`);

    // And it leads Make.
    await openMake(page);
    await expect(cards.first()).toHaveAttribute("data-make-kind", "slides");
    await expect(cards.first()).toContainText("Spring garden");
  });

  test(`an approval for a message with a card number in it warns first (${theme})`, async ({ page }) => {
    await openApp(page, { theme });
    await send(page, "Send my card to the hotel so they hold the room");
    const card = page.getByTestId("approval-card");
    await expect(card).toContainText("4242 4242 4242 4242");
    await expect(card.getByTestId("sensitive-warning")).toHaveText(
      "Before you allow this: it includes a card number ending 4242. Check that's meant to go out.",
    );
    // Allowed one at a time: no "Always allow" while something sensitive is in it.
    await expect(card.getByTestId("approve-always")).toHaveCount(0);
    await shot(page, `${theme}-06-sensitive-warning`);
    await card.getByTestId("approve-deny").click();
    await expect(page.getByText("Okay, I didn't send it.")).toBeVisible();
  });

  test(`Make on a phone: two columns, chips that scroll, the + above the tab bar (${theme})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openApp(page, { theme });
    await openMake(page);
    const cards = page.getByTestId("artifacts-grid").locator("> div");
    const [a, b, c] = await Promise.all([0, 1, 2].map(async (i) => (await cards.nth(i).boundingBox())!));
    expect(Math.abs(a!.y - b!.y)).toBeLessThan(2);
    expect(c!.y).toBeGreaterThan(a!.y + a!.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const id of ["make-filter-all", "make-fab"]) {
      expect((await page.getByTestId(id).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    const fab = (await page.getByTestId("make-fab").boundingBox())!;
    const bar = (await page.getByTestId("sidebar").boundingBox())!;
    expect(fab.y + fab.height).toBeLessThanOrEqual(bar.y);
    await shot(page, `${theme}-07-phone-make`);
    await page.getByTestId("make-fab").click();
    await expect(page.getByTestId("make-menu")).toBeVisible();
    await shot(page, `${theme}-08-phone-menu`);
    await page.getByTestId("make-kind-dashboard").click();
    await expect(page.getByTestId("composer-input")).toHaveValue("Make a dashboard of ");

    await page.getByTestId("composer-input").fill("Send my card to the hotel");
    await page.getByTestId("composer-input").press("Enter");
    await expect(page.getByTestId("sensitive-warning")).toBeVisible();
    await shot(page, `${theme}-09-phone-warning`);
  });
}
