/**
 * Small encrypted JSON files in the app's data folder. Encryption uses Electron safeStorage, whose key
 * lives in the macOS Keychain, so a copied file is useless elsewhere.
 */
import fs from "node:fs";
import path from "node:path";
import { safeStorage } from "electron";

export class SecureFile<T> {
  constructor(private readonly file: string) {}

  read(): T | null {
    try {
      const raw = fs.readFileSync(this.file);
      return JSON.parse(safeStorage.decryptString(raw)) as T;
    } catch {
      return null;
    }
  }

  write(value: T) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("Keychain encryption isn't available");
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, safeStorage.encryptString(JSON.stringify(value)), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  remove() {
    fs.rmSync(this.file, { force: true });
  }
}
