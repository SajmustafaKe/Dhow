import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dhow-convene-test-"));
  process.env.DHOW_WORKDIR = tmpDir;
  calls = [];
  positionsByMember = {};
  synthesisResult = null;
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

describe("convene", () => {
  // The property that makes a council worth more than asking once: no member
  // may see another's answer, or the positions stop being independent.
  it("gives each member only its own charter, never another's position", async () => {
    allMembersAnswer();
    const { convene } = await import("./convene.js");

    await convene({ question: "Ship on Friday?" });

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
    const session = await convene({ question: "Ship on Friday?" });

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
    const session = await convene({ question: "Ship on Friday?" });

    expect(session.synthesis).toBeNull();
    expect(session.synthesisError).toBeTruthy();
    // A failed memo must not cost the principal the underlying answers.
    expect(session.positions.filter((p) => p.position)).toHaveLength(4);
  });

  it("does not attempt a memo when nobody answered", async () => {
    synthesisResult = SYNTHESIS; // available, but must not be reached

    const { convene } = await import("./convene.js");
    const session = await convene({ question: "Ship on Friday?" });

    expect(session.synthesis).toBeNull();
    expect(session.synthesisError).toBe("No member returned a position.");
    expect(calls.some((c) => c.system?.includes("Chief of Staff"))).toBe(false);
  });

  it("hands every position to the synthesiser and forbids manufactured consensus", async () => {
    allMembersAnswer();
    const { convene } = await import("./convene.js");

    await convene({ question: "Ship on Friday?" });

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
