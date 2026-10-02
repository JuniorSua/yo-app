import type { ApiResult } from "@yo/contracts";
import { ChevronRight, Download, File, Folder, House } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { fileSize, relTime } from "../../lib/utils";
import { Spinner } from "../ui/controls";

const HOME = "/home/agent";
type Entry = ApiResult<"computer.files">[number];

/** File browser for the agent's computer. Downloads use GET /api/files/:agentId?path=… */
export function FilesView({ agentId }: { agentId: string }) {
  const [path, setPath] = useState(HOME);
  const [items, setItems] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setItems(null);
    setError(null);
    api()
      .call("computer.files", { agentId, path })
      .then(
        (r) =>
          live &&
          setItems(
            [...r].sort((a, b) =>
              a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1,
            ),
          ),
      )
      .catch((e) => live && setError(String(e.message ?? e)));
    return () => {
      live = false;
    };
  }, [agentId, path]);

  const rel = path.startsWith(HOME) ? path.slice(HOME.length) : path;
  const crumbs = rel.split("/").filter(Boolean);

  return (
    <div className="absolute inset-0 flex flex-col" data-testid="files">
      <div className="flex h-9 shrink-0 items-center gap-1 border-white/[0.06] border-b px-3 text-sm">
        <button
          onClick={() => setPath(HOME)}
          className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[#bdbdc2] hover:bg-white/5 hover:text-white"
        >
          <House className="size-3.5" /> Home
        </button>
        {crumbs.map((c, i) => (
          <span key={i} className="flex items-center gap-1">
            <ChevronRight className="size-3 text-[#55565c]" />
            <button
              onClick={() => setPath(`${HOME}/${crumbs.slice(0, i + 1).join("/")}`)}
              className="rounded-md px-1.5 py-0.5 text-[#bdbdc2] hover:bg-white/5 hover:text-white"
            >
              {c}
            </button>
          </span>
        ))}
      </div>
      <div className="scroll-fade min-h-0 flex-1 overflow-y-auto p-1.5 [--scroll-fade:16px]">
        {!items && !error && (
          <div className="grid h-24 place-items-center text-[#85858a]">
            <Spinner />
          </div>
        )}
        {error && <div className="p-4 text-danger text-sm">{error}</div>}
        {items?.length === 0 && (
          <div className="p-6 text-center text-[#85858a] text-sm">This folder is empty</div>
        )}
        {items?.map((f) => (
          <div
            key={f.path}
            onDoubleClick={() => f.type === "dir" && setPath(f.path)}
            onClick={() => f.type === "dir" && setPath(f.path)}
            className="group flex h-9 items-center gap-3 rounded-lg px-2.5 text-sm hover:bg-white/[0.05]"
          >
            {f.type === "dir" ? (
              <Folder className="size-4 fill-[#60a5fa]/25 text-[#60a5fa]" />
            ) : (
              <File className="size-4 text-[#85858a]" />
            )}
            <span className="min-w-0 flex-1 truncate text-[#ececee]">{f.name}</span>
            <span className="w-16 text-right text-[#85858a] text-xs tabular-nums">
              {f.type === "file" ? fileSize(f.size) : ""}
            </span>
            <span className="w-12 text-right text-[#55565c] text-xs">{relTime(f.mtime)}</span>
            {f.type === "file" ? (
              <a
                href={api().fileUrl(agentId, f.path)}
                download={f.name}
                aria-label={`Download ${f.name}`}
                className="grid size-7 place-items-center rounded-md text-[#85858a] opacity-0 hover:bg-white/10 hover:text-white group-hover:opacity-100"
                onClick={(e) => e.stopPropagation()}
              >
                <Download className="size-3.5" />
              </a>
            ) : (
              <span className="size-7" />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
