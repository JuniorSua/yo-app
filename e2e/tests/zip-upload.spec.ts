import { expect, type Page, test } from "@playwright/test";
import { makeZip } from "../../apps/core/test/zipFixture";
import { openApp } from "./helpers";

const zip = makeZip([
  { name: "site/index.html", data: "<h1>hi</h1>" },
  { name: "site/app.js", data: "1" },
]);
const chips = (page: Page) => page.getByTestId("composer-attachment");

/** Drop or paste files on the message box, as the browser would (a DataTransfer built in the page). */
async function dispatchFiles(
  page: Page,
  how: "drop" | "paste",
  file: { name: string; type: string; b64: string },
) {
  await page.evaluate(
    ({ how, file }) => {
      const bytes = Uint8Array.from(atob(file.b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], file.name, { type: file.type }));
      if (how === "drop") {
        const el = document.querySelector('[data-testid="composer"]')!;
        el.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
      } else {
        const el = document.querySelector('[data-testid="composer-input"]')!;
        el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
      }
    },
    { how, file },
  );
}

test("A .zip attaches from the picker, drag and drop or paste as a file chip, and sends", async ({
  page,
}) => {
  await openApp(page);
  await expect(page.getByTestId("composer-input")).toHaveAttribute("placeholder", "Message Yo…");

  // The + picker.
  await page
    .getByTestId("composer")
    .locator('input[type="file"]')
    .setInputFiles({ name: "site.zip", mimeType: "application/zip", buffer: zip });
  await expect(page.getByTestId("composer")).toContainText("site.zip");
  if (process.env.ZIP_SHOT) await page.getByTestId("composer").screenshot({ path: process.env.ZIP_SHOT });
  await expect(chips(page)).toHaveCount(1);
  await expect(chips(page)).toContainText(`${zip.length} B`);
  // A file chip, not a picture preview.
  await expect(chips(page).locator("img")).toHaveCount(0);

  // Windows names it application/x-zip-compressed; some browsers give no type at all.
  await dispatchFiles(page, "drop", {
    name: "dropped.zip",
    type: "application/x-zip-compressed",
    b64: zip.toString("base64"),
  });
  await dispatchFiles(page, "paste", { name: "pasted.zip", type: "", b64: zip.toString("base64") });
  await expect(chips(page)).toHaveCount(3);
  await expect(chips(page).nth(1)).toContainText("dropped.zip");
  await expect(chips(page).nth(2)).toContainText("pasted.zip");

  await page.getByTestId("composer-input").fill("What's in these?");
  await page.getByTestId("composer-input").press("Enter");
  await expect(page.getByTestId("user-message").last()).toContainText("What's in these?");
  await expect(page.getByTestId("user-message").last()).toContainText("site.zip");
  await expect(chips(page)).toHaveCount(0);
  const sent = await page.evaluate(() => (window as any).__yoMock.sends.at(-1));
  expect(sent.attachments).toEqual([
    { name: "site.zip", mediaType: "application/zip" },
    { name: "dropped.zip", mediaType: "application/zip" },
    { name: "pasted.zip", mediaType: "application/zip" },
  ]);
});

test("A zip over the size limit is refused with a clear message", async ({ page }) => {
  await openApp(page);
  await expect(page.getByTestId("composer-input")).toHaveAttribute("placeholder", "Message Yo…");
  const big = Buffer.concat([zip, Buffer.alloc(21 * 1024 * 1024)]);
  await page
    .getByTestId("composer")
    .locator('input[type="file"]')
    .setInputFiles({ name: "huge.zip", mimeType: "application/zip", buffer: big });
  await expect(page.getByText(/huge\.zip is 21\.0 MB\. Zip files can be up to 20.0 MB\./)).toBeVisible();
  await expect(chips(page)).toHaveCount(0);
});
