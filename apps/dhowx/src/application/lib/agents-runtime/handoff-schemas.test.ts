import { describe, it, expect } from "vitest";
import {
    HandoffContext,
    PipelineContext,
    TaskContext,
    PipelineExecutionState,
} from "@/src/application/lib/agents-runtime/agents";

/**
 * Characterization tests for the four handoff schemas, ahead of the port into
 * apps/dhowx.
 *
 * These are the wire contract between agents, and they are deliberately loose:
 * almost every field carries a `.default()`, and the flexible fields are
 * `object | string | null` unions with a source comment saying they exist "to
 * handle AI model variations". That looseness is the feature. A model returning
 * a bare string where an object was expected gets tolerated instead of throwing
 * mid-conversation.
 *
 * The hazard in a port is tightening them — dropping a default, narrowing a
 * union to `z.record()`, making a field required. Each of those turns tolerated
 * model output into a runtime error on a live chat, and none of it shows up in
 * typecheck because the inferred TS types barely change.
 */

describe("HandoffContext", () => {
    it("accepts a completely empty object and fills every field", () => {
        // The load-bearing property: an agent that hands off with no context at
        // all still produces a valid, fully-populated context.
        expect(HandoffContext.parse({})).toEqual({
            reason: "direct_handoff",
            parentAgent: "unknown",
            transferCount: 0,
            metadata: null,
        });
    });

    it("accepts all three handoff reasons", () => {
        for (const reason of ["direct_handoff", "pipeline_execution", "task_delegation"]) {
            expect(HandoffContext.parse({ reason }).reason).toBe(reason);
        }
    });

    it("rejects an unknown reason rather than defaulting it", () => {
        // Contrast with the missing-field case: absent falls back to the
        // default, present-but-wrong is an error.
        expect(() => HandoffContext.parse({ reason: "made_up" })).toThrow();
    });

    it("tolerates metadata as an object, a string, or null", () => {
        expect(HandoffContext.parse({ metadata: { k: "v" } }).metadata).toEqual({ k: "v" });
        expect(HandoffContext.parse({ metadata: "just a note" }).metadata).toBe("just a note");
        expect(HandoffContext.parse({ metadata: null }).metadata).toBeNull();
    });

    it("still rejects metadata shapes outside the union", () => {
        expect(() => HandoffContext.parse({ metadata: 42 })).toThrow();
    });
});

describe("PipelineContext", () => {
    it("carries every HandoffContext field plus its own, all defaulted", () => {
        expect(PipelineContext.parse({})).toEqual({
            reason: "direct_handoff",
            parentAgent: "unknown",
            transferCount: 0,
            metadata: null,
            pipelineName: "unknown_pipeline",
            currentStep: 0,
            totalSteps: 1,
            isLastStep: false,
            pipelineData: null,
            stepResults: null,
        });
    });

    it("defaults totalSteps to 1, not 0", () => {
        // A zero default would make `currentStep >= totalSteps - 1` true
        // immediately and mark step 0 as the last step.
        expect(PipelineContext.parse({}).totalSteps).toBe(1);
    });

    it("tolerates stepResults as an array, a string, or null", () => {
        expect(PipelineContext.parse({ stepResults: [{ ok: 1 }] }).stepResults).toEqual([
            { ok: 1 },
        ]);
        expect(PipelineContext.parse({ stepResults: "step one done" }).stepResults).toBe(
            "step one done",
        );
        expect(PipelineContext.parse({ stepResults: null }).stepResults).toBeNull();
    });
});

describe("TaskContext", () => {
    it("carries every HandoffContext field plus its own, all defaulted", () => {
        expect(TaskContext.parse({})).toEqual({
            reason: "direct_handoff",
            parentAgent: "unknown",
            transferCount: 0,
            metadata: null,
            taskType: "general_task",
            priority: "medium",
            deadline: null,
            requirements: null,
            resources: null,
        });
    });

    it("accepts the three priorities and rejects others", () => {
        for (const priority of ["low", "medium", "high"]) {
            expect(TaskContext.parse({ priority }).priority).toBe(priority);
        }
        expect(() => TaskContext.parse({ priority: "urgent" })).toThrow();
    });

    it("accepts a deadline that is not a valid datetime", () => {
        // The union is `datetime | string | null`, so the datetime branch is
        // effectively decorative — any string passes via the second branch.
        // Pinned because it looks like validation and is not.
        expect(TaskContext.parse({ deadline: "next tuesday" }).deadline).toBe("next tuesday");
        expect(TaskContext.parse({ deadline: "2026-08-03T12:00:00Z" }).deadline).toBe(
            "2026-08-03T12:00:00Z",
        );
    });
});

describe("PipelineExecutionState", () => {
    // Unlike the three context schemas, this one has genuinely required fields.
    // It is internal state the state manager builds, not model output.
    it("rejects an empty object", () => {
        expect(() => PipelineExecutionState.parse({})).toThrow();
    });

    it("requires pipelineName, currentStep, totalSteps, callingAgent and startTime", () => {
        const complete = {
            pipelineName: "billing_flow",
            currentStep: 0,
            totalSteps: 3,
            callingAgent: "orchestrator",
            startTime: "2026-08-03T12:00:00.000Z",
        };
        expect(() => PipelineExecutionState.parse(complete)).not.toThrow();

        for (const key of Object.keys(complete)) {
            const missing = { ...complete } as Record<string, unknown>;
            delete missing[key];
            expect(() => PipelineExecutionState.parse(missing), `missing ${key}`).toThrow();
        }
    });

    it("enforces datetime format on startTime", () => {
        // The only field in any of these schemas with real format validation.
        expect(() =>
            PipelineExecutionState.parse({
                pipelineName: "billing_flow",
                currentStep: 0,
                totalSteps: 3,
                callingAgent: "orchestrator",
                startTime: "not a timestamp",
            }),
        ).toThrow();
    });

    it("defaults the three result fields to null", () => {
        const state = PipelineExecutionState.parse({
            pipelineName: "billing_flow",
            currentStep: 0,
            totalSteps: 3,
            callingAgent: "orchestrator",
            startTime: "2026-08-03T12:00:00.000Z",
        });

        expect(state.pipelineData).toBeNull();
        expect(state.stepResults).toBeNull();
        expect(state.currentStepResult).toBeNull();
        expect(state.metadata).toBeNull();
    });
});
