import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Fresh module registry + dynamic imports per test; the 5s default is tight
// under full-suite load.
const TIMEOUT = 30_000;

// WorkDir resolves at module load, so each test gets a fresh vault.
let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dhow-council-test-"));
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

describe("council members", { timeout: TIMEOUT }, () => {
  it("seeds editable charters and reads them back", async () => {
    const { listMembers } = await import("./store.js");

    const members = listMembers();

    expect(members.length).toBeGreaterThanOrEqual(4);
    const skeptic = members.find((m) => m.id === "skeptic");
    expect(skeptic?.title).toBe("Skeptic");
    // Round-trips through Markdown, not just memory.
    expect(skeptic?.mission).toContain("strongest honest case against");
    expect(skeptic?.outputContract.length).toBeGreaterThan(0);
    expect(fsSync.existsSync(path.join(tmpDir, "council", "members", "skeptic.md"))).toBe(true);
  });

  // Charters are Markdown precisely so they can be rewritten; a re-seed on
  // every launch would silently revert the user's edits.
  it("never overwrites a charter the user has edited", async () => {
    const { listMembers, seedBuiltinMembers } = await import("./store.js");
    listMembers();

    const file = path.join(tmpDir, "council", "members", "analyst.md");
    const edited = fsSync.readFileSync(file, "utf8").replace(
      /^## Mission\n\n[\s\S]*?(?=\n## )/m,
      "## Mission\n\nOnly speak about unit economics.\n",
    );
    fsSync.writeFileSync(file, edited);

    seedBuiltinMembers();

    expect(listMembers().find((m) => m.id === "analyst")?.mission).toBe("Only speak about unit economics.");
  });

  it("honours a hand-disabled member", async () => {
    const { listMembers, saveMember } = await import("./store.js");
    const analyst = listMembers().find((m) => m.id === "analyst")!;

    saveMember({ ...analyst, enabled: false });

    expect(listMembers().find((m) => m.id === "analyst")?.enabled).toBe(false);
  });
});

describe("council sessions", { timeout: TIMEOUT }, () => {
  const position = (text: string) => ({
    position: text,
    why: ["reason one"],
    risk: "a risk",
    unknown: "an unknown",
  });

  it("keeps a failed member visible rather than dropping it", async () => {
    const { saveSession, getSession } = await import("./store.js");
    const session = {
      id: "session-1",
      question: "Ship it?",
      createdAt: new Date().toISOString(),
      attachments: [],
      discussed: false,
      positions: [
        { memberId: "operator", title: "Operator", position: position("Ship"), error: null, rebuttal: null },
        // A member that could not answer must still appear: silence reads as
        // agreement, which is the exact misreading this guards against.
        { memberId: "skeptic", title: "Skeptic", position: null, error: "model timeout", rebuttal: null },
      ],
      synthesis: null,
      synthesisError: null,
    };

    saveSession(session);
    const loaded = getSession("session-1");

    expect(loaded?.positions).toHaveLength(2);
    const failed = loaded?.positions.find((p) => p.memberId === "skeptic");
    expect(failed?.position).toBeNull();
    expect(failed?.error).toBe("model timeout");
  });

  it("writes a readable memo with disagreements to the vault", async () => {
    const { saveSession } = await import("./store.js");
    saveSession({
      id: "session-2",
      question: "Take the enterprise deal?",
      createdAt: new Date().toISOString(),
      attachments: [],
      discussed: false,
      positions: [{ memberId: "operator", title: "Operator", position: position("No"), error: null, rebuttal: null }],
      synthesis: {
        headline: "Decline the deal.",
        positions: [{ memberId: "operator", summary: "No capacity this quarter." }],
        disagreements: [{
          between: ["operator", "strategist"],
          conflict: "Capacity now versus the logo long term.",
          recommendation: "Follow the operator; the logo does not pay for a missed roadmap.",
        }],
        openQuestions: ["Would they accept a Q3 start?"],
        nextAction: { action: "Reply declining, offer Q3", owner: "principal", when: "this week" },
      },
      synthesisError: null,
    });

    const dir = path.join(tmpDir, "council", "sessions");
    const memo = fsSync.readdirSync(dir).find((n) => n.endsWith(".md"))!;
    const content = fsSync.readFileSync(path.join(dir, memo), "utf8");

    expect(content).toContain("Decline the deal.");
    expect(content).toContain("### Disagreements");
    expect(content).toContain("Capacity now versus the logo long term.");
    // Local-first: the memo is a document, not a database row.
    expect(memo).toContain("take-the-enterprise-deal");
  });

  it("records genuine agreement as such, not as a missing section", async () => {
    const { saveSession } = await import("./store.js");
    saveSession({
      id: "session-3",
      question: "Fix the bug?",
      createdAt: new Date().toISOString(),
      attachments: [],
      discussed: false,
      positions: [],
      synthesis: {
        headline: "Fix it.",
        positions: [],
        disagreements: [],
        openQuestions: [],
        nextAction: { action: "Patch", owner: "principal", when: "today" },
      },
      synthesisError: null,
    });

    const dir = path.join(tmpDir, "council", "sessions");
    const memo = fsSync.readdirSync(dir).find((n) => n.endsWith(".md"))!;

    expect(fsSync.readFileSync(path.join(dir, memo), "utf8")).toContain("None material.");
  });
});

describe("assignments", { timeout: TIMEOUT }, () => {
  it("refuses to block without a reason", async () => {
    const { createAssignment, updateAssignment } = await import("./assignments.js");
    const a = createAssignment({ title: "Draft the reply" });

    // A board full of unexplained stalls is the failure this prevents.
    expect(() => updateAssignment(a.id, { status: "blocked" })).toThrow(/reason/i);
    expect(() => updateAssignment(a.id, { status: "blocked", blockedReason: "  " })).toThrow(/reason/i);

    const blocked = updateAssignment(a.id, { status: "blocked", blockedReason: "waiting on legal" });
    expect(blocked.status).toBe("blocked");
    expect(blocked.blockedReason).toBe("waiting on legal");
  });

  it("clears the reason when work unblocks", async () => {
    const { createAssignment, updateAssignment } = await import("./assignments.js");
    const a = createAssignment({ title: "Draft the reply" });
    updateAssignment(a.id, { status: "blocked", blockedReason: "waiting on legal" });

    const reopened = updateAssignment(a.id, { status: "open" });

    expect(reopened.blockedReason).toBeNull();
  });

  // Carried over deliberately: a tree that closes itself out from underneath
  // the principal is worse than one that makes them look.
  it("does not cascade completion to the parent", async () => {
    const { createAssignment, updateAssignment, getAssignment } = await import("./assignments.js");
    const parent = createAssignment({ title: "Land the release" });
    const child = createAssignment({ title: "Cut the tag", parentId: parent.id });

    updateAssignment(child.id, { status: "done" });

    expect(getAssignment(parent.id)?.status).toBe("open");
  });

  it("builds a tree and keeps orphans reachable", async () => {
    const { createAssignment, assignmentTree, deleteAssignmentTree } = await import("./assignments.js");
    const parent = createAssignment({ title: "Parent" });
    createAssignment({ title: "Child", parentId: parent.id });

    const roots = assignmentTree();
    expect(roots).toHaveLength(1);
    expect(roots[0].children).toHaveLength(1);

    // Deleting a parent takes its subtree; orphaned children would be
    // unreachable from the board forever.
    const removed = deleteAssignmentTree(parent.id);
    expect(removed).toHaveLength(2);
    expect(assignmentTree()).toHaveLength(0);
  });

  it("rejects a child of a parent that does not exist", async () => {
    const { createAssignment } = await import("./assignments.js");
    expect(() => createAssignment({ title: "Orphan", parentId: "task-nope" })).toThrow(/does not exist/i);
  });

  it("round-trips through Markdown with its status and assignee", async () => {
    const { createAssignment, updateAssignment, listAssignments } = await import("./assignments.js");
    const a = createAssignment({ title: "Model the deal", detail: "3 scenarios", assigneeId: "analyst" });
    updateAssignment(a.id, { status: "in_progress" });

    const loaded = listAssignments().find((x) => x.id === a.id);

    expect(loaded?.title).toBe("Model the deal");
    expect(loaded?.detail).toBe("3 scenarios");
    expect(loaded?.assigneeId).toBe("analyst");
    expect(loaded?.status).toBe("in_progress");
  });
});

describe("rosters", { timeout: TIMEOUT }, () => {
  it("ships the core four and the executive cabinet, in rank order", async () => {
    const { listMembers } = await import("./store.js");

    const members = listMembers();
    const core = members.filter((m) => m.group === "core").map((m) => m.id);
    const csuite = members.filter((m) => m.group === "csuite").map((m) => m.id);

    expect(core).toEqual(["operator", "analyst", "skeptic", "strategist"]);
    // Rank order, not alphabetical — a cabinet listed A-Z reads wrong.
    expect(csuite).toEqual(["ceo", "cfo", "coo", "cto", "cmo", "chro", "clo"]);
    // Core comes first so the default roster is the one at the top.
    expect(members.findIndex((m) => m.group === "core"))
      .toBeLessThan(members.findIndex((m) => m.group === "csuite"));
  });

  it("keeps a member's roster across the Markdown round trip", async () => {
    const { listMembers } = await import("./store.js");
    listMembers();

    // Re-read from disk, not from the in-memory defaults.
    const { listMembers: reread } = await import("./store.js");
    expect(reread().find((m) => m.id === "clo")?.group).toBe("csuite");
    expect(reread().find((m) => m.id === "clo")?.title).toBe("Chief Legal Officer");
  });
});

describe("dispatch", { timeout: TIMEOUT }, () => {
  beforeEach(() => {
    vi.doMock("./run.js", () => ({
      runAssignment: vi.fn(async (member: { title: string }) => `work from ${member.title}`),
    }));
  });

  it("refuses to dispatch an unassigned task", async () => {
    const { createAssignment, dispatchAssignment } = await import("./assignments.js");
    const a = createAssignment({ title: "Nobody owns this" });

    await expect(dispatchAssignment(a.id)).rejects.toThrow(/assign/i);
  });

  // Returning work is not the same as the principal accepting it.
  it("stores the result without marking the task done", async () => {
    const { createAssignment, dispatchAssignment } = await import("./assignments.js");
    const a = createAssignment({ title: "Draft the clause", assigneeId: "clo" });

    const done = await dispatchAssignment(a.id);

    expect(done.result).toBe("work from Chief Legal Officer");
    expect(done.status).toBe("in_progress");
    expect(done.dispatchedAt).toBeTruthy();
  });

  it("blocks with the reason when the member fails", async () => {
    vi.doMock("./run.js", () => ({
      runAssignment: vi.fn(async () => { throw new Error("model unavailable"); }),
    }));
    const { createAssignment, dispatchAssignment } = await import("./assignments.js");
    const a = createAssignment({ title: "Draft the clause", assigneeId: "clo" });

    const blocked = await dispatchAssignment(a.id);

    // Silently leaving it open would hide the stall from the board.
    expect(blocked.status).toBe("blocked");
    expect(blocked.blockedReason).toMatch(/model unavailable/);
  });
});
