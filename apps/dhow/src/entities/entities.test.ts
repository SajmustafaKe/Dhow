import { describe, it, expect } from "vitest";
import { User } from "@/src/entities/models/user";
import { Turn, Reason, CachedTurnRequest, TurnEvent } from "@/src/entities/models/turn";
import { ScheduledJobRule } from "@/src/entities/models/scheduled-job-rule";
import { RecurringJobRule } from "@/src/entities/models/recurring-job-rule";
import { ProjectMember } from "@/src/entities/models/project-member";
import { Project, ComposioConnectedAccount, CustomMcpServer } from "@/src/entities/models/project";
import { Job } from "@/src/entities/models/job";
import { DataSourceDoc } from "@/src/entities/models/data-source-doc";
import { DataSource } from "@/src/entities/models/data-source";
import {
    DataSourceSchemaForCopilot,
    ScheduledJobRuleSchemaForCopilot,
    RecurringJobRuleSchemaForCopilot,
    ComposioTriggerDeploymentSchemaForCopilot,
    TriggerSchemaForCopilot,
    CopilotAssistantMessageActionPart,
    CopilotChatContext,
    CopilotAPIRequest,
    CopilotAPIResponse,
    CopilotStreamEvent,
} from "@/src/entities/models/copilot";
import { Conversation } from "@/src/entities/models/conversation";
import { ComposioTriggerType } from "@/src/entities/models/composio-trigger-type";
import { AssistantTemplate, AssistantTemplateLike } from "@/src/entities/models/assistant-template";
import { ComposioTriggerDeployment } from "@/src/entities/models/composio-trigger-deployment";
import { ApiKey } from "@/src/entities/models/api-key";
import { JobAcquisitionError } from "@/src/entities/errors/job-errors";
import { BillingError, QuotaExceededError, BadRequestError, NotFoundError, NotAuthorizedError } from "@/src/entities/errors/common";
import { PaginatedList } from "@/src/entities/common/paginated-list";
import {
    SystemMessage as ApiSystemMessage,
    UserMessage as ApiUserMessage,
    AssistantMessage as ApiAssistantMessage,
    AssistantMessageWithToolCalls as ApiAssistantMessageWithToolCalls,
    ToolMessage as ApiToolMessage,
    ChatMessage,
    ChatCloseReason,
    ChatUserData,
    Chat,
    ApiCreateChatRequest,
    ApiCreateChatResponse,
    ApiGetChatResponse,
    ApiGetChatsResponse,
    ApiChatTurnRequest,
    ApiChatTurnResponse,
    ApiGetChatMessagesResponse,
    ApiCreateGuestSessionRequest,
    ApiCreateGuestSessionResponse,
    ApiCreateUserSessionRequest,
    ApiCreateUserSessionResponse,
} from "@/src/entities/models/api-v1";

/**
 * Characterization tests for the domain schemas (entities) ahead of the dhow -> dhowx
 * port. Zod schemas are the wire/storage contract: a field that quietly becomes
 * required (or loses a `.default()`, or a union gets tightened) is invisible to
 * `tsc` and only surfaces when real production data hits it. Every assertion here
 * pins an observed, non-obvious behavior — not just "the type looks like X".
 */

const iso = () => new Date().toISOString();

const validWorkflow = () => ({
    agents: [],
    prompts: [],
    tools: [],
    startAgent: "start",
    lastUpdatedAt: iso(),
});

const validMessage = () => ({ role: "system" as const, content: "hi" });

// Deletes each named key from a valid payload, one at a time, and asserts the
// schema rejects the result. "parse({}) throws" only proves SOME field is
// required; this proves EACH named field individually is — so a mutation
// that loosens exactly one required field to optional cannot hide behind the
// other required fields still being present.
function expectRequiredKeys(
    schema: { safeParse: (v: unknown) => { success: boolean } },
    valid: Record<string, unknown>,
    keys: string[],
) {
    for (const key of keys) {
        const clone = { ...valid };
        delete clone[key];
        expect(schema.safeParse(clone).success, `expected "${key}" to be required`).toBe(false);
    }
}

// ---------------------------------------------------------------------------
// user.ts
// ---------------------------------------------------------------------------
describe("User", () => {
    it("requires id, supabaseId and createdAt; parse({}) throws", () => {
        expect(User.safeParse({}).success).toBe(false);
    });

    it("accepts the minimal required shape with every optional field omitted", () => {
        const r = User.safeParse({ id: "u1", supabaseId: "a1", createdAt: iso() });
        expect(r.success).toBe(true);
    });

    // createdAt uses the strict `.datetime()` format, not a bare string — a
    // non-ISO value must be rejected, otherwise storage round-trips silently
    // accept garbage timestamps.
    it("rejects a non-ISO createdAt", () => {
        const r = User.safeParse({ id: "u1", supabaseId: "a1", createdAt: "not-a-date" });
        expect(r.success).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// turn.ts
// ---------------------------------------------------------------------------
describe("Reason (turn.ts)", () => {
    it("is a closed discriminated union: unknown `type` is rejected", () => {
        expect(Reason.safeParse({ type: "webhook" }).success).toBe(false);
    });

    it("job reason requires jobId; chat/api reasons need only `type`", () => {
        expect(Reason.safeParse({ type: "job" }).success).toBe(false);
        expect(Reason.safeParse({ type: "job", jobId: "j1" }).success).toBe(true);
        expect(Reason.safeParse({ type: "chat" }).success).toBe(true);
        expect(Reason.safeParse({ type: "api" }).success).toBe(true);
    });
});

describe("Turn", () => {
    const validTurn = () => ({
        id: "t1",
        reason: { type: "chat" as const },
        input: { messages: [] },
        output: [],
        createdAt: iso(),
    });

    it("parse({}) throws — id, reason, input, output, createdAt are all required", () => {
        expect(Turn.safeParse({}).success).toBe(false);
    });

    it("accepts the minimal shape; error/isBillingError/updatedAt are optional", () => {
        expect(Turn.safeParse(validTurn()).success).toBe(true);
    });

    // input.mockTools is BOTH nullable and optional — three legal states, not two.
    // Losing either modifier changes which of these three payloads gets rejected.
    it("input.mockTools accepts omitted, null, and a string record — but not a non-string value", () => {
        const base = validTurn();
        expect(Turn.safeParse(base).success).toBe(true);
        expect(Turn.safeParse({ ...base, input: { ...base.input, mockTools: null } }).success).toBe(true);
        expect(Turn.safeParse({ ...base, input: { ...base.input, mockTools: { a: "b" } } }).success).toBe(true);
        expect(Turn.safeParse({ ...base, input: { ...base.input, mockTools: { a: 1 } } }).success).toBe(false);
    });
});

describe("CachedTurnRequest", () => {
    // CachedTurnRequest.input reuses Turn.shape.input by reference rather than
    // redeclaring it. Proven behaviorally: a payload that only Turn's actual
    // input schema accepts (mockTools: null) must also validate here. If a port
    // redefines this field instead of reusing the reference, this is the test
    // that would catch the divergence even though it "looks" the same.
    it("shares Turn's exact input schema, including the mockTools nullable/optional modifiers", () => {
        const r = CachedTurnRequest.safeParse({
            conversationId: "c1",
            input: { messages: [], mockTools: null },
        });
        expect(r.success).toBe(true);
        expect(CachedTurnRequest.shape.input).toBe(Turn.shape.input);
    });
});

describe("TurnEvent", () => {
    it("'message' event carries a Message payload", () => {
        expect(TurnEvent.safeParse({ type: "message", data: validMessage() }).success).toBe(true);
    });

    it("'error' event requires `error`; isBillingError is optional", () => {
        expect(TurnEvent.safeParse({ type: "error", error: "boom" }).success).toBe(true);
        expect(TurnEvent.safeParse({ type: "error" }).success).toBe(false);
    });

    it("'done' event requires conversationId and a full Turn", () => {
        const r = TurnEvent.safeParse({
            type: "done",
            conversationId: "c1",
            turn: {
                id: "t1",
                reason: { type: "chat" },
                input: { messages: [] },
                output: [],
                createdAt: iso(),
            },
        });
        expect(r.success).toBe(true);
    });

    it("rejects an event type outside the closed set", () => {
        expect(TurnEvent.safeParse({ type: "progress" }).success).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// scheduled-job-rule.ts
// ---------------------------------------------------------------------------
describe("ScheduledJobRule", () => {
    const valid = () => ({
        id: "r1",
        projectId: "p1",
        input: { messages: [] },
        nextRunAt: iso(),
        workerId: null,
        lastWorkerId: null,
        status: "pending" as const,
        createdAt: iso(),
    });

    it("accepts the minimal shape; output/processedAt/updatedAt are optional", () => {
        expect(ScheduledJobRule.safeParse(valid()).success).toBe(true);
    });

    // workerId/lastWorkerId are `.nullable()` WITHOUT `.optional()` — the key
    // must be present (explicit null), it cannot simply be left out.
    it("workerId/lastWorkerId are required keys even though their value may be null", () => {
        const { workerId, ...rest } = valid();
        expect(ScheduledJobRule.safeParse(rest).success).toBe(false);
        expect(ScheduledJobRule.safeParse({ ...rest, workerId: null }).success).toBe(true);
    });

    it("status is a closed 3-value enum", () => {
        expect(ScheduledJobRule.safeParse({ ...valid(), status: "done" }).success).toBe(false);
    });

    // nextRunAt is `.datetime()` (strict ISO) but createdAt is a bare `.string()`.
    // Same "when did this happen" concept, two different strictness levels in
    // the same object — this is the kind of asymmetry a port is likely to
    // "fix" by accident, silently rejecting previously-valid stored rows.
    it("nextRunAt must be a valid ISO datetime; createdAt accepts any string", () => {
        expect(ScheduledJobRule.safeParse({ ...valid(), nextRunAt: "not-a-date" }).success).toBe(false);
        expect(ScheduledJobRule.safeParse({ ...valid(), createdAt: "not-a-date-at-all" }).success).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// recurring-job-rule.ts
// ---------------------------------------------------------------------------
describe("RecurringJobRule", () => {
    const valid = () => ({
        id: "r1",
        projectId: "p1",
        input: { messages: [] },
        cron: "* * * * *",
        nextRunAt: iso(),
        workerId: null,
        lastWorkerId: null,
        disabled: false,
        createdAt: iso(),
    });

    it("accepts the minimal shape", () => {
        expect(RecurringJobRule.safeParse(valid()).success).toBe(true);
    });

    // `disabled` is required (no `.optional()`, no `.default()`) even though it
    // reads like a toggle that could reasonably default to false.
    it("disabled is required, not defaulted — omitting it throws", () => {
        const { disabled, ...rest } = valid();
        expect(RecurringJobRule.safeParse(rest).success).toBe(false);
    });

    // cron has no cron-expression format validation at all: any string passes.
    it("cron accepts an arbitrary string — there is no cron-format validation", () => {
        expect(RecurringJobRule.safeParse({ ...valid(), cron: "definitely not a cron expression" }).success).toBe(true);
    });

    it("nextRunAt is strict ISO datetime; createdAt is a bare string (same asymmetry as ScheduledJobRule)", () => {
        expect(RecurringJobRule.safeParse({ ...valid(), nextRunAt: "nope" }).success).toBe(false);
        expect(RecurringJobRule.safeParse({ ...valid(), createdAt: "nope" }).success).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// project-member.ts
// ---------------------------------------------------------------------------
describe("ProjectMember", () => {
    it("requires all fields, and unlike the job-rule entities, createdAt IS strict ISO datetime here", () => {
        const valid = { id: "m1", userId: "u1", projectId: "p1", createdAt: iso(), lastUpdatedAt: iso() };
        expect(ProjectMember.safeParse(valid).success).toBe(true);
        expect(ProjectMember.safeParse({ ...valid, createdAt: "not-a-date" }).success).toBe(false);
        expect(ProjectMember.safeParse({}).success).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// project.ts
// ---------------------------------------------------------------------------
describe("Project / ComposioConnectedAccount / CustomMcpServer", () => {
    const valid = () => ({
        id: "550e8400-e29b-41d4-a716-446655440000",
        name: "p",
        createdAt: iso(),
        createdByUserId: "u1",
        secret: "s",
        draftWorkflow: validWorkflow(),
        liveWorkflow: validWorkflow(),
    });

    it("parse({}) throws", () => {
        expect(Project.safeParse({}).success).toBe(false);
    });

    // id is `.uuid()` — a plain non-uuid string id (e.g. a Mongo ObjectId
    // string) is rejected outright.
    it("id must be an RFC uuid, not just any string", () => {
        expect(Project.safeParse(valid()).success).toBe(true);
        expect(Project.safeParse({ ...valid(), id: "not-a-uuid" }).success).toBe(false);
    });

    // webhookUrl has NO url-format validation — it's typed `z.string().optional()`.
    it("webhookUrl accepts any string, not just a well-formed URL", () => {
        expect(Project.safeParse({ ...valid(), webhookUrl: "definitely not a url" }).success).toBe(true);
    });

    it("composioConnectedAccounts/customMcpServers are optional records", () => {
        expect(Project.safeParse(valid()).success).toBe(true);
    });

    it("ComposioConnectedAccount.status is a closed 3-value enum", () => {
        const acc = { id: "a1", authConfigId: "c1", status: "ACTIVE" as const, createdAt: iso(), lastUpdatedAt: iso() };
        expect(ComposioConnectedAccount.safeParse(acc).success).toBe(true);
        expect(ComposioConnectedAccount.safeParse({ ...acc, status: "PENDING" }).success).toBe(false);
    });

    it("CustomMcpServer.serverUrl also has no url-format validation", () => {
        expect(CustomMcpServer.safeParse({ serverUrl: "not-a-url" }).success).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// job.ts
// ---------------------------------------------------------------------------
describe("Job", () => {
    const valid = () => ({
        id: "j1",
        reason: { type: "composio_trigger" as const, triggerId: "t1", triggerDeploymentId: "d1", triggerTypeSlug: "s1", payload: {} },
        projectId: "p1",
        input: { messages: [] },
        workerId: null,
        lastWorkerId: null,
        status: "pending" as const,
        createdAt: iso(),
    });

    it("accepts the minimal shape across all three reason variants", () => {
        expect(Job.safeParse(valid()).success).toBe(true);
        expect(Job.safeParse({ ...valid(), reason: { type: "scheduled_job_rule", ruleId: "r1" } }).success).toBe(true);
        expect(Job.safeParse({ ...valid(), reason: { type: "recurring_job_rule", ruleId: "r1" } }).success).toBe(true);
    });

    // composioTriggerReason.payload is `.passthrough()` — arbitrary vendor
    // webhook fields survive parsing. Everywhere else in this object,
    // zod's default strip-mode silently drops unknown keys. Losing the
    // `.passthrough()` here would start dropping real webhook data.
    it("reason.payload keeps unknown keys (passthrough), but the Job object itself strips them", () => {
        const requestBody = {
            ...valid(),
            reason: {
                type: "composio_trigger" as const,
                triggerId: "t1",
                triggerDeploymentId: "d1",
                triggerTypeSlug: "s1",
                payload: { customVendorField: "kept" },
            },
            extraTopLevelField: "should be stripped",
        };
        const r = Job.safeParse(requestBody);
        expect(r.success).toBe(true);
        if (r.success) {
            expect("extraTopLevelField" in r.data).toBe(false);
            if (r.data.reason.type === "composio_trigger") {
                expect(r.data.reason.payload.customVendorField).toBe("kept");
            } else {
                throw new Error("expected composio_trigger reason to survive parsing");
            }
        }
    });

    it("output's nested fields are all optional, so output: {} is valid", () => {
        expect(Job.safeParse({ ...valid(), output: {} }).success).toBe(true);
    });

    it("rejects an unknown reason.type (closed discriminated union)", () => {
        expect(Job.safeParse({ ...valid(), reason: { type: "manual" } }).success).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// data-source-doc.ts
// ---------------------------------------------------------------------------
describe("DataSourceDoc", () => {
    const base = () => ({
        id: "d1",
        sourceId: "s1",
        projectId: "p1",
        name: "n",
        version: 1,
        status: "ready" as const,
        content: null,
        createdAt: iso(),
        lastUpdatedAt: null,
        attempts: 0,
        error: null,
    });

    it("data is a closed discriminated union with a different required shape per type", () => {
        expect(DataSourceDoc.safeParse({ ...base(), data: { type: "url", url: "https://x" } }).success).toBe(true);
        expect(DataSourceDoc.safeParse({ ...base(), data: { type: "text", content: "hi" } }).success).toBe(true);
        // file_local requires name/size/mimeType/path; missing path -> rejected
        expect(DataSourceDoc.safeParse({ ...base(), data: { type: "file_local", name: "n", size: 1, mimeType: "t" } }).success).toBe(false);
        // wrong fields for the given type (s3Key on a url doc) are rejected
        expect(DataSourceDoc.safeParse({ ...base(), data: { type: "url", s3Key: "x" } }).success).toBe(false);
    });

    // content/lastUpdatedAt/error are `.nullable()` without `.optional()`:
    // omitting the key entirely must fail even though null is legal.
    it("content, lastUpdatedAt and error are required keys that may hold null", () => {
        const { content, ...rest } = { ...base(), data: { type: "url" as const, url: "https://x" } };
        expect(DataSourceDoc.safeParse(rest).success).toBe(false);
    });

    it("lastUpdatedAt is nullable AND strict datetime — a garbage string still fails even though null is allowed", () => {
        const doc = { ...base(), data: { type: "url" as const, url: "https://x" } };
        expect(DataSourceDoc.safeParse({ ...doc, lastUpdatedAt: "not-a-date" }).success).toBe(false);
        expect(DataSourceDoc.safeParse({ ...doc, lastUpdatedAt: null }).success).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// data-source.ts
// ---------------------------------------------------------------------------
describe("DataSource", () => {
    const base = () => ({
        id: "s1",
        name: "n",
        description: "d",
        projectId: "p1",
        status: "ready" as const,
        version: 1,
        error: null,
        billingError: null,
        createdAt: iso(),
        lastUpdatedAt: null,
        attempts: 0,
        lastAttemptAt: null,
        data: { type: "urls" as const },
    });

    // active is the ONLY defaulted field in the whole file: `.default(true)`.
    it("active defaults to exactly `true` when omitted, and is not overridden by falsy coercion", () => {
        const r = DataSource.safeParse(base());
        expect(r.success).toBe(true);
        if (r.success) expect(r.data.active).toBe(true);

        const r2 = DataSource.safeParse({ ...base(), active: false });
        expect(r2.success).toBe(true);
        if (r2.success) expect(r2.data.active).toBe(false);
    });

    // Unlike DataSourceDoc's `data` union, DataSource's variants carry ONLY the
    // discriminant literal — no url/name/size/etc. This is the source-level
    // summary type, not the per-doc record; passing doc-shaped fields here is
    // silently accepted and stripped since they aren't declared.
    it("data variants declare only the `type` literal — extra doc-shaped fields are silently stripped, not rejected", () => {
        const r = DataSource.safeParse({ ...base(), data: { type: "urls", url: "https://x" } });
        expect(r.success).toBe(true);
        if (r.success) expect("url" in r.data.data).toBe(false);
    });

    it("rejects an unknown data.type", () => {
        expect(DataSource.safeParse({ ...base(), data: { type: "rss" } }).success).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// copilot.ts
// ---------------------------------------------------------------------------
describe("copilot.ts derived schemas", () => {
    it("DataSourceSchemaForCopilot picks id/name/description/data only — `active` is not part of the contract at all", () => {
        const r = DataSourceSchemaForCopilot.safeParse({ id: "s1", name: "n", description: "d", data: { type: "urls" } });
        expect(r.success).toBe(true);
        if (r.success) expect("active" in r.data).toBe(false);
    });

    it("ScheduledJobRuleSchemaForCopilot still enforces ScheduledJobRule's status enum and fixes type to 'one_time'", () => {
        const valid = { id: "r1", nextRunAt: iso(), status: "pending", input: { messages: [] }, type: "one_time", name: "n" };
        expect(ScheduledJobRuleSchemaForCopilot.safeParse(valid).success).toBe(true);
        expect(ScheduledJobRuleSchemaForCopilot.safeParse({ ...valid, status: "bogus" }).success).toBe(false);
        expect(ScheduledJobRuleSchemaForCopilot.safeParse({ ...valid, type: "recurring" }).success).toBe(false);
    });

    it("RecurringJobRuleSchemaForCopilot still requires `disabled` (inherited, not defaulted)", () => {
        const valid = { id: "r1", cron: "* * * * *", nextRunAt: iso(), disabled: false, input: { messages: [] }, type: "recurring", name: "n" };
        expect(RecurringJobRuleSchemaForCopilot.safeParse(valid).success).toBe(true);
        const { disabled, ...rest } = valid;
        expect(RecurringJobRuleSchemaForCopilot.safeParse(rest).success).toBe(false);
    });

    it("TriggerSchemaForCopilot dispatches each of the three trigger shapes by its literal `type`", () => {
        const scheduled = { id: "r1", nextRunAt: iso(), status: "pending", input: { messages: [] }, type: "one_time", name: "n" };
        const recurring = { id: "r1", cron: "* * * * *", nextRunAt: iso(), disabled: false, input: { messages: [] }, type: "recurring", name: "n" };
        const external = { id: "d1", triggerTypeName: "t", toolkitSlug: "tk", triggerTypeSlug: "ts", triggerConfig: {}, type: "external" };
        expect(TriggerSchemaForCopilot.safeParse(scheduled).success).toBe(true);
        expect(TriggerSchemaForCopilot.safeParse(recurring).success).toBe(true);
        expect(TriggerSchemaForCopilot.safeParse(external).success).toBe(true);
        expect(TriggerSchemaForCopilot.safeParse({ ...external, type: "internal" }).success).toBe(false);
        void ComposioTriggerDeploymentSchemaForCopilot; // referenced for completeness of the union above
    });

    it("CopilotAssistantMessageActionPart.content.config_type is a closed 8-value enum; error is optional", () => {
        const valid = {
            type: "action",
            content: {
                config_type: "tool",
                action: "create_new",
                name: "n",
                change_description: "d",
                config_changes: {},
            },
        };
        expect(CopilotAssistantMessageActionPart.safeParse(valid).success).toBe(true);
        expect(CopilotAssistantMessageActionPart.safeParse({
            ...valid,
            content: { ...valid.content, config_type: "widget" },
        }).success).toBe(false);
    });

    it("CopilotChatContext dispatches on `type` (chat/agent/tool/prompt) even without discriminatedUnion", () => {
        expect(CopilotChatContext.safeParse({ type: "chat", messages: [] }).success).toBe(true);
        expect(CopilotChatContext.safeParse({ type: "agent", name: "a" }).success).toBe(true);
        expect(CopilotChatContext.safeParse({ type: "tool", name: "t" }).success).toBe(true);
        expect(CopilotChatContext.safeParse({ type: "prompt", name: "p" }).success).toBe(true);
        expect(CopilotChatContext.safeParse({ type: "unknown" }).success).toBe(false);
    });

    // context is `.nullable()` on CopilotAPIRequest WITHOUT `.optional()` — the
    // caller must explicitly send `context: null`, omitting the key fails.
    it("CopilotAPIRequest.context is a required key that may be null; omitting it throws", () => {
        const base = { projectId: "p1", messages: [], workflow: validWorkflow() };
        expect(CopilotAPIRequest.safeParse(base).success).toBe(false);
        expect(CopilotAPIRequest.safeParse({ ...base, context: null }).success).toBe(true);
    });

    it("CopilotAPIResponse is a loose union: an object with BOTH `response` and `error` matches the first (response) branch and drops `error`", () => {
        const r = CopilotAPIResponse.safeParse({ response: "ok", error: "also present" });
        expect(r.success).toBe(true);
        if (r.success) expect(r.data).toEqual({ response: "ok" });
    });

    it("CopilotStreamEvent: the text-event branch has no discriminant, so any object with only `content` matches it first", () => {
        const r = CopilotStreamEvent.safeParse({ content: "hello" });
        expect(r.success).toBe(true);
        if (r.success) expect(r.data).toEqual({ content: "hello" });
        // a real tool-call event (no bare `content` field) falls through to the second branch
        const call = CopilotStreamEvent.safeParse({ type: "tool-call", toolName: "t", toolCallId: "c", args: {} });
        expect(call.success).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// conversation.ts
// ---------------------------------------------------------------------------
describe("Conversation", () => {
    it("turns is optional; parse({}) throws on the required fields", () => {
        expect(Conversation.safeParse({}).success).toBe(false);
        const valid = {
            id: "c1",
            projectId: "p1",
            workflow: validWorkflow(),
            reason: { type: "chat" as const },
            isLiveWorkflow: true,
            createdAt: iso(),
        };
        expect(Conversation.safeParse(valid).success).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// composio-trigger-type.ts
// ---------------------------------------------------------------------------
describe("ComposioTriggerType", () => {
    it("config.required is optional; config.type is locked to the literal 'object'", () => {
        const valid = { slug: "s", name: "n", description: "d", config: { type: "object", properties: {} } };
        expect(ComposioTriggerType.safeParse(valid).success).toBe(true);
        expect(ComposioTriggerType.safeParse({ ...valid, config: { ...valid.config, type: "array" } }).success).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// assistant-template.ts
// ---------------------------------------------------------------------------
describe("AssistantTemplate", () => {
    const required = () => ({
        id: "a1",
        name: "n",
        description: "d",
        category: "c",
        authorId: "u1",
        authorName: "author",
        isAnonymous: false,
        workflow: validWorkflow(),
        tags: [],
        publishedAt: iso(),
        lastUpdatedAt: iso(),
        source: "library" as const,
    });

    it("parse({}) throws — everything except the defaulted fields is required", () => {
        expect(AssistantTemplate.safeParse({}).success).toBe(false);
    });

    it("applies all five defaults exactly when omitted: downloadCount/likeCount=0, featured=false, isPublic=true, likes=[]", () => {
        const r = AssistantTemplate.safeParse(required());
        expect(r.success).toBe(true);
        if (r.success) {
            expect(r.data.downloadCount).toBe(0);
            expect(r.data.likeCount).toBe(0);
            expect(r.data.featured).toBe(false);
            expect(r.data.isPublic).toBe(true);
            expect(r.data.likes).toEqual([]);
        }
    });

    it("source is a closed 2-value enum with no default", () => {
        expect(AssistantTemplate.safeParse({ ...required(), source: "featured" }).success).toBe(false);
        const { source, ...rest } = required();
        expect(AssistantTemplate.safeParse(rest).success).toBe(false);
    });
});

describe("AssistantTemplateLike", () => {
    it("userEmail is optional; every other field is required", () => {
        const valid = { id: "l1", assistantId: "a1", userId: "u1", createdAt: iso() };
        expect(AssistantTemplateLike.safeParse(valid).success).toBe(true);
        expect(AssistantTemplateLike.safeParse({ ...valid, userId: undefined }).success).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// composio-trigger-deployment.ts
// ---------------------------------------------------------------------------
describe("ComposioTriggerDeployment", () => {
    // Unlike almost every other entity in this package, NOTHING here is
    // optional — including updatedAt, which is optional on User/Turn/Job/
    // Project/Conversation/ApiKey. A port that reuses the "updatedAt is
    // usually optional" convention from those files would silently loosen
    // this one.
    it("has zero optional fields — updatedAt is required, breaking the pattern used elsewhere in entities/models", () => {
        const valid = {
            id: "d1", projectId: "p1", triggerId: "t1", toolkitSlug: "tk",
            triggerTypeSlug: "ts", triggerTypeName: "Name", connectedAccountId: "ca1",
            triggerConfig: {}, logo: "l", createdAt: iso(), updatedAt: iso(),
        };
        expect(ComposioTriggerDeployment.safeParse(valid).success).toBe(true);
        const { updatedAt, ...rest } = valid;
        expect(ComposioTriggerDeployment.safeParse(rest).success).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// api-key.ts
// ---------------------------------------------------------------------------
describe("ApiKey", () => {
    it("lastUsedAt is the only optional field", () => {
        const valid = { id: "k1", projectId: "p1", key: "sk_1", createdAt: iso() };
        expect(ApiKey.safeParse(valid).success).toBe(true);
        expect(ApiKey.safeParse({ id: "k1", projectId: "p1", createdAt: iso() }).success).toBe(false); // missing key
    });
});

// ---------------------------------------------------------------------------
// errors/
// ---------------------------------------------------------------------------
describe("domain error classes", () => {
    const classes = [JobAcquisitionError, BillingError, QuotaExceededError, BadRequestError, NotFoundError, NotAuthorizedError];

    it("are all real Error instances carrying the given message", () => {
        for (const Cls of classes) {
            const e = new Cls("boom");
            expect(e).toBeInstanceOf(Error);
            expect(e.message).toBe("boom");
        }
    });

    // None of these classes override `.name`, so `instanceof` is the only
    // reliable discriminator — `error.name` reads "Error" for all six, not
    // the subclass name. Worth pinning because it is easy to assume
    // otherwise (and a port "fixing" this by adding `this.name = ...` would
    // be a behavior change, not a no-op).
    it("do NOT set `.name` to the subclass name — `.name` reads plain 'Error' for every one of them", () => {
        for (const Cls of classes) {
            expect(new Cls("boom").name).toBe("Error");
        }
    });

    it("propagate ErrorOptions.cause", () => {
        const cause = new Error("root cause");
        const e = new BadRequestError("wrapped", { cause });
        expect(e.cause).toBe(cause);
    });
});

// ---------------------------------------------------------------------------
// common/paginated-list.ts
// ---------------------------------------------------------------------------
describe("PaginatedList factory", () => {
    const Schema = PaginatedList(User);

    it("nextCursor is a required key that may be null — omitting it throws", () => {
        expect(Schema.safeParse({ items: [] }).success).toBe(false);
        expect(Schema.safeParse({ items: [], nextCursor: null }).success).toBe(true);
        expect(Schema.safeParse({ items: [], nextCursor: "abc" }).success).toBe(true);
    });

    it("validates each item against the supplied schema", () => {
        expect(Schema.safeParse({ items: [{ not: "a user" }], nextCursor: null }).success).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// models/api-v1.ts — vendored widget wire contract, treated as high-value
// ---------------------------------------------------------------------------
describe("api-v1.ts message schemas", () => {
    it("AssistantMessage.agenticResponseType is REQUIRED, not optional — a plain assistant reply without it is rejected", () => {
        expect(ApiAssistantMessage.safeParse({ role: "assistant", content: "hi" }).success).toBe(false);
        expect(ApiAssistantMessage.safeParse({ role: "assistant", content: "hi", agenticResponseType: "internal" }).success).toBe(true);
    });

    it("AssistantMessageWithToolCalls.content is BOTH nullable and optional (may be omitted or explicitly null)", () => {
        const base = {
            role: "assistant" as const,
            tool_calls: [{ id: "1", type: "function" as const, function: { name: "f", arguments: "{}" } }],
            agenticResponseType: "internal" as const,
        };
        expect(ApiAssistantMessageWithToolCalls.safeParse(base).success).toBe(true);
        expect(ApiAssistantMessageWithToolCalls.safeParse({ ...base, content: null }).success).toBe(true);
        expect(ApiAssistantMessageWithToolCalls.safeParse({ ...base, content: "text" }).success).toBe(true);
    });

    it("SystemMessage/UserMessage/ToolMessage all require content as a plain string", () => {
        expect(ApiSystemMessage.safeParse({ role: "system", content: "s" }).success).toBe(true);
        expect(ApiUserMessage.safeParse({ role: "user", content: "u" }).success).toBe(true);
        expect(ApiToolMessage.safeParse({ role: "tool", content: "t", tool_call_id: "1", tool_name: "n" }).success).toBe(true);
    });
});

describe("ChatMessage union precedence", () => {
    const base = () => ({ version: "v1" as const, chatId: "c1", createdAt: iso() });

    // AssistantMessage is declared BEFORE AssistantMessageWithToolCalls in the
    // union array. zod's plain z.union tries members in declaration order and
    // returns the FIRST success. A payload carrying both `content` and
    // `tool_calls` therefore matches AssistantMessage and the tool_calls key is
    // silently stripped — reordering the union (or converting to
    // discriminatedUnion, which can't discriminate on `role` alone since both
    // share role:"assistant") would change which shape wins.
    it("a message with BOTH content and tool_calls matches AssistantMessage first, silently dropping tool_calls", () => {
        const r = ChatMessage.safeParse({
            ...base(),
            role: "assistant",
            content: "hi",
            agenticResponseType: "internal",
            tool_calls: [{ id: "1", type: "function", function: { name: "f", arguments: "{}" } }],
        });
        expect(r.success).toBe(true);
        if (r.success) expect("tool_calls" in r.data).toBe(false);
    });

    it("a tool-calls-only message (no `content` string) falls through to the ToolCalls branch", () => {
        const r = ChatMessage.safeParse({
            ...base(),
            role: "assistant",
            agenticResponseType: "internal",
            tool_calls: [{ id: "1", type: "function", function: { name: "f", arguments: "{}" } }],
        });
        expect(r.success).toBe(true);
        if (r.success) expect("tool_calls" in r.data).toBe(true);
    });

    it("rejects a message whose role matches nothing in the union", () => {
        expect(ChatMessage.safeParse({ ...base(), role: "developer", content: "x" }).success).toBe(false);
    });
});

describe("ApiChatTurnResponse — intersection narrows ChatMessage down to plain AssistantMessage only", () => {
    const base = () => ({ version: "v1" as const, chatId: "c1", createdAt: iso(), id: "m1" });

    // ApiChatTurnResponse = ChatMessage.and(BaseChatMessage).and(AssistantMessage).and({id}).
    // Intersecting with AssistantMessage specifically (not the union) means a
    // tool-calls message or a system/user/tool message — all otherwise-valid
    // ChatMessage members — do NOT satisfy this response type. This is the
    // sharpest non-obvious pin in the file: the API's own turn-response type is
    // narrower than its own ChatMessage union.
    it("accepts a plain assistant text reply", () => {
        const r = ApiChatTurnResponse.safeParse({ ...base(), role: "assistant", content: "hi", agenticResponseType: "external" });
        expect(r.success).toBe(true);
    });

    it("rejects a tool-calls assistant message even though it is a valid ChatMessage", () => {
        const r = ApiChatTurnResponse.safeParse({
            ...base(),
            role: "assistant",
            agenticResponseType: "internal",
            tool_calls: [{ id: "1", type: "function", function: { name: "f", arguments: "{}" } }],
        });
        expect(r.success).toBe(false);
    });

    it("rejects a system message even though it is a valid ChatMessage", () => {
        const r = ApiChatTurnResponse.safeParse({ ...base(), role: "system", content: "sys" });
        expect(r.success).toBe(false);
    });
});

describe("Chat / ApiCreateChatRequest / session schemas", () => {
    it("ChatCloseReason is a closed 4-literal union", () => {
        expect(ChatCloseReason.safeParse("timeout").success).toBe(true);
        expect(ChatCloseReason.safeParse("cancelled").success).toBe(false);
    });

    it("ChatUserData.userName is optional", () => {
        expect(ChatUserData.safeParse({ userId: "u1" }).success).toBe(true);
    });

    it("Chat requires userData; agenticState (z.unknown().optional()) accepts any shape when present", () => {
        const valid = { version: "v1" as const, projectId: "p1", userId: "u1", createdAt: iso(), userData: { userId: "u1" } };
        expect(Chat.safeParse(valid).success).toBe(true);
        expect(Chat.safeParse({ ...valid, userData: undefined }).success).toBe(false);
        expect(Chat.safeParse({ ...valid, agenticState: { anything: [1, 2, { nested: true }] } }).success).toBe(true);
    });

    // ApiCreateChatRequest = z.object({}) is NOT `.strict()` — zod's default
    // object mode silently STRIPS unrecognized keys rather than rejecting the
    // request. A caller sending extra fields does not get a 400; the fields
    // just vanish. Adding `.strict()` during a port would be a behavior
    // change (start rejecting requests that succeed today), not a cleanup.
    it("ApiCreateChatRequest silently accepts and strips unknown fields rather than rejecting them", () => {
        const r = ApiCreateChatRequest.safeParse({ unexpected: "field" });
        expect(r.success).toBe(true);
        if (r.success) expect(r.data).toEqual({});
    });

    it("ApiCreateChatResponse === ApiGetChatResponse: the exact same schema object, not just structurally equal", () => {
        expect(ApiGetChatResponse).toBe(ApiCreateChatResponse);
    });

    it("ApiGetChatsResponse: next/previous are optional pagination cursors", () => {
        const chat = { version: "v1" as const, projectId: "p1", userId: "u1", createdAt: iso(), userData: { userId: "u1" }, id: "ch1" };
        expect(ApiGetChatsResponse.safeParse({ chats: [chat] }).success).toBe(true);
    });

    it("ApiChatTurnRequest.message is required", () => {
        expect(ApiChatTurnRequest.safeParse({}).success).toBe(false);
        expect(ApiChatTurnRequest.safeParse({ message: "hi" }).success).toBe(true);
    });

    it("ApiGetChatMessagesResponse.messages validates each message against ChatMessage.and({id})", () => {
        const msg = { version: "v1" as const, chatId: "c1", createdAt: iso(), role: "user" as const, content: "hi", id: "m1" };
        expect(ApiGetChatMessagesResponse.safeParse({ messages: [msg] }).success).toBe(true);
        expect(ApiGetChatMessagesResponse.safeParse({ messages: [{ ...msg, role: "bogus" }] }).success).toBe(false);
    });

    it("session request/response schemas: guest session has no input fields, user session requires userDataJwt", () => {
        expect(ApiCreateGuestSessionRequest.safeParse({}).success).toBe(true);
        expect(ApiCreateGuestSessionResponse.safeParse({ sessionId: "s1" }).success).toBe(true);
        expect(ApiCreateUserSessionRequest.safeParse({}).success).toBe(false);
        expect(ApiCreateUserSessionRequest.safeParse({ userDataJwt: "jwt" }).success).toBe(true);
        expect(ApiCreateUserSessionResponse.safeParse({ sessionId: "s1" }).success).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Cross-cutting: every field declared without `.optional()`/`.default()` is
// actually enforced as required. "parse({}) throws" (used above per-schema)
// only proves at least one field is required; a mutation that loosens a
// single required field to `.optional()` can hide behind every other field
// still being present. This section isolates each field.
// ---------------------------------------------------------------------------
describe("required-field completeness (isolates each field, not just parse({}))", () => {
    it("User", () => {
        expectRequiredKeys(User, { id: "u1", supabaseId: "a1", createdAt: iso() }, ["id", "supabaseId", "createdAt"]);
    });

    it("Project", () => {
        expectRequiredKeys(Project, {
            id: "550e8400-e29b-41d4-a716-446655440000",
            name: "p",
            createdAt: iso(),
            createdByUserId: "u1",
            secret: "s",
            draftWorkflow: validWorkflow(),
            liveWorkflow: validWorkflow(),
        }, ["id", "name", "createdAt", "createdByUserId", "secret", "draftWorkflow", "liveWorkflow"]);
    });

    it("Job", () => {
        expectRequiredKeys(Job, {
            id: "j1",
            reason: { type: "composio_trigger", triggerId: "t1", triggerDeploymentId: "d1", triggerTypeSlug: "s1", payload: {} },
            projectId: "p1",
            input: { messages: [] },
            workerId: null,
            lastWorkerId: null,
            status: "pending",
            createdAt: iso(),
        }, ["id", "reason", "projectId", "input", "workerId", "lastWorkerId", "status", "createdAt"]);
    });

    it("DataSourceDoc", () => {
        expectRequiredKeys(DataSourceDoc, {
            id: "d1", sourceId: "s1", projectId: "p1", name: "n", version: 1, status: "ready",
            content: null, createdAt: iso(), lastUpdatedAt: null, attempts: 0, error: null,
            data: { type: "url", url: "https://x" },
        }, ["id", "sourceId", "projectId", "name", "version", "status", "content", "createdAt", "lastUpdatedAt", "attempts", "error", "data"]);
    });

    it("Conversation", () => {
        expectRequiredKeys(Conversation, {
            id: "c1", projectId: "p1", workflow: validWorkflow(), reason: { type: "chat" },
            isLiveWorkflow: true, createdAt: iso(),
        }, ["id", "projectId", "workflow", "reason", "isLiveWorkflow", "createdAt"]);
    });

    it("ComposioTriggerType", () => {
        expectRequiredKeys(ComposioTriggerType, {
            slug: "s", name: "n", description: "d", config: { type: "object", properties: {} },
        }, ["slug", "name", "description", "config"]);
    });

    it("AssistantTemplate", () => {
        expectRequiredKeys(AssistantTemplate, {
            id: "a1", name: "n", description: "d", category: "c", authorId: "u1", authorName: "author",
            isAnonymous: false, workflow: validWorkflow(), tags: [], publishedAt: iso(), lastUpdatedAt: iso(),
            source: "library",
        }, ["id", "name", "description", "category", "authorId", "authorName", "isAnonymous", "workflow", "tags", "publishedAt", "lastUpdatedAt", "source"]);
    });

    it("ProjectMember", () => {
        expectRequiredKeys(ProjectMember, {
            id: "m1", userId: "u1", projectId: "p1", createdAt: iso(), lastUpdatedAt: iso(),
        }, ["id", "userId", "projectId", "createdAt", "lastUpdatedAt"]);
    });

    it("ComposioTriggerDeployment", () => {
        expectRequiredKeys(ComposioTriggerDeployment, {
            id: "d1", projectId: "p1", triggerId: "t1", toolkitSlug: "tk", triggerTypeSlug: "ts",
            triggerTypeName: "Name", connectedAccountId: "ca1", triggerConfig: {}, logo: "l",
            createdAt: iso(), updatedAt: iso(),
        }, ["id", "projectId", "triggerId", "toolkitSlug", "triggerTypeSlug", "triggerTypeName", "connectedAccountId", "triggerConfig", "logo", "createdAt", "updatedAt"]);
    });

    it("ApiKey", () => {
        expectRequiredKeys(ApiKey, { id: "k1", projectId: "p1", key: "sk_1", createdAt: iso() }, ["id", "projectId", "key", "createdAt"]);
    });
});
