/**
 * Council types.
 *
 * The schemas live in `@x/shared` because the IPC contract needs them and the
 * dependency runs core -> shared, never the reverse. Re-exported here so
 * council modules import from one place.
 */
export {
    CouncilMemberSchema,
    PositionSchema,
    RebuttalSchema,
    CouncilAttachmentSchema,
    MemberPositionSchema,
    DisagreementSchema,
    SynthesisSchema,
    CouncilSessionSchema,
    AssignmentStatus,
    AssignmentSchema,
} from '@x/shared/dist/council.js';
export type {
    CouncilMember,
    Position,
    Rebuttal,
    CouncilAttachment,
    MemberPosition,
    Disagreement,
    Synthesis,
    CouncilSession,
    Assignment,
} from '@x/shared/dist/council.js';
