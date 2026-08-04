import { describe, it, expect } from "vitest";
import {
    getSchemaForAgent,
    createContextFilterForAgent,
    getPipelineStateForAgent,
} from "@/src/application/lib/agents-runtime/agent-handoffs";
import { HandoffContext } from "@/src/application/lib/agents-runtime/agents";

/**
 * Characterization tests for the handoff helpers, ahead of the port into
 * apps/dhowx.
 *
 * Two of these three functions take an `agentConfig` argument and then ignore
 * it completely — `getSchemaForAgent` returns the same schema for every agent
 * (with unreachable code after the return explaining why), and
 * `createContextFilterForAgent` returns an identity function. They read like
 * unfinished work, which is exactly the hazard: a port would "finish" them, and
 * every handoff in the product would start using a different schema or a
 * filtered conversation history.
 *
 * These tests say: that behaviour is what ships today. Changing it is allowed,
 * but it has to be a decision, not a tidy-up.
 */

// Only the fields these helpers could plausibly branch on.
const agent = (over: Record<string, unknown> = {}) =>
    ({
        name: "billing_agent",
        type: "conversation",
        description: "handles invoices",
        instructions: "help with billing",
        ...over,
    }) as never;

describe("getSchemaForAgent", () => {
    it("returns HandoffContext for a conversation agent", () => {
        expect(getSchemaForAgent(agent())).toBe(HandoffContext);
    });

    it("returns the SAME schema regardless of agent type", () => {
        // The unreachable code below the return says PipelineContext and
        // TaskContext are reserved for createPipelineHandoff/createTaskHandoff.
        // So pipeline and task agents deliberately get the basic schema here.
        const schemas = [
            getSchemaForAgent(agent({ type: "conversation" })),
            getSchemaForAgent(agent({ type: "pipeline" })),
            getSchemaForAgent(agent({ type: "task" })),
            getSchemaForAgent(agent({ name: "totally_different", type: "unknown" })),
        ];

        for (const schema of schemas) {
            expect(schema).toBe(HandoffContext);
        }
    });
});

describe("createContextFilterForAgent", () => {
    it("returns a filter that passes its input through untouched", () => {
        // Identity by value AND by reference: the current filter does not clone,
        // so downstream mutation is observable. A port that starts returning a
        // copy changes aliasing behaviour even if every field still matches.
        const filter = createContextFilterForAgent(agent());
        const data = {
            inputHistory: [{ role: "user", content: "hello" }],
            preHandoffItems: [],
            newItems: [],
        } as never;

        expect(filter(data)).toBe(data);
    });

    it("builds an equivalent filter for every agent type", () => {
        const data = { inputHistory: [], preHandoffItems: [], newItems: [] } as never;

        for (const type of ["conversation", "pipeline", "task"]) {
            expect(createContextFilterForAgent(agent({ type }))(data)).toBe(data);
        }
    });

    it("returns a fresh function per call, not a shared singleton", () => {
        expect(createContextFilterForAgent(agent())).not.toBe(
            createContextFilterForAgent(agent()),
        );
    });
});

describe("getPipelineStateForAgent", () => {
    // Reads a module-level Map that only createPipelineHandoff writes. Worth
    // pinning before the port for two reasons: it is an unused export (no call
    // sites outside this module), and module-level mutable state does not
    // survive reliably across serverless invocations — so anything that comes to
    // depend on it in apps/dhowx would be depending on a coincidence.
    it("returns null for an agent with no stored state", () => {
        expect(getPipelineStateForAgent("never_seen_agent")).toBeNull();
    });

    it("returns null rather than undefined for a missing key", () => {
        // The `|| null` coercion is deliberate; callers null-check.
        const result = getPipelineStateForAgent("also_missing");
        expect(result).toBeNull();
        expect(result).not.toBeUndefined();
    });
});
