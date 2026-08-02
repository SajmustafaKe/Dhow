import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// WorkDir is resolved at module load, so each test gets a fresh temp workdir
// via DHOW_WORKDIR + resetModules + dynamic import (same pattern as
// config/app_version.test.ts).
let tmpDir: string;

async function loadRepo() {
  const mod = await import("./repo.js");
  return mod;
}

/** Seed oauth.json with a raw on-disk payload of any schema version. */
async function seedConfig(payload: unknown): Promise<void> {
  await fs.mkdir(path.join(tmpDir, "config"), { recursive: true });
  await fs.writeFile(path.join(tmpDir, "config", "oauth.json"), JSON.stringify(payload, null, 2));
}

async function readRawConfig(): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(path.join(tmpDir, "config", "oauth.json"), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

const TOKENS = {
  access_token: "at-1",
  refresh_token: "rt-1",
  expires_at: 4102444800000,
  token_type: "Bearer" as const,
  scopes: ["https://www.googleapis.com/auth/gmail.modify"],
};

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dhow-oauth-repo-test-"));
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
  vi.doUnmock("../knowledge/version_history.js");
  vi.doUnmock("../knowledge/deprecate_today_note.js");
  vi.resetModules();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("FSOAuthRepo migration", () => {
  // The upgrade path people actually walk: an existing single-account install.
  // Losing the grant here means a user silently loses their connected mailbox.
  it("lifts a v2 connection into an account without losing the grant or the app registration", async () => {
    await seedConfig({
      version: 2,
      providers: {
        google: { tokens: TOKENS, clientId: "cid", clientSecret: "csec", mode: "byok" },
      },
    });

    const { FSOAuthRepo, LEGACY_ACCOUNT_ID, CONFIG_VERSION } = await loadRepo();
    const repo = new FSOAuthRepo();

    const provider = await repo.read("google");
    expect(provider.clientId).toBe("cid");
    expect(provider.clientSecret).toBe("csec");
    expect(provider.mode).toBe("byok");

    // The single implied connection becomes one account, and is primary.
    expect(await repo.listAccounts("google")).toEqual([LEGACY_ACCOUNT_ID]);
    expect(await repo.getPrimaryAccountId("google")).toBe(LEGACY_ACCOUNT_ID);
    expect((await repo.readAccount("google", LEGACY_ACCOUNT_ID)).tokens).toEqual(TOKENS);

    // Migration is persisted, not recomputed on every read.
    expect((await readRawConfig()).version).toBe(CONFIG_VERSION);
  });

  it("lifts a bare v1 provider-to-tokens map through to v3", async () => {
    await seedConfig({ google: TOKENS });

    const { FSOAuthRepo, LEGACY_ACCOUNT_ID } = await loadRepo();
    const repo = new FSOAuthRepo();

    expect((await repo.readAccount("google", LEGACY_ACCOUNT_ID)).tokens).toEqual(TOKENS);
    expect(await repo.getPrimaryAccountId("google")).toBe(LEGACY_ACCOUNT_ID);
  });

  // A registration with no grant is "set up but never authorized" — inventing
  // an account for it would show the user a connected mailbox that isn't.
  it("creates no account for a provider registered but never authorized", async () => {
    await seedConfig({
      version: 2,
      providers: { google: { clientId: "cid", clientSecret: "csec" } },
    });

    const { FSOAuthRepo } = await loadRepo();
    const repo = new FSOAuthRepo();

    expect(await repo.listAccounts("google")).toEqual([]);
    expect(await repo.getPrimaryAccountId("google")).toBeNull();
    expect((await repo.read("google")).clientId).toBe("cid");
  });

  it("leaves an already-current config untouched", async () => {
    await seedConfig({
      version: 3,
      providers: {
        google: {
          clientId: "cid",
          accounts: { "sub-123": { tokens: TOKENS, email: "a@b.com" } },
          primaryAccountId: "sub-123",
        },
      },
    });

    const { FSOAuthRepo } = await loadRepo();
    const repo = new FSOAuthRepo();

    expect(await repo.listAccounts("google")).toEqual(["sub-123"]);
    expect((await repo.readAccount("google", "sub-123")).email).toBe("a@b.com");
  });
});

describe("FSOAuthRepo accounts", () => {
  it("keeps accounts independent so connecting a second mailbox preserves the first", async () => {
    const { FSOAuthRepo } = await loadRepo();
    const repo = new FSOAuthRepo();

    await repo.upsert("google", { clientId: "cid", clientSecret: "csec" });
    await repo.upsertAccount("google", "sub-a", { tokens: TOKENS, email: "a@x.com" });
    await repo.upsertAccount("google", "sub-b", { tokens: TOKENS, email: "b@x.com" });

    expect(await repo.listAccounts("google")).toEqual(["sub-a", "sub-b"]);
    expect((await repo.readAccount("google", "sub-a")).email).toBe("a@x.com");
    // First one in stays primary — adding an account must not silently
    // repoint Calendar/Docs at the new mailbox.
    expect(await repo.getPrimaryAccountId("google")).toBe("sub-a");
  });

  // Guards the `accounts: existing.accounts` spread in upsert(). The type
  // already excludes `accounts`, so the hazard this defends is the runtime
  // one: reading a provider record, changing a field, and writing the whole
  // object back — a stale `accounts` in that payload would erase live grants.
  it("cannot clobber grants when a whole provider record is written back", async () => {
    const { FSOAuthRepo } = await loadRepo();
    const repo = new FSOAuthRepo();

    await repo.upsertAccount("google", "sub-a", { tokens: TOKENS });

    const stale = await repo.read("google");
    await repo.upsertAccount("google", "sub-b", { tokens: TOKENS });
    // `stale` predates sub-b; writing it back must not roll the accounts map
    // back to its earlier state.
    await repo.upsert("google", { ...stale, clientId: "new-cid" } as Parameters<typeof repo.upsert>[1]);

    expect(await repo.listAccounts("google")).toEqual(["sub-a", "sub-b"]);
    expect((await repo.readAccount("google", "sub-b")).tokens).toEqual(TOKENS);
    expect((await repo.read("google")).clientId).toBe("new-cid");
  });

  it("promotes a surviving account when the primary is disconnected", async () => {
    const { FSOAuthRepo } = await loadRepo();
    const repo = new FSOAuthRepo();

    await repo.upsertAccount("google", "sub-a", { tokens: TOKENS });
    await repo.upsertAccount("google", "sub-b", { tokens: TOKENS });
    await repo.deleteAccount("google", "sub-a");

    // A dangling primary would break every account-less caller.
    expect(await repo.getPrimaryAccountId("google")).toBe("sub-b");
    expect(await repo.listAccounts("google")).toEqual(["sub-b"]);
  });

  it("retains the app registration after the last account is disconnected", async () => {
    const { FSOAuthRepo } = await loadRepo();
    const repo = new FSOAuthRepo();

    await repo.upsert("google", { clientId: "cid", clientSecret: "csec" });
    await repo.upsertAccount("google", "sub-a", { tokens: TOKENS });
    await repo.deleteAccount("google", "sub-a");

    expect(await repo.getPrimaryAccountId("google")).toBeNull();
    // Re-entering client id/secret to reconnect would be gratuitous.
    expect((await repo.read("google")).clientId).toBe("cid");
  });

  it("reports per-account state to the client", async () => {
    const { FSOAuthRepo } = await loadRepo();
    const repo = new FSOAuthRepo();

    await repo.upsert("google", { clientId: "cid" });
    await repo.upsertAccount("google", "sub-a", { tokens: TOKENS, email: "a@x.com" });
    await repo.upsertAccount("google", "sub-b", { email: "b@x.com", error: "Please reconnect." });

    const cfg = await repo.getClientFacingConfig();
    expect(cfg.google.connected).toBe(true);
    expect(cfg.google.primaryAccountId).toBe("sub-a");
    expect(cfg.google.accounts).toEqual([
      { id: "sub-a", email: "a@x.com", connected: true, error: null },
      { id: "sub-b", email: "b@x.com", connected: false, error: "Please reconnect." },
    ]);
  });
});
