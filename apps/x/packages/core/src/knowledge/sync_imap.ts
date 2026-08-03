import { ImapFlow } from 'imapflow';
import { simpleParser, type ParsedMail } from 'mailparser';
import { calendarParts, ingestCalendarParts } from './calendar_invites.js';
import { PrefixLogger } from '@x/shared';
import container from '../di/container.js';
import type { IImapRepo, ImapAccount } from '../auth/imap-repo.js';
import {
    loadSyncState,
    saveSyncState,
    writeSnapshot,
    writeThreadMirror,
    type NormalizedMessage,
    type NormalizedThread,
} from './mail_thread.js';

const log = new PrefixLogger('IMAP');
const PROVIDER = 'imap';
const SYNC_INTERVAL_MS = 2 * 60 * 1000;

/**
 * Generic IMAP sync.
 *
 * Materially weaker than Gmail or Graph, and the code has to acknowledge that
 * rather than pretend otherwise:
 *
 * - **No server-side threading.** IMAP has no conversation id, so threads are
 *   derived from `References`/`In-Reply-To`, falling back to the message's own
 *   id. This groups less well than Gmail; it is the best the protocol offers.
 * - **UIDVALIDITY is the trapdoor.** UIDs are only meaningful while
 *   UIDVALIDITY is unchanged. When a server renumbers a mailbox, every stored
 *   UID silently refers to a different message — so a change forces a full
 *   resync rather than an incremental one. Missing this is the classic IMAP
 *   corruption bug.
 * - **Fetch is bounded.** A first sync pulls the most recent slice rather than
 *   the entire mailbox, because there is no count-bounded server-side query.
 */

const MAX_MESSAGES_PER_SYNC = 200;

function repo(): IImapRepo {
    return container.resolve<IImapRepo>('imapRepo');
}

/** Thread key from RFC 5322 headers — the root of the reference chain. */
/** Exported for tests: the trickiest pure function in this module. */
export function threadKeyFor(parsed: ParsedMail): string {
    const references = parsed.references;
    if (Array.isArray(references) && references.length > 0) return references[0];
    if (typeof references === 'string' && references) return references;
    if (parsed.inReplyTo) return parsed.inReplyTo.split(/\s+/)[0];
    return parsed.messageId ?? `no-id-${parsed.date?.getTime() ?? Date.now()}`;
}

function addressText(value: ParsedMail['from']): string {
    return value?.text ?? 'Unknown';
}

function toNormalizedMessage(parsed: ParsedMail, uid: number, seen: boolean): NormalizedMessage {
    return {
        id: String(uid),
        from: addressText(parsed.from),
        to: Array.isArray(parsed.to) ? parsed.to.map((t) => t.text).join(', ') : parsed.to?.text,
        cc: Array.isArray(parsed.cc) ? parsed.cc.map((t) => t.text).join(', ') : parsed.cc?.text,
        date: (parsed.date ?? new Date()).toISOString(),
        subject: parsed.subject,
        body: parsed.text ?? '',
        bodyHtml: typeof parsed.html === 'string' ? parsed.html : undefined,
        unread: !seen,
        messageIdHeader: parsed.messageId,
        inReplyToHeader: parsed.inReplyTo,
        referencesHeader: Array.isArray(parsed.references) ? parsed.references.join(' ') : parsed.references,
        attachments: parsed.attachments?.map((a) => ({
            filename: a.filename ?? 'attachment',
            mimeType: a.contentType,
            sizeBytes: a.size,
        })),
    };
}

async function syncAccount(account: ImapAccount): Promise<void> {
    if (!account.password) {
        // Encrypted with a keychain this machine cannot open. Failing loudly
        // beats retrying with a null password forever.
        await repo().setError(account.id, 'Stored password could not be decrypted on this machine. Re-enter it.');
        return;
    }

    const client = new ImapFlow({
        host: account.host,
        port: account.port,
        // `secure` is TLS-from-connect; STARTTLS instead opens plain and
        // upgrades, which imapflow does automatically when secure is false.
        secure: account.security === 'ssl',
        ...(account.security === 'none' ? { ignoreTLS: true } : {}),
        auth: { user: account.username, pass: account.password },
        logger: false,
    });

    await client.connect();
    try {
        const lock = await client.getMailboxLock('INBOX');
        try {
            const mailbox = client.mailbox;
            if (!mailbox || typeof mailbox === 'boolean') throw new Error('INBOX unavailable');

            // How many messages the server says are there. Without this a
            // sync that fetches nothing is indistinguishable from a sync that
            // found an empty mailbox — the difference matters when debugging.
            const existsCount = typeof mailbox.exists === 'number' ? mailbox.exists : 0;
            const state = loadSyncState(PROVIDER, account.id);
            const uidValidity = Number(mailbox.uidValidity);
            // The trapdoor: a changed UIDVALIDITY invalidates every stored UID.
            const validityChanged = state.uidValidity !== undefined && state.uidValidity !== uidValidity;
            if (validityChanged) {
                log.log(`UIDVALIDITY changed for ${account.id} (${state.uidValidity} -> ${uidValidity}); resyncing from scratch`);
            }

            const lastUid = validityChanged ? 0 : Number(state.changeToken ?? 0);
            const range = lastUid > 0 ? `${lastUid + 1}:*` : `1:*`;

            let fetched = 0;
            let highestUid = lastUid;
            const byThread = new Map<string, { uid: number; parsed: ParsedMail; seen: boolean }[]>();
            const invitations: { contentType?: string; filename?: string; content?: Buffer | string }[] = [];

            for await (const message of client.fetch(range, { uid: true, source: true, flags: true }, { uid: true })) {
                if (!message.source) continue;
                // On a first sync this walks from UID 1; the cap keeps an old
                // mailbox from blocking every other account behind it.
                if (fetched >= MAX_MESSAGES_PER_SYNC) break;
                fetched++;
                highestUid = Math.max(highestUid, message.uid);

                const parsed = await simpleParser(message.source);
                // Collected here because this is the only point where the full
                // MIME tree exists; the normalized thread keeps attachment
                // metadata but drops the bytes.
                invitations.push(...calendarParts(parsed.attachments));
                const key = threadKeyFor(parsed);
                const seen = message.flags?.has('\\Seen') ?? false;
                const list = byThread.get(key);
                if (list) list.push({ uid: message.uid, parsed, seen });
                else byThread.set(key, [{ uid: message.uid, parsed, seen }]);
            }

            for (const [threadKey, messages] of byThread) {
                messages.sort((a, b) => (a.parsed.date?.getTime() ?? 0) - (b.parsed.date?.getTime() ?? 0));
                const last = messages[messages.length - 1];
                const normalized: NormalizedThread = {
                    threadId: threadKey,
                    subject: last.parsed.subject || '(no subject)',
                    unread: messages.some((m) => !m.seen),
                    messages: messages.map((m) => toNormalizedMessage(m.parsed, m.uid, m.seen)),
                    changeKey: String(last.uid),
                };
                writeThreadMirror(PROVIDER, account.id, normalized);
                writeSnapshot(PROVIDER, account.id, threadKey, normalized.changeKey ?? '', {
                    accountId: account.id,
                    provider: 'imap',
                    threadId: threadKey,
                    threadUrl: '',
                    subject: normalized.subject,
                    from: normalized.messages[0]?.from,
                    to: normalized.messages[0]?.to,
                    date: normalized.messages[normalized.messages.length - 1]?.date,
                    unread: normalized.unread,
                    messages: normalized.messages,
                });
            }

            saveSyncState(PROVIDER, account.id, {
                ...state,
                uidValidity,
                changeToken: String(highestUid),
                mailboxMessageCount: existsCount,
                lastFetched: fetched,
            });

            // A server reporting mail that we did not retrieve is a bug on our
            // side, not an empty mailbox — say so rather than logging success.
            if (existsCount > 0 && fetched === 0 && lastUid === 0) {
                const message = `INBOX reports ${existsCount} message(s) but none were fetched.`;
                await repo().setError(account.id, message);
                log.log(`${account.id}: ${message}`);
                return;
            }

            if (invitations.length > 0) {
                // An IMAP account has no calendar API, so the invitation in
                // the mailbox is the only record of the meeting.
                const emails = [account.email, account.username].filter((e): e is string => !!e);
                const { written } = ingestCalendarParts(
                    invitations as { content: Buffer | string }[],
                    emails,
                );
                if (written > 0) log.log(`${written} calendar invitation(s) stored for ${account.id}`);
            }

            await repo().setError(account.id, null);
            log.log(`Synced ${fetched} of ${existsCount} message(s) across ${byThread.size} thread(s) for ${account.id}`);
        } finally {
            lock.release();
        }
    } finally {
        await client.logout().catch(() => client.close());
    }
}

/** Verify credentials before saving them, so a typo fails at the form. */
export async function testImapConnection(params: {
    host: string;
    port: number;
    security: 'ssl' | 'starttls' | 'none';
    username: string;
    password: string;
}): Promise<{ ok: boolean; error?: string }> {
    const client = new ImapFlow({
        host: params.host,
        port: params.port,
        secure: params.security === 'ssl',
        ...(params.security === 'none' ? { ignoreTLS: true } : {}),
        auth: { user: params.username, pass: params.password },
        logger: false,
    });
    try {
        await client.connect();
        const lock = await client.getMailboxLock('INBOX');
        lock.release();
        await client.logout();
        return { ok: true };
    } catch (err) {
        try { client.close(); } catch { /* already closed */ }
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
}

/**
 * Verify the outgoing server separately from the incoming one.
 *
 * They fail independently and for different reasons — a working IMAP login
 * says nothing about whether SMTP will accept the same credentials, and many
 * hosts use a different port and security mode for each. Reporting one result
 * for both would hide exactly the half that is broken.
 */
export async function testSmtpConnection(params: {
    host: string;
    port: number;
    security: 'ssl' | 'starttls' | 'none';
    username: string;
    password: string;
}): Promise<{ ok: boolean; error?: string }> {
    const nodemailer = await import('nodemailer');
    const transport = nodemailer.createTransport({
        host: params.host,
        port: params.port,
        secure: params.security === 'ssl',
        requireTLS: params.security === 'starttls',
        ignoreTLS: params.security === 'none',
        auth: { user: params.username, pass: params.password },
    });
    try {
        await transport.verify();
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
        transport.close();
    }
}

let wakeResolve: (() => void) | null = null;

export function triggerSync(accountId?: string): void {
    if (wakeResolve) {
        log.log(accountId ? `Triggered for ${accountId}` : 'Triggered');
        wakeResolve();
        wakeResolve = null;
    }
}

export async function performSync(accountId?: string): Promise<void> {
    const accounts = await repo().list();
    const targets = accountId ? accounts.filter((a) => a.id === accountId) : accounts;
    for (const account of targets) {
        try {
            await syncAccount(account);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            // Recorded on the account so the UI can show why, and isolated so
            // one unreachable server does not stop the others.
            await repo().setError(account.id, message);
            log.log(`Sync failed for ${account.id}: ${message}`);
        }
    }
}

export function init(): void {
    void (async () => {
        for (;;) {
            await performSync();
            await new Promise<void>((resolve) => {
                wakeResolve = resolve;
                setTimeout(resolve, SYNC_INTERVAL_MS).unref?.();
            });
        }
    })();
}
