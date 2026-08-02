import { Agent, ToolAttachment } from "../../agents/agents.js";
import z from "zod";
import { CopilotInstructions } from "./instructions.js";
import { BuiltinTools } from "../lib/builtin-tools.js";

const tools: Record<string, z.infer<typeof ToolAttachment>> = {};
for (const [name, tool] of Object.entries(BuiltinTools)) {
    tools[name] = {
        type: "builtin",
        name,
    };
}

export const CopilotAgent: z.infer<typeof Agent> = {
    name: "dhowx",
    description: "Dhowx copilot",
    instructions: CopilotInstructions,
    tools,
}