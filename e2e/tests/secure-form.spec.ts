import { expect, test } from "@playwright/test";
import { openApp, send } from "./helpers";

const CODE = "582014";

test("a secure form takes a code, then only says Submitted", async ({ page }) => {
  await openApp(page);
  await send(page, "Sign me in to Uber Eats");
  const card = page.getByTestId("secure-form-card");
  await expect(card).toContainText("Secure form");
  await expect(card.getByTestId("secure-form-ask")).toHaveText(
    "Yo is asking you to type this into the page on auth.uber.com.",
  );
  await expect(card.getByTestId("secure-form-reason")).toContainText("Uber texted a code to sign you in.");
  await expect(card.getByTestId("secure-form-ask")).not.toContainText("texted");
  await expect(card.getByTestId("secure-form-caution")).toHaveCount(0);
  await expect(card).toContainText("Yo never sees it.");

  // A code field: the number pad and the phone's "from Messages" suggestion.
  const input = card.getByLabel("Code from the text message");
  await expect(input).toHaveAttribute("inputmode", "numeric");
  await expect(input).toHaveAttribute("autocomplete", "one-time-code");
  await expect(card.getByTestId("secure-form-submit")).toBeDisabled();
  await input.fill(CODE);
  await card.getByTestId("secure-form-submit").click();

  await expect(page.getByTestId("secure-form-result")).toHaveText("Submitted");
  await expect(page.getByTestId("secure-form-card")).toHaveCount(0);
  await expect(page.getByText("I'm signed in to Uber Eats.")).toBeVisible();
  // The code isn't anywhere on the page, not even in a field.
  await expect(page.locator("body")).not.toContainText(CODE);
  const values = await page
    .locator("input, textarea")
    .evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value));
  expect(values.join(" ")).not.toContain(CODE);
});

test("cancelling a secure form says Cancelled", async ({ page }) => {
  await openApp(page);
  await send(page, "Order lunch on uber eats");
  const card = page.getByTestId("secure-form-card");
  await card.getByLabel("Code from the text message").fill("123");
  await card.getByTestId("secure-form-cancel").click();
  await expect(page.getByTestId("secure-form-result")).toHaveText("Cancelled");
  await expect(page.getByText("Okay, I didn't sign in to Uber Eats.")).toBeVisible();
});

test("a password form cautions, and keeps the agent's reason apart from the page", async ({ page }) => {
  await openApp(page);
  await send(page, "bank password");
  const card = page.getByTestId("secure-form-card");
  await expect(card.getByTestId("secure-form-ask")).toHaveText(
    "Yo is asking you to type this into the page on online.bank.example.",
  );
  await expect(card.getByTestId("secure-form-caution")).toContainText("online.bank.example");
  await expect(card.getByTestId("secure-form-caution")).toContainText("password");
  const reason = card.getByTestId("secure-form-reason");
  await expect(reason).toContainText("Yo says");
  await expect(reason).toContainText("GitHub security");
  await expect(card.getByTestId("secure-form-ask")).not.toContainText("GitHub");
  const input = card.getByLabel("GitHub password");
  await expect(input).toHaveAttribute("type", "password");
});

test("a fill that fails does not say Submitted", async ({ page }) => {
  await openApp(page);
  await send(page, "the code page failed");
  const card = page.getByTestId("secure-form-card");
  await card.getByLabel("Code from the text message").fill(CODE);
  await card.getByTestId("secure-form-submit").click();
  await expect(page.getByTestId("secure-form-result")).toHaveText("Couldn't fill the page");
  await expect(page.getByTestId("secure-form-result")).not.toHaveText("Submitted");
  await expect(page.getByText("Nothing was typed in and nothing was saved.")).toBeVisible();
  await expect(page.locator("body")).not.toContainText(CODE);
});
