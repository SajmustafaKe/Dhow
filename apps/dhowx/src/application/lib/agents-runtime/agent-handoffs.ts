// Agent handoffs using OpenAI Agents SDK native capabilities
import { Agent, handoff, Handoff, HandoffInputData, RunItem } from "@openai/agents";
import { z } from "zod";
import { PrefixLogger } from "@/app/lib/utils";
import { WorkflowAgent } from "@/app/lib/types/workflow_types";
import {
    HandoffContext, 
    PipelineContext, 
    TaskContext, 
    PipelineExecutionState 
} from "./agents";

export type HandoffContextType = 'pipeline' | 'task' | 'direct';

export interface AgentHandoffConfig {
    inputSchema?: z.ZodObject;
    onHandoff?: (context: unknown, input: unknown) => void;
    inputFilter?: (data: HandoffInputData) => HandoffInputData;
    logger?: PrefixLogger;
}

// Get default schema based on context type
function getDefaultSchemaForContext(contextType: HandoffContextType): z.ZodObject {
    switch (contextType) {
        case 'pipeline':
            return PipelineContext;
        case 'task':
            return TaskContext;
        case 'direct':
        default:
            return HandoffContext;
    }
}

// Create context-aware input filter
function createDefaultInputFilter(contextType: HandoffContextType) {
    return (data: HandoffInputData): HandoffInputData => {
        switch (contextType) {
            case 'pipeline':
                return filterForPipeline(data);
            case 'task':
                return filterForTask(data);
            case 'direct':
            default:
                return data; // Pass through all context for direct handoffs
        }
    };
}

// Filter context for pipeline execution
function filterForPipeline(data: HandoffInputData): HandoffInputData {
    // Keep recent context relevant to pipeline execution
    const maxHistoryItems = 10; // Configurable limit
    
    return {
        ...data,
        inputHistory: Array.isArray(data.inputHistory) 
            ? data.inputHistory.slice(-maxHistoryItems)
            : data.inputHistory,
        // Filter out non-pipeline related tool calls
        preHandoffItems: data.preHandoffItems.filter((item) => {
            // `type` here is one of the SDK's real RunItem discriminants (e.g.
            // 'tool_call_item'), never the legacy 'message' | 'tool_call' values this
            // predicate was written against, and RunItem never carried a `.name` field.
            // Both clauses were therefore already unreachable for any real handoff item;
            // String()-widening keeps that exact always-false result instead of "fixing"
            // it to match today's SDK, which would change what a pipeline handoff
            // forwards — a behavior change out of scope for this cleanup.
            const itemType = String(item.type);
            return !itemType || itemType === 'message' || itemType === 'tool_call';
        })
    };
}

// Filter context for task delegation
function filterForTask(data: HandoffInputData): HandoffInputData {
    // Keep task-relevant context only
    const maxHistoryItems = 20; // Tasks may need more context
    
    return {
        ...data,
        inputHistory: Array.isArray(data.inputHistory)
            ? data.inputHistory.slice(-maxHistoryItems)
            : data.inputHistory,
        // Keep all items for task context
        preHandoffItems: data.preHandoffItems
    };
}

// Create SDK-native handoff with rich context
export function createAgentHandoff(
    targetAgent: Agent,
    contextType: HandoffContextType,
    config: AgentHandoffConfig = {}
): Handoff {
    const inputSchema = config.inputSchema || getDefaultSchemaForContext(contextType);
    const logger = config.logger;
    
    logger?.log(`Creating handoff to ${targetAgent.name} with context type: ${contextType}`);
    
    // Create OpenAI API compliant tool name
    const sanitizedAgentName = targetAgent.name
        .replace(/[^a-zA-Z0-9_-]/g, '_')  // Replace invalid chars with underscore
        .replace(/_+/g, '_')              // Replace multiple underscores with single
        .replace(/^_+|_+$/g, '')          // Remove leading/trailing underscores
        .substring(0, 50);                // Limit length
    
    const toolName = `handoff_to_${sanitizedAgentName}`;
    
    logger?.log(`Creating handoff tool: ${toolName} -> ${targetAgent.name}`);
    
    return handoff(targetAgent, {
        inputType: inputSchema,
        toolNameOverride: toolName,
        toolDescriptionOverride: `Transfer control to ${targetAgent.name} with structured context data`,
        
        onHandoff: async (runContext, inputString) => {
            try {
                const inputStr = typeof inputString === 'string' ? inputString : '{}';
                let input = JSON.parse(inputStr || '{}');
                
                // Validate and enrich the parsed input with defaults
                const schema = config.inputSchema || getDefaultSchemaForContext(contextType);
                const validationResult = schema.safeParse(input);
                
                if (!validationResult.success) {
                    logger?.log(`Handoff input validation failed for ${targetAgent.name}, enriching with defaults:`, validationResult.error.issues.map(i => i.path.join('.') + ': ' + i.message));
                    // Parse with defaults to get a valid object
                    input = schema.parse({});
                    logger?.log(`Using default context for handoff to ${targetAgent.name}`);
                } else {
                    logger?.log(`Handoff input validation succeeded for ${targetAgent.name}`);
                    input = validationResult.data;
                }
                
                logger?.log(`Handoff to ${targetAgent.name} with input:`, input);
                
                // Execute custom handoff logic
                config.onHandoff?.(runContext, input);
                
                // Log the handoff for debugging
                logHandoffEvent(targetAgent.name, contextType, input, logger);
                
            } catch (error) {
                logger?.log(`Error in handoff to ${targetAgent.name}:`, error);
                throw error;
            }
        },
        
        inputFilter: config.inputFilter || createDefaultInputFilter(contextType)
    });
}

// Create handoff for pipeline execution
export function createPipelineHandoff(
    targetAgent: Agent,
    pipelineState: z.infer<typeof PipelineExecutionState>,
    logger?: PrefixLogger
): Handoff {
    const pipelineContext = {
        reason: 'pipeline_execution' as const,
        parentAgent: pipelineState.callingAgent,
        transferCount: 0,
        pipelineName: pipelineState.pipelineName,
        currentStep: pipelineState.currentStep,
        totalSteps: pipelineState.totalSteps,
        isLastStep: pipelineState.currentStep >= pipelineState.totalSteps - 1,
        pipelineData: pipelineState.pipelineData || null,
        stepResults: pipelineState.stepResults || null
    };
    
    return createAgentHandoff(targetAgent, 'pipeline', {
        inputSchema: PipelineContext,
        onHandoff: () => {
            logger?.log(`Pipeline step ${pipelineState.currentStep + 1}/${pipelineState.totalSteps} - handing off to ${targetAgent.name}`);
            
            // Store pipeline state for the target agent
            storePipelineStateForAgent(targetAgent.name, pipelineState);
        },
        inputFilter: (data) => {
            // Inject pipeline context into the conversation
            const contextMessage = createPipelineContextMessage(pipelineContext);

            // BOUNDARY CAST -- audited, kept. `@openai/agents-core`'s exported
            // `RunItem` union is exactly: RunMessageOutputItem | RunToolCallItem |
            // RunToolSearchCallItem | RunToolSearchOutputItem | RunReasoningItem |
            // RunHandoffCallItem | RunToolCallOutputItem | RunHandoffOutputItem |
            // RunToolApprovalItem -- nine concrete classes, none representing an
            // injected system message. The structurally closest one,
            // RunMessageOutputItem, requires `rawItem: protocol.AssistantMessageItem`
            // (a fixed `role: 'assistant'` literal), which does not admit this
            // payload's `role: 'system'`; the SDK's own `protocol.SystemMessageItem`
            // type exists but is never accepted as any RunItem's `rawItem`. Building
            // a real instance would mean either lying about the role (silently
            // turning this handoff-context message into an assistant turn in the
            // transcript forwarded to the next agent) or minting a `role: 'assistant'`
            // message with system-prompt content -- both are behavior changes to what
            // handoff context is actually sent to the model, out of scope for this
            // lint cleanup. No active eslint rule fires on `as unknown as X` (only
            // `as any` trips `@typescript-eslint/no-explicit-any`), so there is
            // nothing to `eslint-disable`; this comment is the durable record instead.
            const pipelineContextItem = {
                type: 'message',
                role: 'system',
                content: contextMessage
            } as unknown as RunItem;

            return {
                ...data,
                newItems: [
                    ...data.newItems,
                    pipelineContextItem
                ]
            };
        },
        logger
    });
}

// Create handoff for task delegation
export function createTaskHandoff(
    targetAgent: Agent,
    taskContext: {
        taskType: string;
        priority: 'low' | 'medium' | 'high';
        parentAgent: string;
        requirements?: string[];
        resources?: Record<string, unknown>;
    },
    logger?: PrefixLogger
): Handoff {
    return createAgentHandoff(targetAgent, 'task', {
        inputSchema: TaskContext,
        onHandoff: () => {
            logger?.log(`Task delegation to ${targetAgent.name}:`, {
                taskType: taskContext.taskType,
                priority: taskContext.priority
            });
        },
        logger
    });
}

// Get schema based on agent configuration
export function getSchemaForAgent(_agentConfig: z.infer<typeof WorkflowAgent>): z.ZodObject {
    // Always start with basic HandoffContext - more specific contexts are used
    // only when explicitly creating pipeline or task handoffs
    return HandoffContext;
    
    // NOTE: PipelineContext and TaskContext are used only in specific creation functions
    // like createPipelineHandoff() and createTaskHandoff(), not for general agent handoffs
}

// Create context filter based on agent configuration
export function createContextFilterForAgent(_agentConfig: z.infer<typeof WorkflowAgent>) {
    return (data: HandoffInputData): HandoffInputData => {
        // Use basic passthrough filtering for regular handoffs
        // Specific filtering is handled by createPipelineHandoff and createTaskHandoff
        return data;
    };
}

// Helper functions
function logHandoffEvent(
    targetAgent: string,
    contextType: string,
    input: Record<string, unknown>,
    logger?: PrefixLogger
) {
    logger?.log(`🔄 SDK HANDOFF: -> ${targetAgent} (${contextType})`, {
        targetAgent,
        contextType,
        hasContext: !!input && Object.keys(input).length > 0
    });
}

// Simple storage for pipeline state (in production, use proper state management)
const pipelineStates = new Map<string, z.infer<typeof PipelineExecutionState>>();

function storePipelineStateForAgent(
    agentName: string, 
    state: z.infer<typeof PipelineExecutionState>
) {
    pipelineStates.set(agentName, state);
}

export function getPipelineStateForAgent(
    agentName: string
): z.infer<typeof PipelineExecutionState> | null {
    return pipelineStates.get(agentName) || null;
}

function createPipelineContextMessage(context: {
    pipelineName: string;
    currentStep: number;
    totalSteps: number;
    isLastStep: boolean;
    pipelineData: z.infer<typeof PipelineExecutionState>['pipelineData'];
    stepResults: z.infer<typeof PipelineExecutionState>['stepResults'];
}): string {
    return `## Pipeline Execution Context
Pipeline: ${context.pipelineName}
Step: ${context.currentStep + 1}/${context.totalSteps}
${context.isLastStep ? '**Final Step**: Provide complete results.' : '**Continue**: Pass results to next step.'}

${context.stepResults && context.stepResults.length > 0 
    ? `Previous Results:\n${JSON.stringify(context.stepResults, null, 2)}`
    : 'No previous results.'
}

${context.pipelineData 
    ? `Pipeline Data:\n${JSON.stringify(context.pipelineData, null, 2)}`
    : ''
}`;
}