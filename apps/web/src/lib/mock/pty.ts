import type { PtyConnection } from "../api";

const FS: Record<string, string[]> = {
  "~": ["Desktop/", "Documents/", "Downloads/", "Pictures/", "notes.md"],
  "~/Documents": ["standing-desks.md", "macbook-prices.csv", "lisbon-itinerary.pdf", "q4-goals.docx"],
  "~/Downloads": ["receipt-112-4471.pdf", "prices.csv"],
  "~/Pictures": ["desk-moodboard.png"],
  "~/Desktop": [],
};

const C = {
  green: "\x1b[38;2;78;203;113m",
  blue: "\x1b[38;2;96;165;250m",
  yellow: "\x1b[38;2;255;212;59m",
  dim: "\x1b[38;2;133;133;138m",
  reset: "\x1b[0m",
  bold: "\x1b[1m",
};

/** A tiny fake shell so the Terminal window is usable in mock mode. */
export function createMockPty(agentName: string): PtyConnection {
  const dataCbs = new Set<(d: string) => void>();
  const exitCbs = new Set<() => void>();
  let cwd = "~";
  let line = "";
  const history: string[] = [];
  const host = agentName.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "yo";
  const emit = (s: string) => {
    for (const cb of dataCbs) cb(s);
  };
  const prompt = () => emit(`${C.green}agent@${host}${C.reset}:${C.blue}${cwd}${C.reset}$ `);

  const run = (cmd: string) => {
    const [name, ...args] = cmd.trim().split(/\s+/);
    const out = (s: string) => emit(`${s.replace(/\n/g, "\r\n")}\r\n`);
    switch (name) {
      case undefined:
      case "":
        break;
      case "ls": {
        const target = args.find((a) => !a.startsWith("-"));
        const dir = target ? (target.startsWith("~") ? target : `${cwd}/${target}`).replace(/\/$/, "") : cwd;
        const items = FS[dir];
        if (!items) out(`ls: cannot access '${target}': No such file or directory`);
        else out(items.map((i) => (i.endsWith("/") ? `${C.blue}${C.bold}${i}${C.reset}` : i)).join("  "));
        break;
      }
      case "cd": {
        const t = args[0];
        if (!t || t === "~") cwd = "~";
        else if (t === "..") cwd = cwd === "~" ? "~" : cwd.split("/").slice(0, -1).join("/") || "~";
        else {
          const next = (t.startsWith("~") ? t : `${cwd}/${t}`).replace(/\/$/, "");
          if (FS[next]) cwd = next;
          else out(`cd: ${t}: No such file or directory`);
        }
        break;
      }
      case "pwd":
        out(cwd.replace("~", "/home/agent"));
        break;
      case "whoami":
        out("agent");
        break;
      case "uname":
        out(args.includes("-a") ? "Linux yo-computer 6.8.0 #1 SMP aarch64 GNU/Linux" : "Linux");
        break;
      case "echo":
        out(args.join(" "));
        break;
      case "date":
        out(new Date().toString());
        break;
      case "clear":
        emit("\x1b[2J\x1b[H");
        break;
      case "history":
        out(history.map((h, i) => `  ${i + 1}  ${h}`).join("\n"));
        break;
      case "cat":
        if (args[0]?.endsWith("notes.md"))
          out("# Notes\n- Book Lisbon dinner (Thu)\n- Price-watch MacBook Air");
        else out(`cat: ${args[0] ?? ""}: No such file or directory`);
        break;
      case "free":
        out("               total        used        free\nMem:           5.0Gi       1.8Gi       3.2Gi");
        break;
      case "exit":
        emit("logout\r\n");
        for (const cb of exitCbs) cb();
        return;
      default:
        out(`${name}: command not found ${C.dim}(mock terminal — try ls, cd, pwd, cat notes.md)${C.reset}`);
    }
    prompt();
  };

  setTimeout(() => {
    emit(
      `${C.yellow}●${C.reset} ${C.bold}${agentName}'s computer${C.reset} ${C.dim}· Debian · mock shell${C.reset}\r\n\r\n`,
    );
    prompt();
  }, 120);

  return {
    send(data: string) {
      for (const ch of data) {
        if (ch === "\r") {
          emit("\r\n");
          const cmd = line;
          line = "";
          if (cmd.trim()) history.push(cmd);
          if (!cmd.trim()) prompt();
          else run(cmd);
        } else if (ch === "\x7f") {
          if (line.length) {
            line = line.slice(0, -1);
            emit("\b \b");
          }
        } else if (ch === "\x03") {
          line = "";
          emit("^C\r\n");
          prompt();
        } else if (ch >= " ") {
          line += ch;
          emit(ch);
        }
      }
    },
    resize() {},
    onData(cb) {
      dataCbs.add(cb);
      return () => dataCbs.delete(cb);
    },
    onExit(cb) {
      exitCbs.add(cb);
      return () => exitCbs.delete(cb);
    },
    close() {
      dataCbs.clear();
      exitCbs.clear();
    },
  };
}
