import { describe, it, expect } from "vitest";
import {
    RAG_INSTRUCTIONS,
    TRANSFER_PARENT_AWARE_INSTRUCTIONS,
    TRANSFER_GIVE_UP_CONTROL_INSTRUCTIONS,
    TRANSFER_CHILDREN_INSTRUCTIONS,
    ERROR_ESCALATION_AGENT_INSTRUCTIONS,
    SYSTEM_MESSAGE,
    CHILD_TRANSFER_RELATED_INSTRUCTIONS,
    CONVERSATION_TYPE_INSTRUCTIONS,
    TASK_TYPE_INSTRUCTIONS,
    PIPELINE_TYPE_INSTRUCTIONS,
    VARIABLES_CONTEXT_INSTRUCTIONS,
} from "@/src/application/lib/agents-runtime/agent_instructions";

/**
 * Characterization tests — they pin what this module does TODAY, not what it
 * ought to do. Ahead of the port into apps/dhowx, moving ~45k LOC between apps
 * is a rewrite you cannot diff, and neither typecheck nor lint sees any of this:
 * every export is a `string`, so a dropped clause, a broken interpolation or a
 * silently emptied prompt all typecheck perfectly and change agent behaviour.
 *
 * Snapshots carry the full text on purpose. A reworded prompt SHOULD fail here
 * — the failure is the notification, and updating the snapshot is how you say
 * the change was deliberate.
 *
 * The non-snapshot assertions below cover the failures that a snapshot alone
 * reads past: interpolation degrading to a literal `${...}`, and the empty-input
 * branch that must produce no prompt section at all.
 */

const AGENT_LIST = "- billing_agent: handles invoices\n- support_agent: handles tickets";

describe("prompt builders interpolate their argument", () => {
    // A port that breaks template substitution still returns a string of roughly
    // the right shape, so assert the argument reaches the output AND that no raw
    // placeholder survives.
    const cases: Array<[string, (arg: string) => string, string]> = [
        ["RAG_INSTRUCTIONS", RAG_INSTRUCTIONS, "fetch_articles_tool"],
        ["TRANSFER_PARENT_AWARE_INSTRUCTIONS", TRANSFER_PARENT_AWARE_INSTRUCTIONS, AGENT_LIST],
        ["TRANSFER_GIVE_UP_CONTROL_INSTRUCTIONS", TRANSFER_GIVE_UP_CONTROL_INSTRUCTIONS, AGENT_LIST],
        ["TRANSFER_CHILDREN_INSTRUCTIONS", TRANSFER_CHILDREN_INSTRUCTIONS, AGENT_LIST],
        ["SYSTEM_MESSAGE", SYSTEM_MESSAGE, "You are a helpful assistant."],
    ];

    for (const [name, build, arg] of cases) {
        it(`${name} embeds its argument and leaves no placeholder`, () => {
            const out = build(arg);
            expect(out).toContain(arg);
            expect(out).not.toMatch(/\$\{/);
            expect(out.trim().length).toBeGreaterThan(0);
        });
    }
});

describe("VARIABLES_CONTEXT_INSTRUCTIONS", () => {
    // The only builder with a branch. Returning '' for no variables is
    // load-bearing: the caller concatenates prompt sections, so a stray header
    // with an empty body would tell the model variables exist when none do.
    it("produces no section at all when there are no variables", () => {
        expect(VARIABLES_CONTEXT_INSTRUCTIONS([])).toBe("");
    });

    it("produces no section for a nullish list", () => {
        expect(VARIABLES_CONTEXT_INSTRUCTIONS(undefined as never)).toBe("");
        expect(VARIABLES_CONTEXT_INSTRUCTIONS(null as never)).toBe("");
    });

    it("renders one name: value pair per line", () => {
        const out = VARIABLES_CONTEXT_INSTRUCTIONS([
            { name: "customer_tier", value: "gold" },
            { name: "locale", value: "en-GB" },
        ]);
        expect(out).toContain("customer_tier: gold");
        expect(out).toContain("locale: en-GB");
        expect(out).toMatch(/customer_tier: gold\nlocale: en-GB/);
    });
});

describe("full prompt text is pinned", () => {
    it("RAG_INSTRUCTIONS", () => {
        expect(RAG_INSTRUCTIONS("fetch_articles")).toMatchSnapshot();
    });

    it("TRANSFER_PARENT_AWARE_INSTRUCTIONS", () => {
        expect(TRANSFER_PARENT_AWARE_INSTRUCTIONS(AGENT_LIST)).toMatchSnapshot();
    });

    it("TRANSFER_GIVE_UP_CONTROL_INSTRUCTIONS", () => {
        expect(TRANSFER_GIVE_UP_CONTROL_INSTRUCTIONS(AGENT_LIST)).toMatchSnapshot();
    });

    it("TRANSFER_CHILDREN_INSTRUCTIONS", () => {
        expect(TRANSFER_CHILDREN_INSTRUCTIONS(AGENT_LIST)).toMatchSnapshot();
    });

    it("ERROR_ESCALATION_AGENT_INSTRUCTIONS", () => {
        expect(ERROR_ESCALATION_AGENT_INSTRUCTIONS).toMatchSnapshot();
    });

    it("SYSTEM_MESSAGE", () => {
        expect(SYSTEM_MESSAGE("You are a helpful assistant.")).toMatchSnapshot();
    });

    it("CHILD_TRANSFER_RELATED_INSTRUCTIONS", () => {
        expect(CHILD_TRANSFER_RELATED_INSTRUCTIONS).toMatchSnapshot();
    });

    it("CONVERSATION_TYPE_INSTRUCTIONS", () => {
        expect(CONVERSATION_TYPE_INSTRUCTIONS()).toMatchSnapshot();
    });

    it("TASK_TYPE_INSTRUCTIONS", () => {
        expect(TASK_TYPE_INSTRUCTIONS()).toMatchSnapshot();
    });

    it("PIPELINE_TYPE_INSTRUCTIONS", () => {
        expect(PIPELINE_TYPE_INSTRUCTIONS()).toMatchSnapshot();
    });

    it("VARIABLES_CONTEXT_INSTRUCTIONS with variables", () => {
        expect(
            VARIABLES_CONTEXT_INSTRUCTIONS([{ name: "customer_tier", value: "gold" }]),
        ).toMatchSnapshot();
    });
});
