/**
 * Where a picture in an agent's message should load from. Agents write Markdown like
 * `![Desk](/data/home/agents/<id>/shot.png)` or `![Desk](~/shot.png)`: paths on THEIR computer, which the
 * app fetches through core (confined to the agent's home by agentd). Web and data images pass through.
 */
export type ImageSource = { kind: "url"; url: string } | { kind: "computer"; path: string };

const RASTER = /\.(png|jpe?g|gif|webp)$/i;

export function chatImageSource(src: string | undefined): ImageSource | null {
  const s = (src ?? "").trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s) || /^data:image\/(png|jpe?g|gif|webp);/i.test(s))
    return { kind: "url", url: s };
  let p = s;
  if (/^file:\/\//i.test(p)) p = decodeURI(p.replace(/^file:\/\//i, ""));
  else if (/^[a-z][a-z0-9+.-]*:/i.test(p)) return null; // any other scheme (javascript:, blob:, …)
  p = p.split(/[?#]/)[0]!;
  return RASTER.test(p) ? { kind: "computer", path: p } : null;
}
