import z from "zod";
import { ApprovalPolicy } from "@x/shared/dist/code-mode.js";

export const CodeModeConfig = z.object({
    enabled: z.boolean(),
    // How the ACP engine answers the coding agent's permission requests.
    // Optional for back-compat; the tool defaults to "ask" when unset.
    approvalPolicy: ApprovalPolicy.optional(),
});
export type CodeModeConfig = z.infer<typeof CodeModeConfig>;

export const AgentStatus = z.object({
    installed: z.boolean(),
    signedIn: z.boolean(),
});
export type AgentStatus = z.infer<typeof AgentStatus>;

/**
 * omp's auth cannot be read off disk, so it is verified by an ACP probe that
 * is too slow to block on. `null` = not established yet (render as checking),
 * never as a failure.
 */
export const OmpAgentStatus = AgentStatus.extend({
    authenticated: z.boolean().nullable(),
});
export type OmpAgentStatus = z.infer<typeof OmpAgentStatus>;

export const CodeModeAgentStatus = z.object({
    claude: AgentStatus,
    codex: AgentStatus,
    omp: OmpAgentStatus,
});
export type CodeModeAgentStatus = z.infer<typeof CodeModeAgentStatus>;
