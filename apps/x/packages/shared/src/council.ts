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

/** A position plus its outcome — a member that failed still appears, with why. */
export const MemberPositionSchema = z.object({
    memberId: z.string(),
    title: z.string(),
    position: PositionSchema.nullable(),
    /** Set when this member could not answer. Never silently dropped. */
    error: z.string().nullable(),
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

export const CouncilSessionSchema = z.object({
    id: z.string(),
    question: z.string(),
    createdAt: z.string(),
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
    createdAt: z.string(),
    updatedAt: z.string(),
});
export type Assignment = z.infer<typeof AssignmentSchema>;
