import { z } from 'zod';
import { PrefixLogger } from '@x/shared';
import { createLanguageModel } from '../models/models.js';
import { generateObjectSafe } from '../models/structured.js';
import { getKgModel, resolveProviderConfig } from '../models/defaults.js';
import { withUseCase } from '../analytics/use_case.js';
import { SYNTHESISER } from './charters.js';
import { listMembers, newSessionId, saveSession } from './store.js';
import {
    PositionSchema,
    SynthesisSchema,
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

function synthesisPrompt(question: string, positions: MemberPosition[]): string {
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

    return [
        `The principal asked: ${question}`,
        '',
        "Your council returned these independent positions. They did not see each other's answers.",
        '',
        rendered,
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
    return createLanguageModel(config, modelId);
}

export interface ConveneOptions {
    question: string;
    /** Restrict to these member ids; defaults to every enabled member. */
    memberIds?: string[];
}

export async function convene({ question, memberIds }: ConveneOptions): Promise<CouncilSession> {
    const trimmed = question.trim();
    if (!trimmed) throw new Error('A council needs a question.');

    const all = listMembers().filter((m) => m.enabled);
    const members = memberIds?.length ? all.filter((m) => memberIds.includes(m.id)) : all;
    if (members.length === 0) throw new Error('No council members are enabled.');

    const model = await resolveModel();

    // Isolated and concurrent. `allSettled`, not `all`: one member failing must
    // not discard the positions the others already produced.
    const settled = await Promise.allSettled(
        members.map((member) =>
            withUseCase({ useCase: 'copilot_chat', subUseCase: `council_position_${member.id}` }, () =>
                generateObjectSafe({
                    model,
                    system: memberSystemPrompt(member),
                    prompt: `The principal asks: ${trimmed}`,
                    schema: PositionSchema,
                    retry: true,
                }),
            ),
        ),
    );

    const positions: MemberPosition[] = members.map((member, i) => {
        const outcome = settled[i];
        if (outcome.status === 'fulfilled') {
            return { memberId: member.id, title: member.title, position: outcome.value.object, error: null };
        }
        const error = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
        log.log(`${member.id} returned no position: ${error}`);
        // Kept in the record rather than dropped — a silently missing member
        // looks like agreement.
        return { memberId: member.id, title: member.title, position: null, error };
    });

    const answered = positions.filter((p) => p.position);
    let synthesis: CouncilSession['synthesis'] = null;
    let synthesisError: string | null = null;

    if (answered.length === 0) {
        synthesisError = 'No member returned a position.';
    } else {
        try {
            const result = await withUseCase(
                { useCase: 'copilot_chat', subUseCase: 'council_synthesis' },
                () =>
                    generateObjectSafe({
                        model,
                        system: `You are the ${SYNTHESISER.title}. ${SYNTHESISER.mission}`,
                        prompt: synthesisPrompt(trimmed, positions),
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
        positions,
        synthesis,
        synthesisError,
    };
    saveSession(session);
    return session;
}

/** Exported for tests — the prompt contract is the feature. */
export const __testing = { memberSystemPrompt, synthesisPrompt, PositionSchema: z.object({}) };
