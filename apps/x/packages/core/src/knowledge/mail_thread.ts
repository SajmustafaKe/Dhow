import fs from 'fs';
import path from 'path';
import { formatTimestampForModel } from '@x/shared/dist/time.js';
import { mailPaths } from './mail_paths.js';

/**
 * Provider-neutral mail, and the one place a thread becomes files on disk.
 *
 * Gmail, Microsoft Graph and IMAP disagree about almost everything —
 * threading, ids, attachment addressing, incremental sync — but everything
 * *downstream* of the vault only sees a Markdown mirror plus a snapshot JSON.
 * That is the seam. A provider's job is to fetch and normalize; this module
 * owns the artifacts, so every mailbox produces byte-identical structure and
 * the knowledge graph cannot tell them apart.
 *
 * `sync_gmail.ts` predates this and still writes its own mirror inline. The
 * format here is copied from it deliberately — the two must not drift — and
 * folding Gmail onto this writer is worthwhile follow-up, not something to do
 * while adding two providers at once.
 */

export interface NormalizedAttachment {
    filename: string;
    mimeType?: string;
    sizeBytes?: number;
    /** WorkDir-relative path once saved, or undefined if not downloaded. */
    savedPath?: string;
    /** Provider's handle for fetching the bytes later. */
    remoteId?: string;
}

export interface NormalizedMessage {
    id: string;
    from: string;
    to?: string;
    cc?: string;
    /** RFC 2822 date string or ISO — rendered through the shared formatter. */
    date: string;
    subject?: string;
    /** Plain-text body. Providers convert HTML before handing it over. */
    body: string;
    bodyHtml?: string;
    unread?: boolean;
    isDraft?: boolean;
    messageIdHeader?: string;
    inReplyToHeader?: string;
    referencesHeader?: string;
    attachments?: NormalizedAttachment[];
}

export interface NormalizedThread {
    /** Unique within its mailbox, not globally — always paired with accountId. */
    threadId: string;
    subject: string;
    /** Deep link back to the provider's own UI, when one exists. */
    threadUrl?: string;
    unread?: boolean;
    messages: NormalizedMessage[];
    /** Provider's change token for this thread, used to skip unchanged work. */
    changeKey?: string;
}

/**
 * Render the Markdown mirror.
 *
 * The shape is load-bearing, not cosmetic: `emailAdmission` and the reply-gate
 * in `build_graph` parse `### From:` blocks, and note-creation prompts tell the
 * model to expect `**Thread ID:**`. Changing it silently breaks the knowledge
 * pipeline for every provider at once.
 */
export function renderThreadMarkdown(thread: NormalizedThread): string {
    let md = `# ${thread.subject}\n\n`;
    md += `**Thread ID:** ${thread.threadId}\n`;
    md += `**Message Count:** ${thread.messages.length}\n\n---\n\n`;

    for (const msg of thread.messages) {
        md += `### From: ${msg.from}\n`;
        md += `**Date:** ${formatTimestampForModel(msg.date)}\n\n`;
        md += `${msg.body}\n\n`;

        const saved = (msg.attachments ?? []).filter((a) => a.savedPath);
        if (saved.length > 0) {
            md += '**Attachments:**\n';
            for (const a of saved) {
                // Relative to the mirror so the link resolves inside the vault.
                md += `- [${a.filename}](attachments/${path.basename(a.savedPath!)})\n`;
            }
        }
        md += '\n---\n\n';
    }
    return md;
}

/** Write the mirror for one thread. Returns its absolute path. */
export function writeThreadMirror(provider: string, accountId: string, thread: NormalizedThread): string {
    const dir = mailPaths(provider, accountId).threads;
    fs.mkdirSync(dir, { recursive: true });
    // Thread ids can contain characters that are not path-safe (IMAP derives
    // them from Message-IDs), so the filename is encoded rather than trusted.
    const file = path.join(dir, `${encodeURIComponent(thread.threadId)}.md`);
    fs.writeFileSync(file, renderThreadMarkdown(thread), 'utf-8');
    return file;
}

/** Cache entry shape, matching what the inbox reader already expects. */
interface SnapshotEnvelope {
    historyId: string;
    fetchedAt: string;
    parserVersion?: number;
    snapshot: unknown;
}

export const SNAPSHOT_PARSER_VERSION = 3;

export function snapshotPath(provider: string, accountId: string, threadId: string): string {
    return path.join(mailPaths(provider, accountId).cache, `${encodeURIComponent(threadId)}.json`);
}

export function readSnapshotEnvelope(provider: string, accountId: string, threadId: string): SnapshotEnvelope | null {
    try {
        return JSON.parse(fs.readFileSync(snapshotPath(provider, accountId, threadId), 'utf-8')) as SnapshotEnvelope;
    } catch {
        return null;
    }
}

export function writeSnapshot(
    provider: string,
    accountId: string,
    threadId: string,
    changeKey: string,
    snapshot: unknown,
): void {
    const file = snapshotPath(provider, accountId, threadId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const envelope: SnapshotEnvelope = {
        historyId: changeKey,
        fetchedAt: new Date().toISOString(),
        parserVersion: SNAPSHOT_PARSER_VERSION,
        snapshot,
    };
    fs.writeFileSync(file, JSON.stringify(envelope), 'utf-8');
}

export function deleteThreadArtifacts(provider: string, accountId: string, threadId: string): void {
    const paths = mailPaths(provider, accountId);
    for (const file of [
        path.join(paths.threads, `${encodeURIComponent(threadId)}.md`),
        snapshotPath(provider, accountId, threadId),
    ]) {
        try {
            fs.rmSync(file, { force: true });
        } catch {
            // Already gone.
        }
    }
}

/** Per-account sync state (change tokens, last run). */
export interface MailSyncState {
    /** Graph delta link, IMAP UIDNEXT, or whatever the provider hands back. */
    changeToken?: string;
    /** IMAP only: a change here means every UID must be treated as new. */
    uidValidity?: number;
    lastSync?: string;
}

function statePath(provider: string, accountId: string): string {
    return path.join(mailPaths(provider, accountId).root, 'sync_state.json');
}

export function loadSyncState(provider: string, accountId: string): MailSyncState {
    try {
        return JSON.parse(fs.readFileSync(statePath(provider, accountId), 'utf-8')) as MailSyncState;
    } catch {
        return {};
    }
}

export function saveSyncState(provider: string, accountId: string, state: MailSyncState): void {
    const file = statePath(provider, accountId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...state, lastSync: new Date().toISOString() }, null, 2), 'utf-8');
}
