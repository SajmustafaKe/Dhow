import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * runAssignment's branch on member.tools.
 *
 * Empty tools is not a degraded state, it is the other mode (see the field's
 * doc comment in @x/shared/src/council.ts): a bounded, single generateText
 * call versus a headless agent turn. Both paths are pinned here, plus the
 * seam between them — a member who gains tools must actually get to use
 * them, and a member who never asked for any must never pay for the
 * machinery that grants them.
 */

const TIMEOUT = 30_000;

/** A minimal, fully-formed member fixture — mirrors CouncilMemberSchema's fields without paying for zod validation on every test. */
interface TestMember {
  id: string;
  title: string;
  mission: string;
  owns: string[];
  decidesAlone: string[];
  escalates: string[];
  outputContract: string[];
  enabled: boolean;
  builtin: boolean;
  group: "core" | "csuite" | "custom";
  order: number;
  tools: string[];
  maxModelCalls: number;
}

function makeMember(overrides: Partial<TestMember> = {}): TestMember {
  return {
    id: "cfo",
    title: "CFO",
    mission: "Own the numbers.",
    owns: ["budget"],
    decidesAlone: ["spend under $5k"],
    escalates: ["anything over $5k"],
    outputContract: ["a number"],
    enabled: true,
    builtin: true,
    group: "core",
    order: 1,
    tools: [],
    maxModelCalls: 12,
    ...overrides,
  };
}

interface TestAssignment {
  id: string;
  title: string;
  detail: string;
  assigneeId: string | null;
  status: "open" | "in_progress" | "blocked" | "done" | "cancelled";
  parentId: string | null;
  sessionId: string | null;
  blockedReason: string | null;
  result: string | null;
  dispatchedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function makeAssignment(overrides: Partial<TestAssignment> = {}): TestAssignment {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    id: "task-1",
    title: "Review the vendor contract",
    detail: "",
    assigneeId: "cfo",
    status: "in_progress",
    parentId: null,
    sessionId: null,
    blockedReason: null,
    result: null,
    dispatchedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("runAssignment — prompt-only path (tools: [])", { timeout: TIMEOUT }, () => {
  let generateText: ReturnType<typeof vi.fn>;
  let lazyResolve: ReturnType<typeof vi.fn>;
  let loadTurnLimitsSettings: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    generateText = vi.fn(async () => ({ text: "  A crisp answer.  " }));
    // Reaching either of these means the empty-tools path paid for the
    // headless runtime it is supposed to never touch — fail loudly rather
    // than silently succeeding on a slower path.
    lazyResolve = vi.fn(() => {
      throw new Error("prompt-only path must never resolve the headless runtime");
    });
    loadTurnLimitsSettings = vi.fn(() => {
      throw new Error("prompt-only path must never load turn-limit settings");
    });

    vi.doMock("ai", () => ({ generateText }));
    vi.doMock("../models/models.js", () => ({ createLanguageModel: vi.fn(() => ({ id: "stub-model" })) }));
    vi.doMock("../models/defaults.js", () => ({
      getKgModel: vi.fn(async () => ({ model: "gpt-x", provider: "stub-provider" })),
      resolveProviderConfig: vi.fn(async () => ({})),
    }));
    vi.doMock("../analytics/use_case.js", () => ({
      withUseCase: vi.fn((_ctx: unknown, fn: () => unknown) => fn()),
    }));
    vi.doMock("./store.js", () => ({ getSession: vi.fn(() => null) }));
    vi.doMock("../di/lazy-resolve.js", () => ({ lazyResolve }));
    vi.doMock("../config/turn_limits.js", () => ({ loadTurnLimitsSettings }));
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("calls generateText once with the charter prompt and returns the trimmed text", async () => {
    const { runAssignment } = await import("./run.js");
    const member = makeMember();
    const assignment = makeAssignment({ title: "Read the term sheet", detail: "Flag anything unusual." });

    const result = await runAssignment(member, assignment);

    expect(result).toBe("A crisp answer.");
    expect(generateText).toHaveBeenCalledTimes(1);
    const call = generateText.mock.calls[0][0] as { system: string; prompt: string };
    expect(call.system).toContain("You are the CFO on a principal's council.");
    expect(call.system).toContain("Own the numbers.");
    expect(call.system).toContain("If the task cannot be completed with what you were given, say exactly what is missing and stop. Do not invent inputs.");
    // The tool-path wording must never leak onto a member with no grant.
    expect(call.system).not.toContain("You have tools");
    expect(call.prompt).toContain("Task: Read the term sheet");
    expect(call.prompt).toContain("Detail: Flag anything unusual.");
    expect(lazyResolve).not.toHaveBeenCalled();
    expect(loadTurnLimitsSettings).not.toHaveBeenCalled();
  });

  it("throws when the member returns nothing", async () => {
    generateText.mockResolvedValueOnce({ text: "   " });
    const { runAssignment } = await import("./run.js");

    await expect(runAssignment(makeMember(), makeAssignment())).rejects.toThrow("CFO returned nothing.");
  });
});

describe("runAssignment — tool-using path (tools non-empty)", { timeout: TIMEOUT }, () => {
  let generateText: ReturnType<typeof vi.fn>;
  let start: ReturnType<typeof vi.fn>;
  let lazyResolve: ReturnType<typeof vi.fn>;
  let loadTurnLimitsSettings: ReturnType<typeof vi.fn>;

  /** What headlessRunner.start's returned handle resolves `done` to for the next call. */
  let doneResult: unknown;

  beforeEach(() => {
    vi.resetModules();
    // Reaching this proves the branch fell through to the prompt-only path
    // instead of running the member as a headless agent.
    generateText = vi.fn(async () => ({ text: "must not be called on the tool path" }));
    doneResult = {
      outcome: { status: "completed", output: {}, finishReason: "stop", usage: {} },
      state: {},
      summary: "Real analysis: the liability cap is thin. Push back before signature.",
    };
    start = vi.fn(async () => ({ turnId: "turn-1", done: Promise.resolve(doneResult) }));
    lazyResolve = vi.fn(async (token: string) => {
      if (token !== "headlessAgentRunner") throw new Error(`unexpected DI token: ${token}`);
      return { start };
    });
    loadTurnLimitsSettings = vi.fn(async () => ({ maxModelCalls: 50 }));

    vi.doMock("ai", () => ({ generateText }));
    vi.doMock("../models/models.js", () => ({ createLanguageModel: vi.fn(() => ({ id: "stub-model" })) }));
    vi.doMock("../models/defaults.js", () => ({
      getKgModel: vi.fn(async () => ({ model: "gpt-x", provider: "stub-provider" })),
      resolveProviderConfig: vi.fn(async () => ({})),
    }));
    vi.doMock("../analytics/use_case.js", () => ({
      withUseCase: vi.fn((_ctx: unknown, fn: () => unknown) => fn()),
    }));
    vi.doMock("./store.js", () => ({ getSession: vi.fn(() => null) }));
    vi.doMock("../di/lazy-resolve.js", () => ({ lazyResolve }));
    vi.doMock("../config/turn_limits.js", () => ({ loadTurnLimitsSettings }));
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("runs the member as a headless inline agent with the charter's tools, and never calls generateText", async () => {
    const { runAssignment } = await import("./run.js");
    const member = makeMember({ title: "CFO", tools: ["files", "web"], maxModelCalls: 8 });
    const assignment = makeAssignment({ title: "Read the term sheet", detail: "Flag anything unusual." });

    const result = await runAssignment(member, assignment);

    expect(result).toBe("Real analysis: the liability cap is thin. Push back before signature.");
    expect(generateText).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledTimes(1);
    const opts = start.mock.calls[0][0] as {
      agent: { inline: { name: string; instructions: string; tools: string[] } };
      message: string;
      maxModelCalls: number;
    };
    expect(opts.agent.inline.name).toBe("CFO");
    expect(opts.agent.inline.tools).toEqual(["files", "web"]);
    // The tool-using member gets told it can act, not told to stop and wait.
    expect(opts.agent.inline.instructions).toContain("You have tools");
    expect(opts.agent.inline.instructions).not.toContain("Do not invent inputs.");
    expect(opts.message).toContain("Task: Read the term sheet");
    expect(opts.message).toContain("Detail: Flag anything unusual.");
    expect(opts.maxModelCalls).toBe(8);
  });

  it("clamps a budget request above the app-wide cap", async () => {
    loadTurnLimitsSettings.mockResolvedValueOnce({ maxModelCalls: 10 });
    const { runAssignment } = await import("./run.js");
    const member = makeMember({ tools: ["files"], maxModelCalls: 40 });

    await runAssignment(member, makeAssignment());

    const opts = start.mock.calls[0][0] as { maxModelCalls: number };
    expect(opts.maxModelCalls).toBe(10);
  });

  it("honours a budget request below the app-wide cap, rather than always forwarding the cap", async () => {
    loadTurnLimitsSettings.mockResolvedValueOnce({ maxModelCalls: 50 });
    const { runAssignment } = await import("./run.js");
    const member = makeMember({ tools: ["files"], maxModelCalls: 4 });

    await runAssignment(member, makeAssignment());

    const opts = start.mock.calls[0][0] as { maxModelCalls: number };
    expect(opts.maxModelCalls).toBe(4);
  });

  it("throws with the outcome's error when the turn fails", async () => {
    doneResult = { outcome: { status: "failed", error: "provider rate limited", usage: {} }, state: {}, summary: null };
    const { runAssignment } = await import("./run.js");

    await expect(runAssignment(makeMember({ tools: ["files"] }), makeAssignment()))
      .rejects.toThrow("provider rate limited");
  });

  it("throws a descriptive error for a non-failed, non-completed outcome", async () => {
    doneResult = { outcome: { status: "cancelled", reason: "aborted", usage: {} }, state: {}, summary: null };
    const { runAssignment } = await import("./run.js");

    await expect(runAssignment(makeMember({ title: "CFO", tools: ["files"] }), makeAssignment()))
      .rejects.toThrow("CFO's turn was cancelled.");
  });

  it("throws when a completed turn produced no summary text", async () => {
    doneResult = { outcome: { status: "completed", output: {}, finishReason: "stop", usage: {} }, state: {}, summary: "   " };
    const { runAssignment } = await import("./run.js");

    await expect(runAssignment(makeMember({ title: "CFO", tools: ["files"] }), makeAssignment()))
      .rejects.toThrow("CFO returned nothing.");
  });
});

describe("dispatchAssignment — a real tool-using dispatch", { timeout: TIMEOUT }, () => {
  // The wiring this guards: promise.ts's broken-promise check runs on
  // whatever runAssignment hands back regardless of which path produced it.
  // A headless result with substantive content must read exactly like a
  // prompt-only one to that check — nothing about the tool path should make
  // real work look like a stall, or vice versa.
  const DELIVERABLE =
    "The liability cap is twelve months of fees against our usual floor of "
    + "twenty-four, and clause 8.3 gives them thirty-day termination while "
    + "binding us to ninety. Counter on both before signature.";

  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dhow-run-tools-e2e-"));
    process.env.DHOW_WORKDIR = tmpDir;
    vi.resetModules();
    // Earlier describe blocks in this file stub `./store.js` down to just
    // `getSession`; this block needs the real thing (member seeding,
    // markdown round-trip) so the dispatch below is a genuine integration,
    // not a re-test of the mocked seam above.
    vi.doUnmock("./store.js");

    vi.doMock("../knowledge/version_history.js", () => ({
      commitAll: vi.fn(async () => undefined),
      initRepo: vi.fn(async () => undefined),
    }));
    vi.doMock("../knowledge/deprecate_today_note.js", () => ({
      deprecateTodayNote: vi.fn(async () => undefined),
    }));
    // The prompt-only model stack is unreachable from this test's charter
    // (every member gets tools before dispatch), but stub it anyway so a
    // regression that falls through to it fails on a clear assertion
    // instead of a real network call.
    vi.doMock("ai", () => ({
      generateText: vi.fn(async () => ({ text: "must not be called on the tool path" })),
    }));
    vi.doMock("../di/lazy-resolve.js", () => ({
      lazyResolve: vi.fn(async (token: string) => {
        if (token !== "headlessAgentRunner") throw new Error(`unexpected DI token: ${token}`);
        return {
          start: vi.fn(async () => ({
            turnId: "turn-e2e",
            done: Promise.resolve({
              outcome: { status: "completed", output: {}, finishReason: "stop", usage: {} },
              state: {},
              summary: DELIVERABLE,
            }),
          })),
        };
      }),
    }));
  });

  afterEach(async () => {
    delete process.env.DHOW_WORKDIR;
    vi.resetModules();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("leaves a headless deliverable in_progress, not blocked as a broken promise", async () => {
    const { createAssignment, dispatchAssignment } = await import("./assignments.js");
    const { listMembers, saveMember } = await import("./store.js");

    const base = listMembers()[0];
    saveMember({ ...base, tools: ["files", "web"], maxModelCalls: 6 });

    const created = createAssignment({ title: "Review the vendor contract", assigneeId: base.id });
    const result = await dispatchAssignment(created.id);

    expect(result.status).toBe("in_progress");
    expect(result.blockedReason).toBeNull();
    expect(result.result).toBe(DELIVERABLE);
  });
});
