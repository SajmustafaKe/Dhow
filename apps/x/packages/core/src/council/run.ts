import { generateText } from 'ai';
import { createLanguageModel } from '../models/models.js';
import { getKgModel, resolveProviderConfig } from '../models/defaults.js';
import { withUseCase } from '../analytics/use_case.js';
import { getSession } from './store.js';
import type { Assignment, CouncilMember } from './types.js';

/**
 * Run one assignment as its assigned council member.
 *
 * Prose rather than a schema, deliberately: an assignment's output is a piece
 * of work for a person to read, not a record for the UI to destructure. A
 * council *position* is structured because the interface compares positions
 * against each other; a delivered draft, analysis or review has no such shape
 * to impose.
 */

function systemPrompt(member: CouncilMember): string {
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
        'You have been handed a task, not a question. Do the work and hand back the result.',
        // Without this the model narrates an approach instead of producing the
        // thing, and the principal has to ask twice.
        'Produce the actual output — the draft, the analysis, the list — not a description of how you would approach it.',
        'If the task cannot be completed with what you were given, say exactly what is missing and stop. Do not invent inputs.',
    ].filter(Boolean).join('\n');
}

function taskPrompt(assignment: Assignment): string {
    const parts = [`Task: ${assignment.title}`];
    if (assignment.detail) parts.push('', `Detail: ${assignment.detail}`);

    // A task raised by a memo inherits that memo's context; without it the
    // member re-derives a decision the council already made.
    if (assignment.sessionId) {
        const session = getSession(assignment.sessionId);
        if (session) {
            parts.push('', `This came out of a council session on: ${session.question}`);
            if (session.synthesis) {
                parts.push(`The council concluded: ${session.synthesis.headline}`);
                const own = session.positions.find((p) => p.memberId === assignment.assigneeId);
                if (own?.position) parts.push(`Your own position was: ${own.position.position}`);
            }
            for (const attachment of session.attachments) {
                parts.push('', `--- ${attachment.name}${attachment.truncated ? ' (truncated)' : ''} ---`, attachment.content, '--- end ---');
            }
        }
    }
    return parts.join('\n');
}

export async function runAssignment(member: CouncilMember, assignment: Assignment): Promise<string> {
    const { model: modelId, provider } = await getKgModel();
    const config = await resolveProviderConfig(provider);
    const model = createLanguageModel(config, modelId);

    const result = await withUseCase(
        { useCase: 'copilot_chat', subUseCase: `council_dispatch_${member.id}` },
        () => generateText({
            model,
            system: systemPrompt(member),
            prompt: taskPrompt(assignment),
        }),
    );

    const text = result.text.trim();
    if (!text) throw new Error(`${member.title} returned nothing.`);
    return text;
}
