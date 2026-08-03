import fs from 'fs';
import path from 'path';
import { WorkDir } from '../config/config.js';
import { ALL_BUILTIN_MEMBERS } from './charters.js';
import {
    AssignmentSchema,
    CouncilMemberSchema,
    CouncilSessionSchema,
    type Assignment,
    type CouncilMember,
    type CouncilSession,
} from './types.js';

/**
 * Council persistence — plain Markdown in the vault.
 *
 * Deliberately not a database. Everything Dhow knows lives as Markdown the
 * user can read, edit, diff and back up, and the knowledge graph indexes that
 * directory like any other. A council memo is exactly the kind of document a
 * principal will want to find again six months later, so it is a file, not a
 * row.
 *
 * Layout:
 *   council/members/<id>.md      charter, YAML frontmatter + mission prose
 *   council/sessions/<id>.md     question, verbatim positions, the memo
 *   council/assignments/<id>.md  one assignment, frontmatter + detail
 */

export const COUNCIL_DIR = path.join(WorkDir, 'council');
const MEMBERS_DIR = path.join(COUNCIL_DIR, 'members');
const SESSIONS_DIR = path.join(COUNCIL_DIR, 'sessions');
const ASSIGNMENTS_DIR = path.join(COUNCIL_DIR, 'assignments');

function ensureDir(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
}

/** Minimal YAML frontmatter writer — values are JSON-encoded so they round-trip. */
function withFrontmatter(data: Record<string, unknown>, body: string): string {
    const lines = Object.entries(data)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
    return `---\n${lines.join('\n')}\n---\n\n${body}`;
}

function readFrontmatter(content: string): { data: Record<string, unknown>; body: string } {
    if (!content.startsWith('---\n')) return { data: {}, body: content };
    const end = content.indexOf('\n---', 4);
    if (end < 0) return { data: {}, body: content };
    const data: Record<string, unknown> = {};
    for (const line of content.slice(4, end).split('\n')) {
        const idx = line.indexOf(':');
        if (idx < 0) continue;
        const key = line.slice(0, idx).trim();
        const raw = line.slice(idx + 1).trim();
        try {
            data[key] = JSON.parse(raw);
        } catch {
            // Hand-edited frontmatter is expected: fall back to the raw string
            // rather than discarding a field the user typed.
            data[key] = raw;
        }
    }
    return { data, body: content.slice(end + 4).replace(/^\n+/, '') };
}

function slug(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

/** Sortable, collision-resistant, and readable in a directory listing. */
function newId(prefix: string): string {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
    return `${prefix}-${stamp}-${Math.random().toString(36).slice(2, 7)}`;
}

// --- Members ---

function memberToMarkdown(member: CouncilMember): string {
    const section = (heading: string, items: string[]) =>
        items.length ? `## ${heading}\n\n${items.map((i) => `- ${i}`).join('\n')}\n` : '';
    return withFrontmatter(
        {
            id: member.id,
            title: member.title,
            enabled: member.enabled,
            builtin: member.builtin,
            group: member.group,
            order: member.order,
        },
        [
            `# ${member.title}\n`,
            `## Mission\n\n${member.mission}\n`,
            section('Owns', member.owns),
            section('Decides alone', member.decidesAlone),
            section('Escalates', member.escalates),
            section('Every answer must contain', member.outputContract),
        ].filter(Boolean).join('\n'),
    );
}

/** Parse the bullet list under a heading, so hand edits are honoured. */
function parseSection(body: string, heading: string): string[] {
    const re = new RegExp(`^## ${heading}\\s*$`, 'im');
    const m = re.exec(body);
    if (!m) return [];
    const rest = body.slice(m.index + m[0].length);
    const end = rest.search(/^## /m);
    return (end < 0 ? rest : rest.slice(0, end))
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.startsWith('- '))
        .map((l) => l.slice(2).trim())
        .filter(Boolean);
}

function memberFromMarkdown(content: string): CouncilMember | null {
    const { data, body } = readFrontmatter(content);
    const missionMatch = /^## Mission\s*$/im.exec(body);
    let mission = '';
    if (missionMatch) {
        const rest = body.slice(missionMatch.index + missionMatch[0].length);
        const end = rest.search(/^## /m);
        mission = (end < 0 ? rest : rest.slice(0, end)).trim();
    }
    const parsed = CouncilMemberSchema.safeParse({
        id: data.id,
        title: data.title,
        mission,
        owns: parseSection(body, 'Owns'),
        decidesAlone: parseSection(body, 'Decides alone'),
        escalates: parseSection(body, 'Escalates'),
        outputContract: parseSection(body, 'Every answer must contain'),
        enabled: data.enabled ?? true,
        builtin: data.builtin ?? false,
        group: data.group ?? 'custom',
        order: data.order ?? 100,
    });
    return parsed.success ? parsed.data : null;
}

/**
 * Write the built-in charters once. Never overwrites: the whole point of
 * storing them as Markdown is that the user can rewrite a charter, and a
 * re-seed on every launch would silently revert their edits.
 */
export function seedBuiltinMembers(): void {
    ensureDir(MEMBERS_DIR);
    for (const member of ALL_BUILTIN_MEMBERS) {
        const file = path.join(MEMBERS_DIR, `${member.id}.md`);
        if (!fs.existsSync(file)) fs.writeFileSync(file, memberToMarkdown(member), 'utf-8');
    }
}

export function listMembers(): CouncilMember[] {
    seedBuiltinMembers();
    let names: string[];
    try {
        names = fs.readdirSync(MEMBERS_DIR).filter((n) => n.endsWith('.md'));
    } catch {
        return [];
    }
    const members: CouncilMember[] = [];
    for (const name of names) {
        try {
            const member = memberFromMarkdown(fs.readFileSync(path.join(MEMBERS_DIR, name), 'utf-8'));
            if (member) members.push(member);
        } catch {
            // A malformed charter should not take the whole council down.
        }
    }
    // Roster first, then rank: a cabinet listed alphabetically reads wrong.
    const groupRank: Record<string, number> = { core: 0, csuite: 1, custom: 2 };
    return members.sort((a, b) =>
        (groupRank[a.group] ?? 3) - (groupRank[b.group] ?? 3)
        || a.order - b.order
        || a.title.localeCompare(b.title),
    );
}

export function saveMember(member: CouncilMember): void {
    ensureDir(MEMBERS_DIR);
    fs.writeFileSync(path.join(MEMBERS_DIR, `${member.id}.md`), memberToMarkdown(member), 'utf-8');
}

export function deleteMember(id: string): void {
    try {
        fs.rmSync(path.join(MEMBERS_DIR, `${id}.md`), { force: true });
    } catch {
        // Already gone.
    }
}

// --- Sessions ---

function sessionToMarkdown(session: CouncilSession): string {
    const parts: string[] = [`# ${session.question}\n`];

    if (session.synthesis) {
        const s = session.synthesis;
        parts.push(`## Memo\n\n**${s.headline}**\n`);
        if (s.positions.length) {
            parts.push(s.positions.map((p) => `- **${p.memberId}** — ${p.summary}`).join('\n') + '\n');
        }
        parts.push('### Disagreements\n');
        parts.push(
            s.disagreements.length
                ? s.disagreements
                      .map((d) => `- **${d.between.join(' vs ')}** — ${d.conflict}\n  - Follow: ${d.recommendation}`)
                      .join('\n') + '\n'
                : 'None material.\n',
        );
        if (s.openQuestions.length) {
            parts.push(`### Open questions\n\n${s.openQuestions.map((q) => `- ${q}`).join('\n')}\n`);
        }
        parts.push(`### Next action\n\n${s.nextAction.action} — **${s.nextAction.owner}**, ${s.nextAction.when}\n`);
    } else if (session.synthesisError) {
        parts.push(`## Memo\n\n_Synthesis failed: ${session.synthesisError}. The positions below are unaffected._\n`);
    }

    // Verbatim positions: a principal must always be able to go behind the memo.
    parts.push('## Positions\n');
    for (const p of session.positions) {
        parts.push(`### ${p.title}\n`);
        if (p.error || !p.position) {
            parts.push(`_No position: ${p.error ?? 'no answer returned'}_\n`);
            continue;
        }
        parts.push(`**Position.** ${p.position.position}\n`);
        if (p.position.why.length) parts.push(`**Why.**\n${p.position.why.map((w) => `- ${w}`).join('\n')}\n`);
        parts.push(`**Risk.** ${p.position.risk}\n`);
        parts.push(`**Unknown.** ${p.position.unknown}\n`);
        if (p.position.notMine) parts.push(`**Not mine.** ${p.position.notMine}\n`);
    }

    return withFrontmatter(
        { id: session.id, createdAt: session.createdAt, question: session.question, kind: 'council-session' },
        parts.join('\n'),
    );
}

/** The full record, kept beside the memo so the UI can re-render it exactly. */
function sessionDataPath(id: string): string {
    return path.join(SESSIONS_DIR, `${id}.json`);
}

export function saveSession(session: CouncilSession): void {
    ensureDir(SESSIONS_DIR);
    const name = `${session.id}-${slug(session.question) || 'session'}`;
    fs.writeFileSync(path.join(SESSIONS_DIR, `${name}.md`), sessionToMarkdown(session), 'utf-8');
    fs.writeFileSync(sessionDataPath(session.id), JSON.stringify(session, null, 2), 'utf-8');
}

export function listSessions(): CouncilSession[] {
    let names: string[];
    try {
        names = fs.readdirSync(SESSIONS_DIR).filter((n) => n.endsWith('.json'));
    } catch {
        return [];
    }
    const sessions: CouncilSession[] = [];
    for (const name of names) {
        try {
            const parsed = CouncilSessionSchema.safeParse(
                JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, name), 'utf-8')),
            );
            if (parsed.success) sessions.push(parsed.data);
        } catch {
            // Skip unreadable sessions rather than failing the list.
        }
    }
    return sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getSession(id: string): CouncilSession | null {
    try {
        const parsed = CouncilSessionSchema.safeParse(JSON.parse(fs.readFileSync(sessionDataPath(id), 'utf-8')));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

export function newSessionId(): string {
    return newId('session');
}

// --- Assignments ---

function assignmentToMarkdown(a: Assignment): string {
    const body = [
        `# ${a.title}\n`,
        a.detail ? `${a.detail}\n` : '',
        a.blockedReason ? `## Blocked\n\n${a.blockedReason}\n` : '',
    ].filter(Boolean).join('\n');
    return withFrontmatter(
        {
            id: a.id,
            status: a.status,
            assigneeId: a.assigneeId,
            parentId: a.parentId,
            sessionId: a.sessionId,
            createdAt: a.createdAt,
            updatedAt: a.updatedAt,
            kind: 'council-assignment',
        },
        body,
    );
}

function assignmentFromMarkdown(content: string): Assignment | null {
    const { data, body } = readFrontmatter(content);
    const titleMatch = /^# (.+)$/m.exec(body);
    const blockedMatch = /^## Blocked\s*$/im.exec(body);
    let detail = body.replace(/^# .+$/m, '').trim();
    let blockedReason: string | null = null;
    if (blockedMatch) {
        detail = body.slice(0, blockedMatch.index).replace(/^# .+$/m, '').trim();
        blockedReason = body.slice(blockedMatch.index + blockedMatch[0].length).trim() || null;
    }
    const parsed = AssignmentSchema.safeParse({
        id: data.id,
        title: titleMatch?.[1] ?? '',
        detail,
        assigneeId: data.assigneeId ?? null,
        status: data.status ?? 'open',
        parentId: data.parentId ?? null,
        sessionId: data.sessionId ?? null,
        blockedReason,
        createdAt: data.createdAt ?? new Date().toISOString(),
        updatedAt: data.updatedAt ?? new Date().toISOString(),
    });
    return parsed.success ? parsed.data : null;
}

function assignmentPath(id: string): string {
    return path.join(ASSIGNMENTS_DIR, `${id}.md`);
}

export function listAssignments(): Assignment[] {
    let names: string[];
    try {
        names = fs.readdirSync(ASSIGNMENTS_DIR).filter((n) => n.endsWith('.md'));
    } catch {
        return [];
    }
    const out: Assignment[] = [];
    for (const name of names) {
        try {
            const a = assignmentFromMarkdown(fs.readFileSync(path.join(ASSIGNMENTS_DIR, name), 'utf-8'));
            if (a) out.push(a);
        } catch {
            // Skip unreadable assignments.
        }
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function saveAssignment(a: Assignment): void {
    ensureDir(ASSIGNMENTS_DIR);
    fs.writeFileSync(assignmentPath(a.id), assignmentToMarkdown(a), 'utf-8');
}

export function getAssignment(id: string): Assignment | null {
    try {
        return assignmentFromMarkdown(fs.readFileSync(assignmentPath(id), 'utf-8'));
    } catch {
        return null;
    }
}

export function deleteAssignment(id: string): void {
    try {
        fs.rmSync(assignmentPath(id), { force: true });
    } catch {
        // Already gone.
    }
}

export function newAssignmentId(): string {
    return newId('task');
}
