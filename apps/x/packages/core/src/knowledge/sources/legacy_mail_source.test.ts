import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// WorkDir resolves at module load, so each test gets a fresh vault.
let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dhow-legacy-source-test-"));
  process.env.DHOW_WORKDIR = tmpDir;
  vi.resetModules();
  vi.doMock("../version_history.js", () => ({
    commitAll: vi.fn(async () => undefined),
    initRepo: vi.fn(async () => undefined),
  }));
  vi.doMock("../deprecate_today_note.js", () => ({
    deprecateTodayNote: vi.fn(async () => undefined),
  }));
});

afterEach(async () => {
  delete process.env.DHOW_WORKDIR;
  vi.resetModules();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeSourcesConfig(sources: unknown[]): Promise<void> {
  await fs.mkdir(path.join(tmpDir, "config"), { recursive: true });
  await fs.writeFile(
    path.join(tmpDir, "config", "knowledge_sources.json"),
    JSON.stringify({ sources }, null, 2),
  );
}

const LEGACY_MAIL_SOURCE = {
  id: "gmail",
  provider: "gmail",
  enabled: true,
  artifactDir: "gmail_sync",
  syncMode: "file",
  scopes: [],
};

describe("knowledge sources — legacy mail source", () => {
  // Caught by a smoke test: every pre-multi-account install has this entry
  // persisted, and leaving it in place keeps the graph pointed at a flat
  // directory nothing writes to any more (and recreates it on disk).
  it("retires the flat gmail source that existing installs still carry", async () => {
    await writeSourcesConfig([LEGACY_MAIL_SOURCE]);
    const { FSKnowledgeSourcesRepo } = await import("./repo.js");

    const sources = new FSKnowledgeSourcesRepo().getConfig().sources;

    expect(sources.find((s) => s.artifactDir === "gmail_sync")).toBeUndefined();
    expect(sources.find((s) => s.id === "gmail")).toBeUndefined();
  });

  it("derives one source per synced mailbox", async () => {
    await writeSourcesConfig([LEGACY_MAIL_SOURCE]);
    for (const account of ["default", "sub-b"]) {
      await fs.mkdir(path.join(tmpDir, "mail", "google", account, "threads"), { recursive: true });
    }
    const { FSKnowledgeSourcesRepo } = await import("./repo.js");

    const sources = new FSKnowledgeSourcesRepo().getConfig().sources;
    const mail = sources.filter((s) => s.id.startsWith("mail:"));

    expect(mail.map((s) => s.id).sort()).toEqual(["mail:google:default", "mail:google:sub-b"]);
    // Each points at its own account's threads, never a shared directory.
    expect(new Set(mail.map((s) => s.artifactDir)).size).toBe(2);
  });

  it("keeps a mail source the user disabled", async () => {
    await fs.mkdir(path.join(tmpDir, "mail", "google", "default", "threads"), { recursive: true });
    await writeSourcesConfig([
      { ...LEGACY_MAIL_SOURCE, id: "mail:google:default", artifactDir: "mail/google/default/threads", enabled: false },
    ]);
    const { FSKnowledgeSourcesRepo } = await import("./repo.js");

    const source = new FSKnowledgeSourcesRepo().getConfig().sources
      .find((s) => s.id === "mail:google:default");

    // Re-deriving must not silently re-enable a source someone turned off.
    expect(source?.enabled).toBe(false);
  });

  it("leaves non-mail sources untouched", async () => {
    await writeSourcesConfig([LEGACY_MAIL_SOURCE]);
    const { FSKnowledgeSourcesRepo } = await import("./repo.js");

    const sources = new FSKnowledgeSourcesRepo().getConfig().sources;

    expect(sources.find((s) => s.id === "fireflies-meetings")).toBeDefined();
    expect(sources.find((s) => s.id === "granola-meetings")).toBeDefined();
  });
});
