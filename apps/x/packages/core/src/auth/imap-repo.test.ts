import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmpDir: string;

const workingCipher = {
  isAvailable: () => true,
  encrypt: (plain: string) => Buffer.from(plain, "utf8").toString("base64"),
  decrypt: (enc: string) => Buffer.from(enc, "base64").toString("utf8"),
};

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dhow-imap-repo-test-"));
  process.env.DHOW_WORKDIR = tmpDir;
  vi.resetModules();
  vi.doMock("../knowledge/version_history.js", () => ({
    commitAll: vi.fn(async () => undefined),
    initRepo: vi.fn(async () => undefined),
  }));
  vi.doMock("../knowledge/deprecate_today_note.js", () => ({
    deprecateTodayNote: vi.fn(async () => undefined),
  }));
});

afterEach(async () => {
  delete process.env.DHOW_WORKDIR;
  vi.resetModules();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function loadRepo(cipherAvailable = true) {
  const cipherMod = await import("./secret-cipher.js");
  cipherMod.setSecretCipher(
    cipherAvailable ? workingCipher : { isAvailable: () => false, encrypt: () => "x", decrypt: () => "x" },
  );
  const { FSImapRepo } = await import("./imap-repo.js");
  return new FSImapRepo();
}

const account = {
  id: "me-at-example",
  host: "imap.example.com",
  port: 993,
  secure: true,
  security: "ssl" as const,
  smtpHost: "smtp.example.com",
  smtpPort: 587,
  smtpSecurity: "starttls" as const,
  smtpUsername: null,
  username: "me@example.com",
  email: "me@example.com",
  error: null,
};

describe("FSImapRepo", () => {
  it("never writes the password to disk in the clear", async () => {
    const repo = await loadRepo();
    await repo.upsert({ ...account, password: "app-password-123" });

    const raw = fsSync.readFileSync(path.join(tmpDir, "config", "imap.json"), "utf8");

    expect(raw).not.toContain("app-password-123");
    expect(raw).toContain("enc:v1:");
    // Still readable through the repo.
    expect((await repo.read(account.id))?.password).toBe("app-password-123");
  });

  // The settings form does not echo the stored secret back, so an empty field
  // is "I didn't change it", never "erase my password".
  it("keeps the existing password when an update omits it", async () => {
    const repo = await loadRepo();
    await repo.upsert({ ...account, password: "app-password-123" });

    await repo.upsert({ ...account, host: "imap2.example.com", password: undefined });

    const updated = await repo.read(account.id);
    expect(updated?.host).toBe("imap2.example.com");
    expect(updated?.password).toBe("app-password-123");
  });

  it("reports an unreadable password as null rather than as ciphertext", async () => {
    const repo = await loadRepo();
    await repo.upsert({ ...account, password: "app-password-123" });

    // Simulate the same vault opened on a machine with no keychain.
    vi.resetModules();
    const cipherMod = await import("./secret-cipher.js");
    cipherMod.setSecretCipher({ isAvailable: () => false, encrypt: () => "x", decrypt: () => "x" });
    const { FSImapRepo } = await import("./imap-repo.js");

    const reread = await new FSImapRepo().read(account.id);

    // Handing back the ciphertext would see it used as a password and read as
    // a wrong-password failure.
    expect(reread?.password).toBeNull();
    expect(reread?.host).toBe("imap.example.com");
  });

  it("stores plaintext when no keychain exists, and still reads it back", async () => {
    const repo = await loadRepo(false);
    await repo.upsert({ ...account, password: "app-password-123" });

    expect((await repo.read(account.id))?.password).toBe("app-password-123");
  });

  it("keeps accounts independent", async () => {
    const repo = await loadRepo();
    await repo.upsert({ ...account, password: "one" });
    await repo.upsert({ ...account, id: "other", username: "other@example.com", password: "two" });

    expect((await repo.list()).map((a) => a.id).sort()).toEqual(["me-at-example", "other"]);
    await repo.delete("other");
    expect((await repo.list()).map((a) => a.id)).toEqual(["me-at-example"]);
    expect((await repo.read(account.id))?.password).toBe("one");
  });

  it("round-trips incoming and outgoing settings independently", async () => {
    const repo = await loadRepo();
    await repo.upsert({ ...account, password: "one" });

    const stored = await repo.read(account.id);
    // The two halves use different ports and different security modes; a
    // single boolean could not express either.
    expect(stored?.security).toBe("ssl");
    expect(stored?.port).toBe(993);
    expect(stored?.smtpHost).toBe("smtp.example.com");
    expect(stored?.smtpPort).toBe(587);
    expect(stored?.smtpSecurity).toBe("starttls");
  });

  it("treats a receive-only account as valid", async () => {
    const repo = await loadRepo();
    await repo.upsert({ ...account, smtpHost: null, smtpPort: null, password: "one" });

    const stored = await repo.read(account.id);
    // Syncing must not require an outgoing server; only replying does.
    expect(stored?.smtpHost).toBeNull();
    expect(stored?.host).toBe("imap.example.com");
  });

  it("records a sync error against one account without touching its credentials", async () => {
    const repo = await loadRepo();
    await repo.upsert({ ...account, password: "one" });

    await repo.setError(account.id, "Connection refused");

    const stored = await repo.read(account.id);
    expect(stored?.error).toBe("Connection refused");
    expect(stored?.password).toBe("one");
  });
});
