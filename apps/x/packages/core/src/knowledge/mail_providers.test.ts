import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// These reset the module registry and dynamically import build_graph and the
// provider modules; vitest's 5s default is tight for that under suite load.
const TIMEOUT = 30_000;

/**
 * The provider-neutral mail layer, and the two pure functions where Outlook
 * and IMAP each do something the other providers get for free.
 */

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dhow-mail-providers-test-"));
  process.env.DHOW_WORKDIR = tmpDir;
  vi.resetModules();
  vi.doMock("./version_history.js", () => ({
    commitAll: vi.fn(async () => undefined),
    initRepo: vi.fn(async () => undefined),
  }));
  vi.doMock("./deprecate_today_note.js", () => ({
    deprecateTodayNote: vi.fn(async () => undefined),
  }));
});

afterEach(async () => {
  delete process.env.DHOW_WORKDIR;
  vi.resetModules();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const thread = {
  threadId: "conv-1",
  subject: "Pricing discussion",
  messages: [
    {
      id: "m1",
      from: "Sarah <sarah@acme.com>",
      date: "2026-07-10T09:00:00.000Z",
      body: "Here is the proposal.",
    },
    {
      id: "m2",
      from: "Me <me@example.com>",
      date: "2026-07-10T10:00:00.000Z",
      body: "Thanks, reviewing now.",
      attachments: [{ filename: "quote.pdf", savedPath: "mail/imap/acct/attachments/quote.pdf" }],
    },
  ],
};

describe("shared mirror format", { timeout: TIMEOUT }, () => {
  /**
   * The load-bearing one. `emailAdmission` and the reply gate parse these
   * markers, and note-creation prompts tell the model to expect them — so a
   * new provider emitting a different shape breaks the knowledge pipeline
   * silently, for that provider only.
   */
  it("emits the structure the knowledge pipeline parses", async () => {
    const { renderThreadMarkdown } = await import("./mail_thread.js");

    const md = renderThreadMarkdown(thread);

    expect(md.startsWith("# Pricing discussion")).toBe(true);
    expect(md).toContain("**Thread ID:** conv-1");
    expect(md).toContain("**Message Count:** 2");
    // The reply gate splits on these blocks; one per message.
    expect(md.match(/^### From: /gm)).toHaveLength(2);
    expect(md).toContain("### From: Sarah <sarah@acme.com>");
    expect(md).toContain("Here is the proposal.");
  });

  it("links attachments relative to the mirror so they resolve in the vault", async () => {
    const { renderThreadMarkdown } = await import("./mail_thread.js");

    const md = renderThreadMarkdown(thread);

    expect(md).toContain("**Attachments:**");
    // Relative, not the stored WorkDir-relative path.
    expect(md).toContain("[quote.pdf](attachments/quote.pdf)");
    expect(md).not.toContain("mail/imap/acct/attachments/quote.pdf");
  });

  // Proves the two modules agree, rather than asserting a format twice.
  it("produces a mirror that build_graph will hold, then admit once stamped", async () => {
    const { renderThreadMarkdown } = await import("./mail_thread.js");
    const { emailAdmission } = await import("./build_graph.js");

    const md = renderThreadMarkdown(thread);

    // Unstamped mail waits for the classifier rather than being processed.
    expect(emailAdmission(md)).toBe("wait");

    const stamped = `---\nimportance: important\ncategory: correspondence\nknowledge: extract\n---\n\n${md}`;
    expect(emailAdmission(stamped)).toBe("process");
  });

  it("writes each account's threads under its own directory", async () => {
    const { writeThreadMirror } = await import("./mail_thread.js");

    writeThreadMirror("microsoft", "acct-a", thread);
    writeThreadMirror("imap", "acct-b", { ...thread, subject: "Other" });

    expect(fsSync.existsSync(path.join(tmpDir, "mail", "microsoft", "acct-a", "threads", "conv-1.md"))).toBe(true);
    expect(fsSync.existsSync(path.join(tmpDir, "mail", "imap", "acct-b", "threads", "conv-1.md"))).toBe(true);
    // Same thread id in two mailboxes must not collide.
    expect(fsSync.readFileSync(path.join(tmpDir, "mail", "imap", "acct-b", "threads", "conv-1.md"), "utf8"))
      .toContain("# Other");
  });

  it("encodes thread ids that are not path-safe", async () => {
    const { writeThreadMirror } = await import("./mail_thread.js");

    // IMAP derives ids from Message-IDs, which contain @ and can contain /.
    writeThreadMirror("imap", "acct", { ...thread, threadId: "<a/b@example.com>" });

    const files = fsSync.readdirSync(path.join(tmpDir, "mail", "imap", "acct", "threads"));
    expect(files).toHaveLength(1);
    expect(files[0]).not.toContain("/");
  });
});

describe("sync state", { timeout: TIMEOUT }, () => {
  it("keeps each account's change token separate", async () => {
    const { loadSyncState, saveSyncState } = await import("./mail_thread.js");

    saveSyncState("imap", "a", { changeToken: "100", uidValidity: 1 });
    saveSyncState("imap", "b", { changeToken: "999", uidValidity: 2 });

    // Sharing this across accounts is what corrupts incremental sync.
    expect(loadSyncState("imap", "a").changeToken).toBe("100");
    expect(loadSyncState("imap", "b").uidValidity).toBe(2);
    expect(loadSyncState("imap", "never-synced")).toEqual({});
  });
});

describe("Outlook conversation grouping", { timeout: TIMEOUT }, () => {
  it("groups messages by conversation", async () => {
    const { groupByConversation } = await import("./sync_outlook.js");

    const grouped = groupByConversation([
      { id: "1", conversationId: "c1" },
      { id: "2", conversationId: "c1" },
      { id: "3", conversationId: "c2" },
    ]);

    expect(grouped.get("c1")).toHaveLength(2);
    expect(grouped.get("c2")).toHaveLength(1);
  });

  it("gives a message with no conversation its own thread", async () => {
    const { groupByConversation } = await import("./sync_outlook.js");

    const grouped = groupByConversation([{ id: "orphan-1" }, { id: "orphan-2" }]);

    // Bucketing every orphan together would merge unrelated mail into one
    // thread — worse than a thread per message.
    expect(grouped.size).toBe(2);
  });
});

describe("IMAP thread derivation", { timeout: TIMEOUT }, () => {
  it("uses the root of the reference chain so a reply joins its thread", async () => {
    const { threadKeyFor } = await import("./sync_imap.js");

    const root = threadKeyFor({ messageId: "<root@x>" } as never);
    const reply = threadKeyFor({
      messageId: "<reply@x>",
      references: ["<root@x>", "<mid@x>"],
      inReplyTo: "<mid@x>",
    } as never);

    // IMAP has no server-side threading; this is the whole grouping strategy.
    expect(reply).toBe(root);
  });

  it("accepts references as a single string, which some servers return", async () => {
    const { threadKeyFor } = await import("./sync_imap.js");
    expect(threadKeyFor({ messageId: "<r@x>", references: "<root@x>" } as never)).toBe("<root@x>");
  });

  it("falls back to In-Reply-To, then to the message's own id", async () => {
    const { threadKeyFor } = await import("./sync_imap.js");

    expect(threadKeyFor({ messageId: "<r@x>", inReplyTo: "<parent@x> <older@x>" } as never)).toBe("<parent@x>");
    expect(threadKeyFor({ messageId: "<lonely@x>" } as never)).toBe("<lonely@x>");
  });

  it("still produces a key when the message has no id at all", async () => {
    const { threadKeyFor } = await import("./sync_imap.js");
    // Malformed mail must not throw mid-sync and abandon the rest of the run.
    expect(threadKeyFor({ date: new Date(0) } as never)).toContain("no-id-");
  });
});
