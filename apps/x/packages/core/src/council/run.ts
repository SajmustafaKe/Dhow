import { generateText } from 'ai';
import { createLanguageModel } from '../models/models.js';
import { getKgModel, resolveProviderConfig } from '../models/defaults.js';
import { withUseCase } from '../analytics/use_case.js';
import { getSession } from './store.js';
import type { Assignment, CouncilMember } from './types.js';
import type { IHeadlessAgentRunner } from '../runtime/assembly/headless.js';

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
    const hasTools = member.tools.length > 0;
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
        // A prompt-only member genuinely cannot fetch what it's missing, so
        // "stop and say what's missing" is the honest instruction. A
        // tool-using member can go get it — telling it to stop anyway would
        // waste the grant charters.ts gave it and hand back a shrug where a
        // lookup belonged.
        hasTools
            ? 'You have tools — use them to find what you need (read the file, search the web, pull the record) instead of guessing or asking to be handed it. If something is still genuinely missing after that, say exactly what is missing and stop.'
            : 'If the task cannot be completed with what you were given, say exactly what is missing and stop. Do not invent inputs.',
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

// Resolved lazily, inside the tools branch only: pulling in the DI container
// and the headless turn runtime at module load would make every prompt-only
// dispatch — the default, and the cheap path this is supposed to stay —
// pay for a runtime it never touches. Same reasoning as the lazy `./run.js`
// import in assignments.ts, one layer further in.
async function resolveHeadlessServices(): Promise<{
    headlessRunner: IHeadlessAgentRunner;
    cap: number;
}> {
    const [{ lazyResolve }, { loadTurnLimitsSettings }] = await Promise.all([
        import('../di/lazy-resolve.js'),
        import('../config/turn_limits.js'),
    ]);
    const [headlessRunner, settings] = await Promise.all([
        lazyResolve<IHeadlessAgentRunner>('headlessAgentRunner'),
        loadTurnLimitsSettings(),
    ]);
    return { headlessRunner, cap: settings.maxModelCalls };
}

// The tool-using path: a headless agent turn instead of one generateText
// call. Mirrors spawn-agent.ts's inline-agent shape exactly, because that is
// the one other place in Dhow that turns a name+instructions+tools triple
// into a running child turn, and a second, slightly different way to do the
// same thing is a bug waiting for a maintainer to hit.
async function runWithTools(member: CouncilMember, assignment: Assignment): Promise<string> {
    const { headlessRunner, cap } = await resolveHeadlessServices();

    // member.maxModelCalls is a request, never a grant: the app-wide limit
    // is also the ceiling, the same clamp spawn-agent.ts applies to every
    // other tool-using agent in Dhow — a charter can ask for less budget
    // than the setting allows, never more.
    const maxModelCalls = Math.min(member.maxModelCalls, cap);

    const handle = await headlessRunner.start({
        agent: {
            inline: {
                name: member.title,
                instructions: systemPrompt(member),
                tools: member.tools,
            },
        },
        message: taskPrompt(assignment),
        maxModelCalls,
    });
    const result = await handle.done;

    if (result.outcome.status !== 'completed') {
        throw new Error(
            result.outcome.status === 'failed'
                ? result.outcome.error
                : `${member.title}'s turn was ${result.outcome.status}.`,
        );
    }

    const text = (result.summary ?? '').trim();
    if (!text) throw new Error(`${member.title} returned nothing.`);
    return text;
}

// Branches on member.tools, not on anything about the assignment: empty is
// not a degraded state, it is the other mode (see the field's doc comment in
// @x/shared/src/council.ts). A member with no tools stays on the original,
// bounded, single-call path the existing tests pin byte-for-byte; a member
// with tools runs as a headless agent instead.
export async function runAssignment(member: CouncilMember, assignment: Assignment): Promise<string> {
    if (member.tools.length > 0) return runWithTools(member, assignment);

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
