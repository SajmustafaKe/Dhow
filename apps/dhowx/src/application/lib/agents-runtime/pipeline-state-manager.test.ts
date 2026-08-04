import { describe, it, expect, beforeEach, vi } from "vitest";
import { PrefixLogger } from "@/app/lib/utils";

/**
 * Characterization tests for the pipeline state machine, ahead of the port into
 * apps/dhowx.
 *
 * This class decides which agent runs next and when a pipeline is finished.
 * Every failure mode it has is silent: state filed under the wrong key, a step
 * counter off by one, results not cleared on completion. None of it is visible
 * to typecheck, and `apps/dhow` has no other test that touches it.
 *
 * `createPipelineHandoff` is stubbed because the real one calls into
 * `@openai/agents` to build an SDK Handoff. That is the SDK's behaviour, not
 * this module's; what matters here is *that* it is called, with which agent and
 * which state. The stub records those arguments so they can be asserted.
 */

const createPipelineHandoff = vi.hoisted(() =>
    vi.fn((agent: unknown, state: unknown) => ({ __stubHandoff: true, agent, state })),
);

vi.mock("@/src/application/lib/agents-runtime/agent-handoffs", () => ({
    createPipelineHandoff,
}));

// Imported after the mock is registered.
const { PipelineStateManager } = await import(
    "@/src/application/lib/agents-runtime/pipeline-state-manager"
);

type Manager = InstanceType<typeof PipelineStateManager>;

// The manager only ever calls `.agents` and `.description` on a pipeline.
const pipeline = (agents: string[], description = "test pipeline") =>
    ({ name: "billing_flow", description, agents }) as never;

// It only uses the agents map for presence and identity.
const agentsMap = (...names: string[]) =>
    Object.fromEntries(names.map((n) => [n, { name: n }])) as never;

describe("PipelineStateManager", () => {
    let manager: Manager;

    beforeEach(() => {
        // Silence the module's logging; it logs on every transition.
        vi.spyOn(console, "log").mockImplementation(() => {});
        manager = new PipelineStateManager(new PrefixLogger("test"));
    });

    describe("initializePipelineExecution", () => {
        it("files the initial state under the FIRST pipeline agent, not the caller", () => {
            // The caller is a separate agent that the pipeline returns to at the
            // end. Filing state under it instead would strand the first step.
            manager.initializePipelineExecution(
                "billing_flow",
                "orchestrator",
                pipeline(["extract", "validate", "charge"]),
            );

            expect(manager.isAgentInPipeline("extract")).toBe(true);
            expect(manager.isAgentInPipeline("orchestrator")).toBe(false);
        });

        it("starts at step 0 with totalSteps taken from the agent count", () => {
            const state = manager.initializePipelineExecution(
                "billing_flow",
                "orchestrator",
                pipeline(["extract", "validate", "charge"]),
            );

            expect(state.currentStep).toBe(0);
            expect(state.totalSteps).toBe(3);
            expect(state.callingAgent).toBe("orchestrator");
            expect(state.stepResults).toBeNull();
            expect(state.currentStepResult).toBeNull();
        });

        it("defaults absent initial data to null rather than an empty object", () => {
            // Downstream merges branch on `typeof === 'object' && !== null`, so
            // null and {} are not interchangeable here.
            const state = manager.initializePipelineExecution(
                "billing_flow",
                "orchestrator",
                pipeline(["extract"]),
            );
            expect(state.pipelineData).toBeNull();
        });

        it("carries initial data through when supplied", () => {
            const state = manager.initializePipelineExecution(
                "billing_flow",
                "orchestrator",
                pipeline(["extract"]),
                { invoiceId: "inv_1" },
            );
            expect(state.pipelineData).toEqual({ invoiceId: "inv_1" });
        });
    });

    describe("handlePipelineExecution — error paths", () => {
        it("errors when the agent has no pipeline state", async () => {
            const result = await manager.handlePipelineExecution(
                "unknown_agent",
                { billing_flow: pipeline(["extract"]) },
                agentsMap("extract"),
            );

            expect(result.action).toBe("error");
            expect(result.error).toContain("unknown_agent");
        });

        it("errors when the pipeline is missing from configuration", async () => {
            manager.initializePipelineExecution(
                "billing_flow",
                "orchestrator",
                pipeline(["extract", "validate"]),
            );

            const result = await manager.handlePipelineExecution(
                "extract",
                {},
                agentsMap("extract", "validate"),
            );

            expect(result.action).toBe("error");
            expect(result.error).toContain("billing_flow");
        });

        it("errors when the next agent is absent from the agents map", async () => {
            manager.initializePipelineExecution(
                "billing_flow",
                "orchestrator",
                pipeline(["extract", "validate"]),
            );

            const result = await manager.handlePipelineExecution(
                "extract",
                { billing_flow: pipeline(["extract", "validate"]) },
                agentsMap("extract"), // validate missing
            );

            expect(result.action).toBe("error");
            expect(result.error).toContain("validate");
            expect(createPipelineHandoff).not.toHaveBeenCalled();
        });
    });

    describe("handlePipelineExecution — advancing", () => {
        const config = { billing_flow: pipeline(["extract", "validate", "charge"]) };

        beforeEach(() => {
            manager.initializePipelineExecution(
                "billing_flow",
                "orchestrator",
                config.billing_flow,
            );
        });

        it("hands off to the next agent and moves the state key with it", async () => {
            const result = await manager.handlePipelineExecution(
                "extract",
                config,
                agentsMap("extract", "validate", "charge"),
            );

            expect(result.action).toBe("handoff");
            expect(result.nextAgent).toBe("validate");
            expect(manager.isAgentInPipeline("validate")).toBe(true);
            expect(manager.getPipelineState("validate")?.currentStep).toBe(1);
        });

        it("builds the SDK handoff with the next agent and the advanced state", async () => {
            await manager.handlePipelineExecution(
                "extract",
                config,
                agentsMap("extract", "validate", "charge"),
            );

            expect(createPipelineHandoff).toHaveBeenCalledTimes(1);
            const [agent, state] = createPipelineHandoff.mock.calls[0];
            expect(agent).toMatchObject({ name: "validate" });
            expect(state).toMatchObject({ currentStep: 1, totalSteps: 3 });
        });

        it("reports isLastStep only on the final transition", async () => {
            const agents = agentsMap("extract", "validate", "charge");

            const first = await manager.handlePipelineExecution("extract", config, agents);
            expect(first.context!.isLastStep).toBe(false);

            const second = await manager.handlePipelineExecution("validate", config, agents);
            expect(second.context!.isLastStep).toBe(true);
            expect(second.nextAgent).toBe("charge");
        });

        it("accumulates step results and resets currentStepResult each step", async () => {
            const agents = agentsMap("extract", "validate", "charge");

            await manager.handlePipelineExecution("extract", config, agents, { ok: 1 });
            const afterFirst = manager.getPipelineState("validate");
            expect(afterFirst?.stepResults).toEqual([{ ok: 1 }]);
            // Reset so the next agent cannot read the previous agent's result as
            // its own.
            expect(afterFirst?.currentStepResult).toBeNull();

            await manager.handlePipelineExecution("validate", config, agents, { ok: 2 });
            expect(manager.getPipelineState("charge")?.stepResults).toEqual([
                { ok: 1 },
                { ok: 2 },
            ]);
        });

        it("shallow-merges pipelineData forward, later steps winning", async () => {
            const agents = agentsMap("extract", "validate", "charge");

            await manager.handlePipelineExecution("extract", config, agents, {
                pipelineData: { invoiceId: "inv_1", amount: 100 },
            });
            await manager.handlePipelineExecution("validate", config, agents, {
                pipelineData: { amount: 250 },
            });

            expect(manager.getPipelineState("charge")?.pipelineData).toEqual({
                invoiceId: "inv_1",
                amount: 250,
            });
        });
    });

    describe("handlePipelineExecution — completion", () => {
        const config = { billing_flow: pipeline(["extract", "validate"]) };

        it("completes on the last step and returns to the calling agent", async () => {
            manager.initializePipelineExecution(
                "billing_flow",
                "orchestrator",
                config.billing_flow,
            );
            const agents = agentsMap("extract", "validate");

            await manager.handlePipelineExecution("extract", config, agents);
            const done = await manager.handlePipelineExecution("validate", config, agents, {
                ok: true,
            });

            expect(done.action).toBe("complete");
            expect(done.returnToAgent).toBe("orchestrator");
            expect(done.results!.pipelineName).toBe("billing_flow");
            expect(done.results!.stepResults).toEqual([{ ok: true }]);
        });

        it("clears the finishing agent's state so the pipeline cannot re-run", async () => {
            manager.initializePipelineExecution(
                "billing_flow",
                "orchestrator",
                config.billing_flow,
            );
            const agents = agentsMap("extract", "validate");

            await manager.handlePipelineExecution("extract", config, agents);
            await manager.handlePipelineExecution("validate", config, agents);

            expect(manager.isAgentInPipeline("validate")).toBe(false);
            const rerun = await manager.handlePipelineExecution("validate", config, agents);
            expect(rerun.action).toBe("error");
        });

        it("completes immediately for a single-agent pipeline", async () => {
            const solo = { billing_flow: pipeline(["only"]) };
            manager.initializePipelineExecution("billing_flow", "orchestrator", solo.billing_flow);

            const done = await manager.handlePipelineExecution(
                "only",
                solo,
                agentsMap("only"),
            );

            expect(done.action).toBe("complete");
            expect(createPipelineHandoff).not.toHaveBeenCalled();
        });
    });

    describe("state bookkeeping", () => {
        it("reports no state for an unknown agent as null, not undefined", () => {
            expect(manager.getPipelineState("nobody")).toBeNull();
        });

        it("clearPipelineState removes only the named agent", () => {
            manager.initializePipelineExecution(
                "billing_flow",
                "orchestrator",
                pipeline(["a", "b"]),
            );
            manager.storePipelineState("b", manager.getPipelineState("a")!);

            manager.clearPipelineState("a");

            expect(manager.isAgentInPipeline("a")).toBe(false);
            expect(manager.isAgentInPipeline("b")).toBe(true);
        });

        it("lists active pipelines for monitoring", () => {
            manager.initializePipelineExecution(
                "billing_flow",
                "orchestrator",
                pipeline(["a", "b"]),
            );

            const active = manager.getActivePipelines();
            expect(active).toHaveLength(1);
            expect(active[0].agentName).toBe("a");
        });
    });

    describe("handlePipelineError", () => {
        // Counter-intuitive and load-bearing: a pipeline failure is reported as
        // action 'complete', not 'error', with the message tucked inside
        // `results.error`. The pipeline is over, and control returns to the
        // calling agent so *it* can decide what to say. Only an unknown agent,
        // or an explicit `shouldReturnToCaller: false`, yields action 'error'.
        //
        // Pinned because it reads like a bug and a port would "fix" it, which
        // would silently change every caller's control flow.
        it("reports a recoverable failure as complete, returning to the caller", () => {
            manager.initializePipelineExecution(
                "billing_flow",
                "orchestrator",
                pipeline(["a", "b"]),
            );

            const result = manager.handlePipelineError("a", new Error("charge declined"));

            expect(result.action).toBe("complete");
            expect(result.error).toBeUndefined();
            expect(result.results!.error).toBe("charge declined");
            expect(result.returnToAgent).toBe("orchestrator");
        });

        it("drops the failing agent's state", () => {
            manager.initializePipelineExecution(
                "billing_flow",
                "orchestrator",
                pipeline(["a", "b"]),
            );

            manager.handlePipelineError("a", new Error("charge declined"));

            expect(manager.isAgentInPipeline("a")).toBe(false);
        });

        it("reports progress made before the failure", () => {
            manager.initializePipelineExecution(
                "billing_flow",
                "orchestrator",
                pipeline(["a", "b", "c"]),
            );

            const result = manager.handlePipelineError("a", "upstream timeout");

            expect(result.results).toMatchObject({
                pipelineName: "billing_flow",
                error: "upstream timeout",
                completedSteps: 0,
                totalSteps: 3,
            });
        });

        it("accepts a bare string as well as an Error", () => {
            manager.initializePipelineExecution(
                "billing_flow",
                "orchestrator",
                pipeline(["a", "b"]),
            );

            const result = manager.handlePipelineError("a", "upstream timeout");
            expect(result.results!.error).toBe("upstream timeout");
        });

        it("yields a true error when told not to return to the caller", () => {
            manager.initializePipelineExecution(
                "billing_flow",
                "orchestrator",
                pipeline(["a", "b"]),
            );

            const result = manager.handlePipelineError("a", "fatal", false);

            expect(result.action).toBe("error");
            expect(result.error).toBe("fatal");
            // Not cleared on this branch — only the return-to-caller path cleans up.
            expect(manager.isAgentInPipeline("a")).toBe(true);
        });

        it("yields a true error for an agent with no pipeline state", () => {
            const result = manager.handlePipelineError("nobody", "stray failure");

            expect(result.action).toBe("error");
            expect(result.error).toBe("stray failure");
        });
    });
});
