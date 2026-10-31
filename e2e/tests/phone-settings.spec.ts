import { expect, test } from "@playwright/test";
import { openApp, openSettings, send } from "./helpers";

test("Settings → Phone makes, replaces and turns off the phone link", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openApp(page);
  await openSettings(page);
  await page.getByTestId("settings-phone").click();
  const settings = page.getByTestId("phone-settings");
  await expect(settings).toContainText("Text Yo from your own phone.");
  await expect(page.getByTestId("phone-status")).toHaveText("No phone link yet.");
  await expect(page.getByTestId("phone-link")).toHaveCount(0);

  await page.getByTestId("phone-create").click();
  const link = page.getByTestId("phone-link");
  await expect(link).toHaveValue(
    /^https:\/\/yo-phone\.vercel\.app\/#k=[A-Za-z0-9_-]{43}&a=[A-Za-z0-9_-]{43}&p=[A-Za-z0-9_-]{43}$/,
  );
  await expect(page.getByTestId("phone-status")).toHaveText("Link ready — waiting for the phone");
  await expect(page.getByTestId("phone-warning")).toHaveText(
    "This link is your Yo in your pocket. Keep it to yourself: anyone with it can talk to Yo as you, including your chats, files and approvals. Turn it off anytime.",
  );
  const first = await link.inputValue();
  await page.getByTestId("phone-copy").click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(first);

  // The pretend phone opens the link.
  await expect(page.getByTestId("phone-status")).toContainText("Connected · last seen", { timeout: 10_000 });

  // A new link asks first, then replaces the old one.
  await page.getByTestId("phone-new-link").click();
  await expect(settings).toContainText("The old link will stop working.");
  await page.getByTestId("phone-new-link-confirm").click();
  await expect(link).not.toHaveValue(first);
  await expect(page.getByTestId("phone-status")).toHaveText("Link ready — waiting for the phone");

  await page.getByTestId("phone-off").click();
  await page.getByTestId("phone-off-confirm").click();
  await expect(page.getByTestId("phone-status")).toHaveText("No phone link yet.");
  await expect(page.getByTestId("phone-link")).toHaveCount(0);
});

test("Settings → Phone shows the link as a QR code only when asked", async ({ page }) => {
  await openApp(page);
  await openSettings(page);
  await page.getByTestId("settings-phone").click();
  await expect(page.getByTestId("phone-qr-toggle")).toHaveCount(0);
  await page.getByTestId("phone-create").click();
  await expect(page.getByTestId("phone-link")).toHaveValue(/#k=/);

  // Hidden by default: the code is the secret on screen.
  const toggle = page.getByTestId("phone-qr-toggle");
  const qr = page.getByTestId("phone-qr");
  await expect(toggle).toHaveText("Show QR code");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(qr).toHaveCount(0);

  await toggle.click();
  await expect(qr).toContainText("Scan with the Yo app or your iPhone Camera.");
  await expect(toggle).toHaveText("Hide");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const code = page.getByTestId("phone-qr-code");
  await expect(code).toHaveAttribute("role", "img");
  // A 166-character link is a version 9 code (53 modules) plus a 4-module quiet zone on each side.
  await expect(code).toHaveAttribute("viewBox", "0 0 61 61");
  await expect(code.locator("rect")).toHaveAttribute("fill", "#fff");
  await expect(code.locator("path")).toHaveAttribute("fill", "#000");
  const box = await code.boundingBox();
  expect(box?.width).toBe(192);
  await expect(page.getByTestId("phone-warning")).toBeVisible();

  await toggle.click();
  await expect(qr).toHaveCount(0);

  // A new link hides it again.
  await toggle.click();
  const before = await code.locator("path").getAttribute("d");
  await page.getByTestId("phone-new-link").click();
  await page.getByTestId("phone-new-link-confirm").click();
  await expect(page.getByTestId("phone-status")).toHaveText("Link ready — waiting for the phone");
  await expect(qr).toHaveCount(0);
  await expect(toggle).toHaveText("Show QR code");
  await toggle.click();
  expect(await code.locator("path").getAttribute("d")).not.toBe(before);

  // So does leaving the section.
  await page.getByTestId("settings-appearance").click();
  await page.getByTestId("settings-phone").click();
  await expect(page.getByTestId("phone-link")).toHaveValue(/#k=/);
  await expect(qr).toHaveCount(0);
});

test("Settings → Phone without Yo's relay key says it's coming soon, with no commands to run", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.removeItem("yo.ui"));
  await page.goto("/?mock=1&fast=1&onboarded=1&mockPhone=nokey");
  await expect(page.getByTestId("sidebar")).toBeVisible();
  await openSettings(page);
  await page.getByTestId("settings-phone").click();
  const settings = page.getByTestId("phone-settings");
  await expect(settings).toContainText("Coming soon");
  await expect(page.getByTestId("phone-key-missing")).toContainText("isn't open to everyone yet");
  await expect(settings).not.toContainText(/yo-ops|relay key/i);
  // Nothing to click that can't work: no link button and no "Let Yo do it" prompt.
  await expect(page.getByTestId("phone-create")).toHaveCount(0);
  await expect(page.getByTestId("phone-ask-yo")).toHaveCount(0);
});

test("Settings → Phone: a ready-made prompt for Yo, and how it works", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openApp(page);
  await openSettings(page);
  await page.getByTestId("settings-phone").click();
  await expect(page.getByTestId("phone-prompt")).toHaveText("Set up Yo Phone on my phone.");
  await page.getByTestId("phone-prompt-copy").click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("Set up Yo Phone on my phone.");
  // No "for a friend" framing anywhere.
  await expect(page.getByTestId("phone-settings")).not.toContainText(/friend|people you trust/i);
  const how = page.getByTestId("phone-how");
  await expect(how.locator("ol")).toHaveCount(0);
  await page.getByTestId("phone-how-toggle").click();
  await expect(how.locator("ol li")).toHaveCount(5);
  await expect(how).toContainText("end-to-end encrypted");
  await expect(how).toContainText("whoever has it talks to Yo as you");
  await expect(how).not.toContainText("only sees their own conversation");
});

test("asking Yo for a phone link shows an approval card first", async ({ page }) => {
  await openApp(page);
  await send(page, "Set up Yo Phone on my phone.");
  const card = page.getByTestId("approval-card");
  await expect(card).toContainText("Create a phone link for your phone?", { timeout: 15_000 });
  await expect(card).toContainText(
    "Anyone with the link can talk to Yo as you. A new link turns off the old one.",
  );
  // One at a time: no "Always allow".
  await expect(card.getByRole("button", { name: "Always allow" })).toHaveCount(0);
  await card.getByTestId("approve-once").click();
  // The link never goes into the chat: it's in Settings → Phone.
  const reply = page.getByTestId("assistant-message").last();
  await expect(reply).toContainText("Your phone link is in Settings → Phone", { timeout: 15_000 });
  await expect(page.getByTestId("timeline")).not.toContainText("#k=");
  await openSettings(page);
  await page.getByTestId("settings-phone").click();
  await expect(page.getByTestId("phone-link")).toHaveValue(/#k=/);
});

test("Settings → Phone says when wiping the old link is still being retried", async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem("yo.ui"));
  await page.goto("/?mock=1&fast=1&onboarded=1&mockPhone=revoking");
  await expect(page.getByTestId("sidebar")).toBeVisible();
  await openSettings(page);
  await page.getByTestId("settings-phone").click();
  await expect(page.getByTestId("phone-revoke-pending")).toHaveText(
    "Couldn't turn off the old link yet. Retrying.",
  );
});
