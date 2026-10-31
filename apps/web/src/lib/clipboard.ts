/** What copyText needs from the browser; tests pass their own. */
export interface ClipboardEnv {
  clipboard?: { writeText(text: string): Promise<void> } | undefined;
  document?: Document | undefined;
}

function browserEnv(): ClipboardEnv {
  return {
    clipboard: typeof navigator !== "undefined" ? navigator.clipboard : undefined,
    document: typeof document !== "undefined" ? document : undefined,
  };
}

/** The old way: select a hidden textarea and run the copy command (plain http, older webviews). */
function legacyCopy(text: string, doc: Document | undefined): boolean {
  if (!doc?.body) return false;
  const ta = doc.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.top = "0";
  ta.style.left = "0";
  ta.style.opacity = "0";
  doc.body.appendChild(ta);
  const prev = doc.activeElement as HTMLElement | null;
  try {
    ta.select();
    return doc.execCommand("copy");
  } catch {
    return false;
  } finally {
    ta.remove();
    prev?.focus?.();
  }
}

/** Copy text to the clipboard. Resolves to whether it worked. */
export async function copyText(text: string, env: ClipboardEnv = browserEnv()): Promise<boolean> {
  if (env.clipboard?.writeText) {
    try {
      await env.clipboard.writeText(text);
      return true;
    } catch {
      // Denied or unavailable (plain http): try the old way.
    }
  }
  return legacyCopy(text, env.document);
}

/** A picture as PNG: the one image type every clipboard takes (Safari and Chromium both write image/png). */
async function asPng(blob: Blob): Promise<Blob> {
  if (blob.type === "image/png") return blob;
  // An <img> decodes everything the chat can show (JPEG, WebP, GIF, SVG); createImageBitmap can't do SVG.
  const src = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = "async";
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("Couldn't read the picture"));
      img.src = src;
    });
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth || 1024;
    canvas.height = img.naturalHeight || 768;
    canvas.getContext("2d")?.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't convert the picture"))), "image/png"),
    );
  } finally {
    URL.revokeObjectURL(src);
  }
}

/**
 * Copy a picture (by URL) to the clipboard, so it can be pasted into another app. Resolves to whether it worked.
 * The PNG is passed as a promise so Safari keeps the click as the user gesture while the picture loads.
 */
export async function copyImage(url: string): Promise<boolean> {
  const Item = (globalThis as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
  const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
  if (!Item || !clipboard?.write) return false;
  const png = fetch(url, { credentials: "include" })
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.blob();
    })
    .then(asPng);
  try {
    await clipboard.write([new Item({ "image/png": png })]);
    return true;
  } catch {
    // Some engines want a ready Blob, not a promise.
    try {
      await clipboard.write([new Item({ "image/png": await png })]);
      return true;
    } catch {
      return false;
    }
  }
}
