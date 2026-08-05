import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The wiring, not the heuristic — promise.test.ts covers the detector itself.
 *
 * What is pinned here is the consequence: a member who narrates instead of
 * working must leave a visible stall on the board, and must not have their
 * reply thrown away. Both are easy to regress in opposite directions — drop
 * the check and the board silently shows a promise as delivered work; get
 * over-eager and a real deliverable gets buried under a "blocked" badge.
 */

const TIMEOUT = 30_000;

let tmpDir: string;
/** What the stubbed member hands back for the next dispatch. */
let memberReply: string;

const DELIVERABLE =
  "The liability cap is twelve months of fees against our usual floor of "
  + "twenty-four, and clause 8.3 gives them thirty-day termination while "
  + "binding us to ninety. Counter on both before signature.";

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dhow-dispatch-promise-"));
  process.env.DHOW_WORKDIR = tmpDir;
  memberReply = DELIVERABLE;
  vi.resetModules();

  vi.doMock("../knowledge/version_history.js", () => ({
    commitAll: vi.fn(async () => undefined),
    initRepo: vi.fn(async () => undefined),
  }));
  vi.doMock("../knowledge/deprecate_today_note.js", () => ({
    deprecateTodayNote: vi.fn(async () => undefined),
  }));
  // Stub the member's turn rather than the model stack: this test is about
  // what dispatchAssignment does with the text, not how the text was made.
  vi.doMock("./run.js", () => ({
    runAssignment: vi.fn(async () => memberReply),
  }));
});

afterEach(async () => {
  delete process.env.DHOW_WORKDIR;
  vi.resetModules();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function dispatchWithReply(reply: string) {
  memberReply = reply;
  const { createAssignment, dispatchAssignment } = await import("./assignments.js");
  const { listMembers } = await import("./store.js");
  const member = listMembers()[0];
  const created = createAssignment({
    title: "Review the vendor contract",
    assigneeId: member.id,
  });
  return { result: await dispatchAssignment(created.id), member };
}

describe("dispatchAssignment — broken promises", { timeout: TIMEOUT }, () => {
  it("blocks the assignment when the member only promises to start", async () => {
    const { result, member } = await dispatchWithReply(
      "I'll now begin reviewing the contract and report back.",
    );

    expect(result.status).toBe("blocked");
    expect(result.blockedReason).toContain(member.title);
    expect(result.blockedReason).toContain("re-dispatch");
  });

  it("keeps the reply so the principal can judge it", async () => {
    // The stall must not cost the text. Blocking and discarding would leave
    // the board saying "stuck" with nothing to read.
    const promise = "Let me start on the analysis. Back shortly.";
    const { result } = await dispatchWithReply(promise);

    expect(result.result).toBe(promise);
  });

  it("leaves real work in_progress, untouched", async () => {
    const { result } = await dispatchWithReply(DELIVERABLE);

    expect(result.status).toBe("in_progress");
    expect(result.blockedReason).toBeNull();
    expect(result.result).toBe(DELIVERABLE);
  });

  it("does not flag a deliverable that opens by announcing itself", async () => {
    // The false positive a literal port of the upstream regex produces.
    const { result } = await dispatchWithReply(`Let me begin.\n\n${DELIVERABLE}`);

    expect(result.status).toBe("in_progress");
    expect(result.blockedReason).toBeNull();
  });

  it("still blocks on a thrown dispatch, with the failure reason", async () => {
    // The pre-existing failure path must survive the new branch: a blocked
    // status now has two possible causes and they must stay distinguishable.
    vi.doMock("./run.js", () => ({
      runAssignment: vi.fn(async () => {
        throw new Error("model unavailable");
      }),
    }));
    vi.resetModules();

    const { createAssignment, dispatchAssignment } = await import("./assignments.js");
    const { listMembers } = await import("./store.js");
    const created = createAssignment({
      title: "Review the vendor contract",
      assigneeId: listMembers()[0].id,
    });
    const result = await dispatchAssignment(created.id);

    expect(result.status).toBe("blocked");
    expect(result.blockedReason).toContain("Dispatch failed");
    expect(result.blockedReason).toContain("model unavailable");
    expect(result.result).toBeNull();
  });
});
