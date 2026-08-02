import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// WorkDir resolves at module load, so each test gets a fresh temp vault via
// DHOW_WORKDIR + resetModules + dynamic import.
let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dhow-mail-migration-test-"));
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

/** Build the pre-migration vault: flat directories, one implied mailbox. */
async function seedLegacyVault(): Promise<void> {
  await fs.mkdir(path.join(tmpDir, "gmail_sync", "attachments"), { recursive: true });
  await fs.mkdir(path.join(tmpDir, "inbox_lists"), { recursive: true });
  await fs.mkdir(path.join(tmpDir, "search_index"), { recursive: true });
  await fs.writeFile(path.join(tmpDir, "gmail_sync", "t1.md"), "# Thread one");
  await fs.writeFile(path.join(tmpDir, "gmail_sync", "t2.md"), "# Thread two");
  await fs.writeFile(path.join(tmpDir, "gmail_sync", "sync_state.json"), '{"historyId":"12345"}');
  await fs.writeFile(path.join(tmpDir, "gmail_sync", "attachments", "a.pdf"), "PDF");
  await fs.writeFile(path.join(tmpDir, "inbox_lists", "t1.json"), '{"snapshot":{}}');
  await fs.writeFile(path.join(tmpDir, "search_index", "t9.json"), '{"snapshot":{}}');
}

async function loadMigration() {
  return import("./mail_migration.js");
}

const accountDir = () => path.join(tmpDir, "mail", "google", "default");

describe("migrateLegacyMailLayout", () => {
  it("moves every artifact under the account, preserving content", async () => {
    await seedLegacyVault();
    const { migrateLegacyMailLayout } = await loadMigration();

    const result = migrateLegacyMailLayout();
    expect(result.migrated).toBe(true);

    const root = accountDir();
    expect(fsSync.readFileSync(path.join(root, "threads", "t1.md"), "utf8")).toBe("# Thread one");
    expect(fsSync.readFileSync(path.join(root, "threads", "t2.md"), "utf8")).toBe("# Thread two");
    // historyId lives beside the account or incremental sync restarts cold.
    expect(fsSync.readFileSync(path.join(root, "sync_state.json"), "utf8")).toContain("12345");
    expect(fsSync.readFileSync(path.join(root, "cache", "t1.json"), "utf8")).toBe('{"snapshot":{}}');
    expect(fsSync.readFileSync(path.join(root, "attachments", "a.pdf"), "utf8")).toBe("PDF");
    expect(fsSync.readFileSync(path.join(root, "search_index", "t9.json"), "utf8")).toBe('{"snapshot":{}}');

    // Emptied legacy directories are cleaned up.
    expect(fsSync.existsSync(path.join(tmpDir, "gmail_sync"))).toBe(false);
    expect(fsSync.existsSync(path.join(tmpDir, "inbox_lists"))).toBe(false);
  });

  it("is a no-op on a fresh install", async () => {
    const { migrateLegacyMailLayout } = await loadMigration();

    const result = migrateLegacyMailLayout();
    expect(result).toEqual({ migrated: false, movedFiles: 0, skipped: 0 });
    // Must not conjure an empty account tree for someone who never synced.
    expect(fsSync.existsSync(path.join(tmpDir, "mail"))).toBe(false);
  });

  it("is idempotent — a second run moves nothing", async () => {
    await seedLegacyVault();
    const { migrateLegacyMailLayout } = await loadMigration();

    const first = migrateLegacyMailLayout();
    const second = migrateLegacyMailLayout();

    expect(first.movedFiles).toBeGreaterThan(0);
    expect(second).toEqual({ migrated: false, movedFiles: 0, skipped: 0 });
    expect(fsSync.readFileSync(path.join(accountDir(), "threads", "t1.md"), "utf8")).toBe("# Thread one");
  });

  // The destructive failure mode: a resumed migration must not overwrite data
  // that already made it across, or newer content is lost to a stale copy.
  it("never overwrites a file that already exists at the destination", async () => {
    await seedLegacyVault();
    const root = accountDir();
    await fs.mkdir(path.join(root, "threads"), { recursive: true });
    await fs.writeFile(path.join(root, "threads", "t1.md"), "# Newer content");

    const { migrateLegacyMailLayout } = await loadMigration();
    const result = migrateLegacyMailLayout();

    expect(fsSync.readFileSync(path.join(root, "threads", "t1.md"), "utf8")).toBe("# Newer content");
    expect(result.skipped).toBeGreaterThan(0);
    // The untouched sibling still migrates.
    expect(fsSync.readFileSync(path.join(root, "threads", "t2.md"), "utf8")).toBe("# Thread two");
  });

  it("keeps unrecognised files rather than deleting their directory", async () => {
    await seedLegacyVault();
    await fs.writeFile(path.join(tmpDir, "gmail_sync", "notes.txt"), "keep me");

    const { migrateLegacyMailLayout } = await loadMigration();
    migrateLegacyMailLayout();

    // Directory survives because it is not empty; the stray file is intact.
    expect(fsSync.readFileSync(path.join(tmpDir, "gmail_sync", "notes.txt"), "utf8")).toBe("keep me");
  });
});
