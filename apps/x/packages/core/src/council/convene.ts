import { z } from 'zod';
import { PrefixLogger } from '@x/shared';
import { createLanguageModel } from '../models/models.js';
import { generateObjectSafe } from '../models/structured.js';
import { getKgModel, resolveProviderConfig } from '../models/defaults.js';
import { withUseCase } from '../analytics/use_case.js';
import { runHeadlessAgent } from '../runtime/assembly/headless-app.js';
import { loadTurnLimitsSettings } from '../config/turn_limits.js';
import { SYNTHESISER } from './charters.js';
import { listMembers, newSessionId, saveSession } from './store.js';
import {
    PositionSchema,
    RebuttalSchema,
    SynthesisSchema,
    type CouncilAttachment,
    type CouncilMember,
    type CouncilSession,
    type MemberPosition,
} from './types.js';

const log = new PrefixLogger('Council');

/**
 * Convene the council on one question.
 *
 * The load-bearing property is isolation: every member is prompted with the
 * question and its own charter, and nothing else. No member receives another's
 * answer, so four independent readings come back rather than one reading
 * repeated four times. Running them concurrently is what makes that
 * affordable; it is not merely an optimisation.
 */

function memberSystemPrompt(member: CouncilMember): string {
    const section = (heading: string, items: string[]) =>
        items.length ? `${heading}:\n${items.map((i) => `- ${i}`).join('\n')}` : '';
    return [
        `You are the ${member.title} on a principal's council.`,
        '',
        member.mission,
        '',
        section('You own', member.owns),
        section('You may settle alone', member.decidesAlone),
        section('You must escalate rather than decide', member.escalates),
        section('Every answer you give must contain', member.outputContract),
        '',
        'Answer from your own mandate only. Be decisive and brief.',
        // Without this the model averages toward a safe non-answer, and four
        // neutral positions cannot disagree — which defeats the whole exercise.
        'Do not hedge into neutrality. If your honest answer is "do not do this", say that.',
        'You are writing for someone who will act on it.',
    ].filter(Boolean).join('\n');
}

/**
 * Documents the council was asked to review.
 *
 * Every member sees the same text — a cabinet reviewing different excerpts of
 * a contract is not reviewing the same contract.
 */
function attachmentBlock(attachments: CouncilAttachment[]): string {
    if (attachments.length === 0) return '';
    return [
        '',
        'Documents provided for review:',
        ...attachments.map((a) => [
            `--- ${a.name}${a.truncated ? ' (truncated)' : ''} ---`,
            a.content,
            '--- end ---',
        ].join('\n')),
        '',
        'Ground your answer in these documents. Quote them where it matters, and say ' +
        'plainly when the document does not settle the question.',
    ].join('\n');
}

/**
 * Phase one for a tool-granted member (`member.tools.length > 0`): an
 * unstructured headless turn that may read files, browse, or parse a
 * document before the member commits to a view. Structured output and tool
 * calls do not compose in one call, so this runs first as its own turn and
 * the findings are folded into the position prompt as plain text context —
 * the position call itself never changes shape, with or without tools.
 */
function researchInstructions(member: CouncilMember): string {
    return [
        memberSystemPrompt(member),
        '',
        'This is a research pass, not your answer. Check whatever your charter would have ' +
        'you verify before forming a view: read a referenced document, look something up, ' +
        'confirm a number. Do not recommend anything yet.',
        'Finish with a short, factual summary of what you found and what you could not ' +
        'confirm. No position and no risk assessment — that is the next step.',
    ].join('\n');
}

function researchMessage(question: string, attachments: CouncilAttachment[]): string {
    return [
        `The principal asks: ${question}${attachmentBlock(attachments)}`,
        '',
        'Research what you need before answering. Report findings only.',
    ].join('\n');
}

/**
 * The position prompt every member sees, tool-granted or not. `research` is
 * only non-null on the tool-using path — appending it here, rather than
 * changing `PositionSchema` or the call shape, is what keeps the structured
 * contract the same regardless of which path a member took.
 */
function positionPrompt(question: string, attachments: CouncilAttachment[], research: string | null): string {
    const base = `The principal asks: ${question}${attachmentBlock(attachments)}`;
    return research ? `${base}\n\nYour own research before answering:\n${research}` : base;
}

/**
 * Round two. Each member now sees every first-round position, including its
 * own, and may move or hold. This is the joint discussion; round one stays
 * untouched so the record shows what each thought before being influenced.
 */
function rebuttalPrompt(question: string, self: CouncilMember, positions: MemberPosition[]): string {
    const others = positions
        .filter((p) => p.position && p.memberId !== self.id)
        .map((p) => `--- ${p.title} (${p.memberId}) ---\nPOSITION: ${p.position!.position}\nWHY: ${p.position!.why.join('; ')}\nRISK: ${p.position!.risk}`)
        .join('\n\n');
    const own = positions.find((p) => p.memberId === self.id)?.position;

    return [
        `The principal asked: ${question}`,
        '',
        own ? `Your own first position was: ${own.position}` : '',
        '',
        'The rest of the council answered independently. You are now seeing them for the first time:',
        '',
        others || '(no other member returned a position)',
        '',
        'Respond as yourself, from your own mandate.',
        '- If someone raised something that genuinely changes your view, say so and revise. Changing your mind on good evidence is the point of this round.',
        '- If you still disagree, say what specifically they have got wrong. Address the argument, not the person.',
        '- Do not converge for the sake of agreement. A council that always reaches consensus in round two is not deliberating.',
    ].filter(Boolean).join('\n');
}

function synthesisPrompt(question: string, positions: MemberPosition[], discussed: boolean): string {
    const rendered = positions
        .filter((p) => p.position)
        .map((p) => {
            const pos = p.position!;
            return [
                `--- ${p.title} (${p.memberId}) ---`,
                `POSITION: ${pos.position}`,
                `WHY: ${pos.why.join('; ')}`,
                `RISK: ${pos.risk}`,
                `UNKNOWN: ${pos.unknown}`,
                pos.notMine ? `NOT MINE: ${pos.notMine}` : '',
            ].filter(Boolean).join('\n');
        })
        .join('\n\n');

    const rebuttals = positions
        .filter((p) => p.rebuttal)
        .map((p) => {
            const r = p.rebuttal!;
            return [
                `--- ${p.title} (${p.memberId}), after discussion ---`,
                `${r.changedMind ? 'CHANGED POSITION' : 'HELD POSITION'}: ${r.revisedPosition}`,
                `REASONING: ${r.reasoning}`,
                ...r.responses.map((x) => `TO ${x.toMemberId}: ${x.response}`),
            ].join('\n');
        })
        .join('\n\n');

    return [
        `The principal asked: ${question}`,
        '',
        "Your council returned these independent positions. They did not see each other's answers.",
        '',
        rendered,
        ...(discussed && rebuttals
            ? ['', 'They then read each other and responded. Where a member moved, the later view is the one that counts:', '', rebuttals]
            : []),
        '',
        'Write the decision memo.',
        '- Open with ONE line the principal can act on immediately.',
        '- Summarise each position in one attributed sentence, using the member id.',
        '- Name every real conflict between members, say which side you would follow, and why.',
        // The failure mode this guards against: two incompatible
        // recommendations quietly averaged into a agreeable-sounding middle.
        '- If they genuinely agree, return an empty disagreements list. Never manufacture consensus, and never smooth over a real conflict.',
        '- List what is still unknown and who should get it.',
        '- End with exactly one next action, one owner, and when.',
        "Be brief. The principal's time is the scarce resource.",
    ].join('\n');
}

async function resolveModel() {
    const { model: modelId, provider } = await getKgModel();
    const config = await resolveProviderConfig(provider);
    return {
        model: createLanguageModel(config, modelId),
        // Passed to the research phase's inline agent so it answers on the
        // same model the position call uses — the descriptor form headless
        // turns take, not the resolved LanguageModel instance.
        modelDescriptor: { model: modelId, provider },
    };
}

export interface ConveneOptions {
    question: string;
    /** Restrict to these member ids; defaults to every enabled member. */
    memberIds?: string[];
    /** Documents every member reads before answering. */
    attachments?: CouncilAttachment[];
    /** Run a second round in which members see each other and may respond. */
    discuss?: boolean;
}

export async function convene({
    question,
    memberIds,
    attachments = [],
    discuss = false,
}: ConveneOptions): Promise<CouncilSession> {
    const trimmed = question.trim();
    if (!trimmed) throw new Error('A council needs a question.');

    const all = listMembers().filter((m) => m.enabled);
    const members = memberIds?.length ? all.filter((m) => memberIds.includes(m.id)) : all;
    if (members.length === 0) throw new Error('No council members are enabled.');

    const [{ model, modelDescriptor }, { maxModelCalls: globalMaxModelCalls }] = await Promise.all([
        resolveModel(),
        loadTurnLimitsSettings(),
    ]);

    // Tool access is additive, never load-bearing. A member with no tools
    // takes exactly today's single call; a member with tools researches
    // first in its own headless turn, then answers through the same
    // `generateObjectSafe` call everyone else uses — the position call below
    // runs the same way either way. A research turn that throws or does not
    // complete degrades to the prompt-only path rather than costing the
    // member its seat.
    async function gatherResearch(member: CouncilMember): Promise<string | null> {
        try {
            const result = await withUseCase(
                { useCase: 'copilot_chat', subUseCase: `council_research_${member.id}` },
                () =>
                    runHeadlessAgent({
                        agent: {
                            inline: {
                                name: member.id,
                                instructions: researchInstructions(member),
                                model: modelDescriptor,
                                tools: member.tools,
                            },
                        },
                        message: researchMessage(trimmed, attachments),
                        // A request, not a grant: never let a charter exceed
                        // the operator's own global ceiling, only ask for less.
                        maxModelCalls: Math.min(member.maxModelCalls, globalMaxModelCalls),
                    }),
            );
            if (result.outcome.status !== 'completed') {
                log.log(`${member.id} research did not complete (${result.outcome.status}); answering from the charter alone.`);
                return null;
            }
            return result.summary;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            log.log(`${member.id} research phase failed, answering from the charter alone: ${message}`);
            return null;
        }
    }

    async function memberPosition(member: CouncilMember) {
        const research = member.tools.length > 0 ? await gatherResearch(member) : null;
        return withUseCase({ useCase: 'copilot_chat', subUseCase: `council_position_${member.id}` }, () =>
            generateObjectSafe({
                model,
                system: memberSystemPrompt(member),
                prompt: positionPrompt(trimmed, attachments, research),
                schema: PositionSchema,
                retry: true,
            }),
        );
    }

    // Isolated and concurrent. `allSettled`, not `all`: one member failing must
    // not discard the positions the others already produced.
    const settled = await Promise.allSettled(members.map((member) => memberPosition(member)));

    const positions: MemberPosition[] = members.map((member, i) => {
        const outcome = settled[i];
        if (outcome.status === 'fulfilled') {
            return { memberId: member.id, title: member.title, position: outcome.value.object, error: null, rebuttal: null };
        }
        const error = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
        log.log(`${member.id} returned no position: ${error}`);
        // Kept in the record rather than dropped — a silently missing member
        // looks like agreement.
        return { memberId: member.id, title: member.title, position: null, error, rebuttal: null };
    });

    const answered = positions.filter((p) => p.position);

    // Round two, opt-in. Only members that actually answered can respond, and
    // only when there is someone to respond to — a lone position has no
    // discussion to join. No second research phase here even for
    // tool-granted members: round one's structured position (why/risk/
    // unknown) already carries forward what they found, and round two's job
    // is reacting to peers, not re-gathering facts. Doubling the tool calls
    // for a round whose whole point is a fast back-and-forth would cost more
    // than it buys.
    if (discuss && answered.length > 1) {
        const respondents = members.filter((m) => answered.some((p) => p.memberId === m.id));
        const rebuttals = await Promise.allSettled(
            respondents.map((member) =>
                withUseCase({ useCase: 'copilot_chat', subUseCase: `council_rebuttal_${member.id}` }, () =>
                    generateObjectSafe({
                        model,
                        system: memberSystemPrompt(member),
                        prompt: rebuttalPrompt(trimmed, member, positions) + attachmentBlock(attachments),
                        schema: RebuttalSchema,
                        retry: true,
                    }),
                ),
            ),
        );
        respondents.forEach((member, i) => {
            const outcome = rebuttals[i];
            if (outcome.status !== 'fulfilled') {
                // A failed rebuttal costs the discussion, never the position.
                log.log(`${member.id} did not respond in discussion: ${outcome.reason}`);
                return;
            }
            const entry = positions.find((p) => p.memberId === member.id);
            if (entry) entry.rebuttal = RebuttalSchema.parse(outcome.value.object);
        });
    }

    let synthesis: CouncilSession['synthesis'] = null;
    let synthesisError: string | null = null;

    if (answered.length === 0) {
        synthesisError = 'No member returned a position.';
    } else {
        // No tools here, ever — the Chief of Staff holds no position of its
        // own (see charters.ts: SYNTHESISER is deliberately not a
        // CouncilMember and carries no `tools` field). Giving synthesis a
        // research phase would let it go find its own evidence instead of
        // reading what the council already found, turning the memo into a
        // fifth opinion wearing a summary's clothes.
        try {
            const result = await withUseCase(
                { useCase: 'copilot_chat', subUseCase: 'council_synthesis' },
                () =>
                    generateObjectSafe({
                        model,
                        system: `You are the ${SYNTHESISER.title}. ${SYNTHESISER.mission}`,
                        prompt: synthesisPrompt(trimmed, positions, discuss),
                        schema: SynthesisSchema,
                        retry: true,
                    }),
            );
            synthesis = result.object;
        } catch (err) {
            synthesisError = err instanceof Error ? err.message : String(err);
            log.log(`synthesis failed: ${synthesisError}`);
        }
    }

    const session: CouncilSession = {
        id: newSessionId(),
        question: trimmed,
        createdAt: new Date().toISOString(),
        attachments,
        discussed: discuss && positions.some((p) => p.rebuttal),
        positions,
        synthesis,
        synthesisError,
    };
    saveSession(session);
    return session;
}

/** Exported for tests — the prompt contract is the feature. */
export const __testing = { memberSystemPrompt, synthesisPrompt, PositionSchema: z.object({}) };
