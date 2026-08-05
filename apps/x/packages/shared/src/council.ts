import { z } from 'zod';

/**
 * Council — a standing group of advisors the principal can put one question to.
 *
 * The design property that makes it worth more than asking a single assistant
 * twice: members answer **in parallel and in isolation**. No member sees
 * another's position before writing its own, so the answers are independent
 * rather than an echo of whoever spoke first. Only then does a synthesiser read
 * them all.
 *
 * The second property: **dissent is a first-class output**. A memo that quietly
 * averages two incompatible recommendations is the failure mode this is
 * designed against, so the synthesis schema requires disagreements to be named
 * and attributed, and every raw position is kept verbatim.
 */

/** A member's charter — what they own, what they may settle, what they escalate. */
export const CouncilMemberSchema = z.object({
    /** Stable slug, also the charter filename. */
    id: z.string().min(1),
    title: z.string().min(1),
    /** What this member is for, in their own voice. Becomes their system prompt. */
    mission: z.string().min(1),
    /** Areas of responsibility. */
    owns: z.array(z.string()).default([]),
    /** Calls this member may make without escalating. */
    decidesAlone: z.array(z.string()).default([]),
    /** Calls that must come back to the principal. */
    escalates: z.array(z.string()).default([]),
    /** What every answer from this member must contain. */
    outputContract: z.array(z.string()).default([]),
    /** Members can be stood down without deleting their charter. */
    enabled: z.boolean().default(true),
    /** Built-ins ship with Dhow; custom members are user-authored. */
    builtin: z.boolean().default(false),
    /**
     * Which roster a member belongs to.
     *
     * `core` is the default four — deliberately small, because a council of
     * eleven produces eleven paragraphs nobody reads. `csuite` is the
     * executive cabinet, convened when the question is a company decision
     * rather than a judgement call. A session can mix them.
     */
    group: z.enum(['core', 'csuite', 'custom']).default('custom'),
    /** Display order within a roster; the cabinet reads better in rank order. */
    order: z.number().default(100),
    /**
     * Builtin tool domains this member may use, by name — `files`, `web`,
     * `parsing`, and so on. Names are validated at run time against the tool
     * registry, not here, because the registry is a core concern and this
     * schema is shared with the renderer.
     *
     * EMPTY IS NOT A DEGRADED STATE, IT IS THE OTHER MODE. A member with no
     * tools answers in a single model call — bounded, fast, and unable to
     * touch anything. A member with tools runs as a headless agent: a
     * multi-turn loop that costs more, takes longer, and has a real
     * permission surface. Neither is the "right" default for every seat, so
     * the roster in charters.ts sets this per member and the principal can
     * override it.
     *
     * Note what is deliberately absent from the shipped allowlists: `shell`,
     * `code`, `notifications`, `background-tasks`, `composio`. A council
     * member is asked to advise, not to act. Read the contract, look it up,
     * hand back a position — nothing here should send mail or run a command
     * on the principal's behalf without them asking for that specifically.
     */
    tools: z.array(z.string()).default([]),
    /**
     * Ceiling on model calls when this member runs with tools.
     *
     * Only consulted on the tool-using path; a prompt-only member is one call
     * by construction. Treated as a request, not a grant — the runtime caps
     * it against the app-wide limit the same way spawn-agent does, so a
     * charter can ask for less budget than the setting allows but never more.
     */
    maxModelCalls: z.number().int().min(1).max(50).default(12),
});
export type CouncilMember = z.infer<typeof CouncilMemberSchema>;

/**
 * One member's independent answer. Structured rather than prose so the UI can
 * show the shape of the disagreement, not just paragraphs.
 */
export const PositionSchema = z.object({
    /** The recommendation, one sentence. */
    position: z.string(),
    /** The two or three reasons that actually drive it. */
    why: z.array(z.string()),
    /** The biggest thing that could go wrong if followed. */
    risk: z.string(),
    /** What the member would need to be more confident. */
    unknown: z.string(),
    /** Any part of the question that belongs to a different member. */
    notMine: z.string().optional(),
});
export type Position = z.infer<typeof PositionSchema>;

/**
 * A member's second-round contribution, after seeing everyone else.
 *
 * Round one is isolated on purpose. This is the deliberate opposite: the point
 * of a joint discussion is that members can be moved by an argument they had
 * not considered. Keeping it as a separate round preserves the independence of
 * the first pass — the original position is never overwritten, so a reader can
 * see who changed their mind and why.
 */
export const RebuttalSchema = z.object({
    /** Whether seeing the others changed anything. */
    changedMind: z.boolean(),
    /** The revised recommendation when it changed; otherwise a restatement. */
    revisedPosition: z.string(),
    /** Direct responses to specific members, by id. */
    responses: z.array(z.object({ toMemberId: z.string(), response: z.string() })).default([]),
    /** What made them move, or why they held. */
    reasoning: z.string(),
});
export type Rebuttal = z.infer<typeof RebuttalSchema>;

/** A position plus its outcome — a member that failed still appears, with why. */
export const MemberPositionSchema = z.object({
    memberId: z.string(),
    title: z.string(),
    position: PositionSchema.nullable(),
    /** Set when this member could not answer. Never silently dropped. */
    error: z.string().nullable(),
    /** Present only when the session ran a discussion round. */
    rebuttal: RebuttalSchema.nullable().default(null),
});
export type MemberPosition = z.infer<typeof MemberPositionSchema>;

export const DisagreementSchema = z.object({
    /** Members on each side, by id. */
    between: z.array(z.string()).min(2),
    /** What they actually disagree about. */
    conflict: z.string(),
    /** Which side the synthesis would follow, and why. */
    recommendation: z.string(),
});
export type Disagreement = z.infer<typeof DisagreementSchema>;

/**
 * The memo. `disagreements` is required and may be empty — but empty must mean
 * "they genuinely agreed", never "the synthesiser smoothed it over".
 */
export const SynthesisSchema = z.object({
    /** One line the principal can act on immediately. */
    headline: z.string(),
    /** Each member's position in one attributed sentence. */
    positions: z.array(z.object({ memberId: z.string(), summary: z.string() })),
    disagreements: z.array(DisagreementSchema),
    /** What is still unknown, and who should get it. */
    openQuestions: z.array(z.string()),
    nextAction: z.object({
        action: z.string(),
        owner: z.string(),
        /** Free text — "this week" is more honest than a fabricated date. */
        when: z.string(),
    }),
});
export type Synthesis = z.infer<typeof SynthesisSchema>;

/** A document the council was asked to review alongside the question. */
export const CouncilAttachmentSchema = z.object({
    name: z.string(),
    /** Extracted text. Large documents are truncated before they reach a model. */
    content: z.string(),
    truncated: z.boolean().default(false),
});
export type CouncilAttachment = z.infer<typeof CouncilAttachmentSchema>;

export const CouncilSessionSchema = z.object({
    id: z.string(),
    question: z.string(),
    createdAt: z.string(),
    /** Documents every member read before answering. */
    attachments: z.array(CouncilAttachmentSchema).default([]),
    /** Whether members saw each other and could respond. */
    discussed: z.boolean().default(false),
    /** Verbatim member positions, kept so a principal can go behind the memo. */
    positions: z.array(MemberPositionSchema),
    synthesis: SynthesisSchema.nullable(),
    /** Set when synthesis itself failed; positions remain readable. */
    synthesisError: z.string().nullable(),
});
export type CouncilSession = z.infer<typeof CouncilSessionSchema>;

/**
 * Assignment statuses.
 *
 * `blocked` is deliberately a state rather than a deletion: a board should show
 * where work stalled, not silently forget it. Completing a child never
 * completes its parent — a tree that closes itself out from underneath the
 * principal is worse than one that makes them look.
 */
export const AssignmentStatus = z.enum(['open', 'in_progress', 'blocked', 'done', 'cancelled']);
export type AssignmentStatus = z.infer<typeof AssignmentStatus>;

export const AssignmentSchema = z.object({
    id: z.string(),
    title: z.string().min(1),
    /** What done looks like. */
    detail: z.string().default(''),
    /** Council member responsible, or null when the principal owns it. */
    assigneeId: z.string().nullable(),
    status: AssignmentStatus.default('open'),
    /** Parent assignment, for decomposition into subtasks. */
    parentId: z.string().nullable().default(null),
    /** Session this came out of, when it was raised by a council memo. */
    sessionId: z.string().nullable().default(null),
    /** Why it stalled. Required in spirit whenever status is `blocked`. */
    blockedReason: z.string().nullable().default(null),
    /**
     * What the assigned member produced when the task was dispatched.
     *
     * Dispatch is the difference between a to-do list and delegation: the
     * member actually works the goal and hands back a result. It is kept
     * separate from `status` because returning work is not the same as the
     * principal accepting it — only a human moves this to `done`.
     */
    result: z.string().nullable().default(null),
    dispatchedAt: z.string().nullable().default(null),
    createdAt: z.string(),
    updatedAt: z.string(),
});
export type Assignment = z.infer<typeof AssignmentSchema>;
