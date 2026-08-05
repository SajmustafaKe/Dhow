/**
 * Data Mode encryption-key management for the main process.
 *
 * @x/core writes an encrypted DuckDB store per workspace, but it has no
 * Electron dependency, so the main process is responsible for protecting the
 * encryption key. safeStorage uses the OS keychain when available; if not
 * (Linux without a secret service), we fall back to a userData keyfile and
 * warn loudly so the user knows their at-rest encryption is weaker.
 */

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

const KEY_FILE_NAME = "dhow-data-key.enc";

export function getDataModeKeyPath(userDataPath: string): string {
    return path.join(userDataPath, KEY_FILE_NAME);
}

export type KeyStorageDeps = {
    userDataPath: string;
    isEncryptionAvailable: () => boolean;
    encrypt: (plaintext: string) => Buffer;
    decrypt: (encrypted: Buffer) => string;
};

/**
 * Platform-agnostic key init. The Electron-facing wrapper below passes OS
 * keychain functions; tests and headless probes pass a fake implementation.
 */
export async function initDataModeKeyWithDeps(deps: KeyStorageDeps): Promise<void> {
    const keyPath = path.join(deps.userDataPath, KEY_FILE_NAME);
    try {
        if (fs.existsSync(keyPath)) {
            const encrypted = fs.readFileSync(keyPath);
            process.env.DHOW_DATA_KEY = deps.decrypt(encrypted);
            return;
        }

        const key = randomBytes(32).toString("hex");
        if (deps.isEncryptionAvailable()) {
            fs.writeFileSync(keyPath, deps.encrypt(key));
        } else {
            console.warn(
                "[Data Mode] safeStorage unavailable; writing plaintext keyfile to",
                keyPath,
                "— at-rest encryption is weaker on this machine.",
            );
            fs.writeFileSync(keyPath, key);
        }
        process.env.DHOW_DATA_KEY = key;
    } catch (err) {
        console.error("[Data Mode] could not initialize encryption key:", err);
        // Leave DHOW_DATA_KEY unset. The engine will refuse to create an
        // encrypted store unless the user explicitly opts into unencrypted mode.
    }
}

/**
 * Resolve the path where the key is persisted. Requires an Electron app
 * context, so it is loaded lazily to keep the module importable in tests.
 */
async function resolveUserDataPath(): Promise<string> {
    const { app } = await import("electron");
    return app.getPath("userData");
}

/**
 * Seed `process.env.DHOW_DATA_KEY` from Electron safeStorage.
 *
 * If the env var is already set (dev override, tests) this is a no-op.
 * Otherwise it creates a persistent 256-bit key, encrypted by the OS keychain
 * when possible, and stores it in `app.getPath('userData')`.
 */
export async function initDataModeKey(): Promise<void> {
    if (process.env.DHOW_DATA_KEY) return;
    const { safeStorage } = await import("electron");
    await initDataModeKeyWithDeps({
        userDataPath: await resolveUserDataPath(),
        isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
        encrypt: (plaintext: string) => safeStorage.encryptString(plaintext),
        decrypt: (encrypted: Buffer) => safeStorage.decryptString(encrypted),
    });
}

/**
 * Forget the persisted key. Used by tests and by any future "reset Data Mode"
 * UI action. In an Electron context call without arguments; in tests pass the
 * userData path directly.
 */
export async function clearDataModeKey(userDataPath?: string): Promise<void> {
    delete process.env.DHOW_DATA_KEY;
    const dir = userDataPath ?? (await resolveUserDataPath());
    try {
        fs.unlinkSync(getDataModeKeyPath(dir));
    } catch {
        // ignore
    }
}
