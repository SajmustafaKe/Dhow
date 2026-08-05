import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Each test resets the module registry and dynamically imports the model
// stack; the 5s default is too tight for that when the whole suite is running.
const TIMEOUT = 30_000;

/**
 * The convene flow, with the model stubbed.
 *
 * These assertions are the feature: isolation between members, and a memo
 * that cannot quietly lose a voice. Both are invisible in the output of a
 * single happy-path run, so they are pinned here.
 */

let tmpDir: string;
/** Every generateObjectSafe call, in order, so prompts can be inspected. */
let calls: { system?: string; prompt: string }[];
/** Keyed by the member id found in the system prompt; `null` throws. */
let positionsByMember: Record<string, unknown | null>;
let synthesisResult: unknown | null;
/** Second-round answer for every member; `null` makes each rebuttal throw. */
let rebuttalResult: unknown | null;
/** Every runHeadlessAgent call, in order — the research phase's own record. */
let researchCalls: { name: string; instructions: string; tools: string[]; maxModelCalls?: number; message: string }[];
/**
 * Per-member override for the research mock, keyed by member id (the inline
 * agent's `name`). Absent = a normal completed run with a stub summary.
 * `null` = the research turn throws. `"incomplete"` = it resolves without
 * completing (e.g. cancelled), which must degrade the same way a throw does.
 */
let researchByMember: Record<string, string | null | "incomplete" | undefined>;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dhow-convene-test-"));
  process.env.DHOW_WORKDIR = tmpDir;
  calls = [];
  positionsByMember = {};
  synthesisResult = null;
  rebuttalResult = null;
  researchCalls = [];
  researchByMember = {};
  vi.resetModules();

  vi.doMock("../knowledge/version_history.js", () => ({
    commitAll: vi.fn(async () => undefined),
    initRepo: vi.fn(async () => undefined),
  }));
  vi.doMock("../knowledge/deprecate_today_note.js", () => ({
    deprecateTodayNote: vi.fn(async () => undefined),
  }));
  vi.doMock("../models/defaults.js", () => ({
    getKgModel: vi.fn(async () => ({ model: "test-model", provider: "test" })),
    resolveProviderConfig: vi.fn(async () => ({ flavor: "openai", apiKey: "k" })),
  }));
  vi.doMock("../models/models.js", () => ({
    createLanguageModel: vi.fn(() => ({ id: "test-model" })),
  }));
  vi.doMock("../models/structured.js", () => ({
    generateObjectSafe: vi.fn(async (opts: { system?: string; prompt: string }) => {
      calls.push({ system: opts.system, prompt: opts.prompt });
      // The synthesiser is the only caller whose prompt carries every position.
      if (opts.system?.includes("Chief of Staff")) {
        if (synthesisResult === null) throw new Error("synthesis unavailable");
        return { object: synthesisResult };
      }
      const member = Object.keys(positionsByMember).find((id) =>
        opts.system?.includes(TITLES[id] ?? id),
      );
      // Round two is recognised by the prompt carrying the other positions.
      if (opts.prompt.includes("seeing them for the first time")) {
        if (rebuttalResult === null) throw new Error("no rebuttal");
        return { object: rebuttalResult };
      }
      const result = member ? positionsByMember[member] : null;
      if (!result) throw new Error(`no model for ${member ?? "unknown"}`);
      return { object: result };
    }),
  }));
  vi.doMock("../runtime/assembly/headless-app.js", () => ({
    runHeadlessAgent: vi.fn(async (opts: {
      agent: { inline: { name: string; instructions: string; tools?: string[] } };
      message: string;
      maxModelCalls?: number;
    }) => {
      const { name, instructions, tools } = opts.agent.inline;
      researchCalls.push({ name, instructions, tools: tools ?? [], maxModelCalls: opts.maxModelCalls, message: opts.message });
      const configured = researchByMember[name];
      if (configured === null) throw new Error(`research turn failed for ${name}`);
      if (configured === "incomplete") {
        return {
          outcome: { status: "failed", error: "boom", code: undefined, usage: {} },
          state: {},
          summary: "discard me — turn did not complete",
          turnId: `t-${name}`,
        };
      }
      return {
        outcome: { status: "completed", output: {}, finishReason: "stop", usage: {} },
        state: {},
        summary: configured ?? `${name} found nothing that changes the read.`,
        turnId: `t-${name}`,
      };
    }),
  }));
});

afterEach(async () => {
  delete process.env.DHOW_WORKDIR;
  vi.resetModules();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const CORE_IDS = ['operator', 'analyst', 'skeptic', 'strategist'];

const TITLES: Record<string, string> = {
  operator: "Operator",
  analyst: "Analyst",
  skeptic: "Skeptic",
  strategist: "Strategist",
};

const position = (text: string) => ({
  position: text,
  why: ["a reason"],
  risk: "a risk",
  unknown: "an unknown",
});

const SYNTHESIS = {
  headline: "Do the thing.",
  positions: [{ memberId: "operator", summary: "Yes." }],
  disagreements: [{ between: ["operator", "skeptic"], conflict: "speed vs safety", recommendation: "follow the skeptic" }],
  openQuestions: ["what is the deadline?"],
  nextAction: { action: "Draft it", owner: "principal", when: "today" },
};

function allMembersAnswer() {
  for (const id of Object.keys(TITLES)) positionsByMember[id] = position(`${id} says go`);
  synthesisResult = SYNTHESIS;
}

/** A minimal, fully-formed member fixture for tests that need explicit control over `tools`/`maxModelCalls`. */
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
  group: "custom";
  order: number;
  tools: string[];
  maxModelCalls: number;
}

function makeMember(id: string, tools: string[], maxModelCalls = 12): TestMember {
  return {
    id,
    title: id,
    mission: `${id} mission`,
    owns: [],
    decidesAlone: [],
    escalates: [],
    outputContract: [],
    enabled: true,
    builtin: false,
    group: "custom",
    order: 0,
    tools,
    maxModelCalls,
  };
}

/** Points `./store.js` at an explicit member list instead of the real seeded charters. */
function mockMembers(members: TestMember[]) {
  vi.doMock("./store.js", () => ({
    listMembers: () => members,
    newSessionId: () => "test-session",
    saveSession: vi.fn(),
  }));
}

describe("convene", { timeout: TIMEOUT }, () => {
  // The property that makes a council worth more than asking once: no member
  // may see another's answer, or the positions stop being independent.
  it("gives each member only its own charter, never another's position", async () => {
    allMembersAnswer();
    const { convene } = await import("./convene.js");

    await convene({ question: "Ship on Friday?", memberIds: CORE_IDS });

    const memberCalls = calls.filter((c) => !c.system?.includes("Chief of Staff"));
    expect(memberCalls).toHaveLength(4);
    for (const call of memberCalls) {
      const ownTitle = Object.values(TITLES).find((t) => call.system?.includes(t))!;
      const others = Object.values(TITLES).filter((t) => t !== ownTitle);
      // No other member's charter, and no other member's answer.
      for (const other of others) expect(call.system).not.toContain(other);
      expect(call.prompt).not.toMatch(/says go/);
      expect(call.prompt).toContain("Ship on Friday?");
    }
  });

  it("keeps the positions of members that answered when one fails", async () => {
    allMembersAnswer();
    positionsByMember.skeptic = null; // this member throws

    const { convene } = await import("./convene.js");
    const session = await convene({ question: "Ship on Friday?", memberIds: CORE_IDS });

    expect(session.positions).toHaveLength(4);
    const failed = session.positions.find((p) => p.memberId === "skeptic");
    expect(failed?.position).toBeNull();
    expect(failed?.error).toBeTruthy();
    // The other three survive — one failure must not discard the round.
    expect(session.positions.filter((p) => p.position)).toHaveLength(3);
    expect(session.synthesis).not.toBeNull();
  });

  it("still records the positions when synthesis fails", async () => {
    allMembersAnswer();
    synthesisResult = null; // synthesiser throws

    const { convene } = await import("./convene.js");
    const session = await convene({ question: "Ship on Friday?", memberIds: CORE_IDS });

    expect(session.synthesis).toBeNull();
    expect(session.synthesisError).toBeTruthy();
    // A failed memo must not cost the principal the underlying answers.
    expect(session.positions.filter((p) => p.position)).toHaveLength(4);
  });

  it("does not attempt a memo when nobody answered", async () => {
    synthesisResult = SYNTHESIS; // available, but must not be reached

    const { convene } = await import("./convene.js");
    const session = await convene({ question: "Ship on Friday?", memberIds: CORE_IDS });

    expect(session.synthesis).toBeNull();
    expect(session.synthesisError).toBe("No member returned a position.");
    expect(calls.some((c) => c.system?.includes("Chief of Staff"))).toBe(false);
  });

  it("hands every position to the synthesiser and forbids manufactured consensus", async () => {
    allMembersAnswer();
    const { convene } = await import("./convene.js");

    await convene({ question: "Ship on Friday?", memberIds: CORE_IDS });

    const synth = calls.find((c) => c.system?.includes("Chief of Staff"))!;
    for (const id of Object.keys(TITLES)) expect(synth.prompt).toContain(id);
    expect(synth.prompt).toMatch(/never manufacture consensus/i);
    expect(synth.prompt).toMatch(/did not see each other/i);
  });

  it("can be narrowed to a subset of members", async () => {
    allMembersAnswer();
    const { convene } = await import("./convene.js");

    const session = await convene({ question: "Ship?", memberIds: ["operator", "skeptic"] });

    expect(session.positions.map((p) => p.memberId).sort()).toEqual(["operator", "skeptic"]);
  });

  it("refuses an empty question", async () => {
    const { convene } = await import("./convene.js");
    await expect(convene({ question: "   " })).rejects.toThrow(/question/i);
  });
});

describe("convene — joint discussion", { timeout: TIMEOUT }, () => {
  const rebuttal = (changed: boolean) => ({
    changedMind: changed,
    revisedPosition: changed ? "actually, wait" : "unchanged",
    responses: [{ toMemberId: "skeptic", response: "fair point" }],
    reasoning: "because of the risk raised",
  });

  function allAnswerAndRespond() {
    for (const id of Object.keys(TITLES)) positionsByMember[id] = position(`${id} says go`);
    synthesisResult = SYNTHESIS;
  }

  it("does not run a second round unless asked", async () => {
    allAnswerAndRespond();
    const { convene } = await import("./convene.js");

    const session = await convene({ question: "Ship?", memberIds: CORE_IDS });

    expect(session.discussed).toBe(false);
    expect(session.positions.every((p) => p.rebuttal === null)).toBe(true);
  });

  // Round one must stay independent even when a discussion follows, or the
  // whole anti-echo property is lost.
  it("keeps the first round isolated and only shows others in the second", async () => {
    allAnswerAndRespond();
    rebuttalResult = rebuttal(true);
    const { convene } = await import("./convene.js");

    await convene({ question: "Ship?", memberIds: CORE_IDS, discuss: true });

    const memberCalls = calls.filter((c) => !c.system?.includes("Chief of Staff"));
    const firstRound = memberCalls.slice(0, 4);
    const secondRound = memberCalls.slice(4);
    for (const call of firstRound) expect(call.prompt).not.toMatch(/says go/);
    expect(secondRound).toHaveLength(4);
    for (const call of secondRound) expect(call.prompt).toMatch(/says go/);
  });

  it("records a rebuttal without overwriting the original position", async () => {
    allAnswerAndRespond();
    rebuttalResult = rebuttal(true);
    const { convene } = await import("./convene.js");

    const session = await convene({ question: "Ship?", memberIds: CORE_IDS, discuss: true });

    expect(session.discussed).toBe(true);
    const operator = session.positions.find((p) => p.memberId === "operator")!;
    // Both views survive, so a reader can see who moved and why.
    expect(operator.position?.position).toBe("operator says go");
    expect(operator.rebuttal?.changedMind).toBe(true);
    expect(operator.rebuttal?.revisedPosition).toBe("actually, wait");
  });

  it("keeps the position when a member fails to respond in discussion", async () => {
    allAnswerAndRespond();
    rebuttalResult = null; // every rebuttal throws
    const { convene } = await import("./convene.js");

    const session = await convene({ question: "Ship?", memberIds: CORE_IDS, discuss: true });

    // A failed second round costs the discussion, never the first-round answers.
    expect(session.positions.filter((p) => p.position)).toHaveLength(4);
    expect(session.discussed).toBe(false);
    expect(session.synthesis).not.toBeNull();
  });

  it("skips the round when only one member answered", async () => {
    positionsByMember.operator = position("operator says go");
    synthesisResult = SYNTHESIS;
    rebuttalResult = rebuttal(false);
    const { convene } = await import("./convene.js");

    // Nobody to deliberate with; a solo "discussion" is just a second charge.
    const session = await convene({ question: "Ship?", memberIds: ["operator"] });
    expect(session.positions.every((p) => p.rebuttal === null)).toBe(true);
  });
});

describe("convene — attached documents", { timeout: TIMEOUT }, () => {
  it("gives every member the same document text", async () => {
    for (const id of Object.keys(TITLES)) positionsByMember[id] = position(`${id} ok`);
    synthesisResult = SYNTHESIS;
    const { convene } = await import("./convene.js");

    await convene({
      question: "Is this contract safe to sign?",
      memberIds: CORE_IDS,
      attachments: [{ name: "msa.pdf", content: "CLAUSE 7: unlimited liability", truncated: false }],
    });

    const memberCalls = calls.filter((c) => !c.system?.includes("Chief of Staff"));
    // A cabinet reviewing different excerpts is not reviewing the same document.
    for (const call of memberCalls) {
      expect(call.prompt).toContain("msa.pdf");
      expect(call.prompt).toContain("CLAUSE 7: unlimited liability");
    }
  });

  it("marks a truncated document as truncated so nobody over-reads it", async () => {
    for (const id of Object.keys(TITLES)) positionsByMember[id] = position(`${id} ok`);
    synthesisResult = SYNTHESIS;
    const { convene } = await import("./convene.js");

    await convene({
      question: "Review this",
      memberIds: CORE_IDS,
      attachments: [{ name: "long.md", content: "part one", truncated: true }],
    });

    const call = calls.find((c) => !c.system?.includes("Chief of Staff"))!;
    expect(call.prompt).toContain("long.md (truncated)");
  });
});

describe("convene — research phase for tool-granted members", { timeout: TIMEOUT }, () => {
  // Only this block swaps out ./store.js, and only ever within it — declared
  // last in the file so no earlier test can inherit a stale mock, and
  // unmocked afterwards so nothing after it could either.
  afterEach(() => {
    vi.doUnmock("./store.js");
  });

  it("researches before positioning a tool-granted member, and skips it entirely for one with no tools", async () => {
    mockMembers([makeMember("researcher", ["files", "web"], 7), makeMember("oracle", [])]);
    positionsByMember.researcher = position("researcher says proceed");
    positionsByMember.oracle = position("oracle says proceed");
    synthesisResult = SYNTHESIS;
    const { convene } = await import("./convene.js");

    await convene({ question: "Ship on Friday?" });

    // Only the tool-granted member's research turn ran, with its own
    // charter's tools and budget.
    expect(researchCalls.map((c) => c.name)).toEqual(["researcher"]);
    expect(researchCalls[0].tools).toEqual(["files", "web"]);
    expect(researchCalls[0].maxModelCalls).toBe(7);
    expect(researchCalls[0].message).toContain("Ship on Friday?");
    expect(researchCalls[0].instructions).toMatch(/research pass/i);

    // Its findings reach the structured position call as context.
    const researcherCall = calls.find((c) => c.system?.includes("researcher"))!;
    expect(researcherCall.prompt).toBe(
      "The principal asks: Ship on Friday?\n\nYour own research before answering:\nresearcher found nothing that changes the read.",
    );

    // The empty-tools member's position call is exactly today's shape.
    const oracleCall = calls.find((c) => c.system?.includes("oracle"))!;
    expect(oracleCall.prompt).toBe("The principal asks: Ship on Friday?");
  });

  it("clamps a member's requested budget to the app-wide model-call limit, never raises it", async () => {
    mockMembers([makeMember("researcher", ["files"], 999)]);
    positionsByMember.researcher = position("researcher says proceed");
    synthesisResult = SYNTHESIS;
    const { convene } = await import("./convene.js");

    await convene({ question: "Ship on Friday?" });

    // No turn_limits.json exists in the test workdir, so the app-wide
    // default (50) applies; a charter asking for more is a request, not a
    // grant, and must be capped rather than forwarded as-is.
    expect(researchCalls[0].maxModelCalls).toBe(50);
  });

  it("still produces a position when the research phase throws — a broken tool never costs the seat", async () => {
    mockMembers([makeMember("researcher", ["files", "web"])]);
    researchByMember.researcher = null; // throws
    positionsByMember.researcher = position("researcher says proceed anyway");
    synthesisResult = SYNTHESIS;
    const { convene } = await import("./convene.js");

    const session = await convene({ question: "Ship on Friday?" });

    expect(researchCalls).toHaveLength(1); // the research turn really ran, and really failed
    const entry = session.positions.find((p) => p.memberId === "researcher")!;
    expect(entry.error).toBeNull();
    expect(entry.position?.position).toBe("researcher says proceed anyway");
    // The failure must not leak a findings section into the position prompt.
    const call = calls.find((c) => c.system?.includes("researcher"))!;
    expect(call.prompt).toBe("The principal asks: Ship on Friday?");
  });

  it("still produces a position when the research turn resolves without completing, discarding any partial summary", async () => {
    mockMembers([makeMember("researcher", ["files", "web"])]);
    researchByMember.researcher = "incomplete"; // resolves, but status !== "completed"
    positionsByMember.researcher = position("researcher says proceed anyway");
    synthesisResult = SYNTHESIS;
    const { convene } = await import("./convene.js");

    const session = await convene({ question: "Ship on Friday?" });

    const entry = session.positions.find((p) => p.memberId === "researcher")!;
    expect(entry.error).toBeNull();
    expect(entry.position?.position).toBe("researcher says proceed anyway");
    const call = calls.find((c) => c.system?.includes("researcher"))!;
    expect(call.prompt).toBe("The principal asks: Ship on Friday?");
    expect(call.prompt).not.toContain("discard me");
  });

  it("never grants the synthesiser a research phase, even when every answering member has one", async () => {
    mockMembers([makeMember("researcher", ["files", "web"]), makeMember("analyst2", ["files", "web", "parsing"])]);
    positionsByMember.researcher = position("researcher says proceed");
    positionsByMember.analyst2 = position("analyst2 says proceed");
    synthesisResult = SYNTHESIS;
    const { convene } = await import("./convene.js");

    await convene({ question: "Ship on Friday?" });

    // Exactly one research turn per tool-granted member, never one more for
    // the synthesiser — a synthesis-side research phase would show up here
    // as a third call, keyed by the Chief of Staff's id.
    expect(researchCalls).toHaveLength(2);
    expect(researchCalls.map((c) => c.name).sort()).toEqual(["analyst2", "researcher"]);
  });
});
