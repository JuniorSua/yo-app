import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

const SERVICE = "Yo";

/** macOS Keychain via the `security` CLI (generic passwords under service "Yo"). */
export class KeychainSecretStore implements SecretStore {
  private cache = new Map<string, string | null>();

  async get(key: string): Promise<string | null> {
    if (this.cache.has(key)) return this.cache.get(key) ?? null;
    try {
      const { stdout } = await run("security", ["find-generic-password", "-s", SERVICE, "-a", key, "-w"]);
      const v = stdout.replace(/\n$/, "");
      this.cache.set(key, v);
      return v;
    } catch {
      this.cache.set(key, null);
      return null;
    }
  }

  async set(key: string, value: string): Promise<void> {
    // -U updates if it exists. Value passed as argv is visible to `ps` briefly; acceptable for a local single-user app,
    // but prefer stdin-free approach: `security add-generic-password -w` requires the value as an argument.
    await run("security", [
      "add-generic-password",
      "-U",
      "-s",
      SERVICE,
      "-a",
      key,
      "-l",
      `Yo: ${key}`,
      "-w",
      value,
    ]);
    this.cache.set(key, value);
  }

  async delete(key: string): Promise<void> {
    try {
      await run("security", ["delete-generic-password", "-s", SERVICE, "-a", key]);
    } catch {
      /* not found */
    }
    this.cache.set(key, null);
  }
}

/** 0600 JSON file (Linux / remote host mode / tests). */
export class FileSecretStore implements SecretStore {
  constructor(private readonly file: string) {}

  private read(): Record<string, string> {
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      return {};
    }
  }

  private write(data: Record<string, string>) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  async get(key: string) {
    return this.read()[key] ?? null;
  }
  async set(key: string, value: string) {
    const d = this.read();
    d[key] = value;
    this.write(d);
  }
  async delete(key: string) {
    const d = this.read();
    delete d[key];
    this.write(d);
  }
}

export class MemorySecretStore implements SecretStore {
  private m = new Map<string, string>();
  async get(key: string) {
    return this.m.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.m.set(key, value);
  }
  async delete(key: string) {
    this.m.delete(key);
  }
}
