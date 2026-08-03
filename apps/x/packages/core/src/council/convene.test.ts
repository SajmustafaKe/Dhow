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

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dhow-convene-test-"));
  process.env.DHOW_WORKDIR = tmpDir;
  calls = [];
  positionsByMember = {};
  synthesisResult = null;
  rebuttalResult = null;
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
