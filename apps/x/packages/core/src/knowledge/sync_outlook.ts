import { NodeHtmlMarkdown } from 'node-html-markdown';
import { PrefixLogger } from '@x/shared';
import { GraphClientFactory, graphRequest } from './graph-client-factory.js';
import {
    loadSyncState,
    saveSyncState,
    writeSnapshot,
    writeThreadMirror,
    type NormalizedMessage,
    type NormalizedThread,
} from './mail_thread.js';

const log = new PrefixLogger('Outlook');
const PROVIDER = 'microsoft';
const SYNC_INTERVAL_MS = 60 * 1000;
const nhm = new NodeHtmlMarkdown();

/**
 * Outlook / Microsoft 365 sync, via Graph delta queries.
 *
 * Graph's delta link is the analogue of Gmail's `historyId`: the first call
 * walks the folder, and the `@odata.deltaLink` it returns is replayed next
 * time to get only what changed. Storing that link is the entire incremental
 * story — far stronger than IMAP, roughly equivalent to Gmail.
 *
 * Threading uses `conversationId`, which Graph maintains server-side, so this
 * groups the same way Gmail does rather than guessing from References headers.
 */

export interface GraphMessage {
    id: string;
    conversationId?: string;
    subject?: string;
    bodyPreview?: string;
    body?: { contentType?: string; content?: string };
    from?: { emailAddress?: { name?: string; address?: string } };
    toRecipients?: { emailAddress?: { name?: string; address?: string } }[];
    ccRecipients?: { emailAddress?: { name?: string; address?: string } }[];
    receivedDateTime?: string;
    isRead?: boolean;
    isDraft?: boolean;
    hasAttachments?: boolean;
    internetMessageId?: string;
    webLink?: string;
    '@removed'?: { reason?: string };
}

interface DeltaPage {
    value: GraphMessage[];
    '@odata.nextLink'?: string;
    '@odata.deltaLink'?: string;
}

function addressOf(entry?: { emailAddress?: { name?: string; address?: string } }): string {
    const email = entry?.emailAddress;
    if (!email) return 'Unknown';
    if (email.name && email.address) return `${email.name} <${email.address}>`;
    return email.address ?? email.name ?? 'Unknown';
}

function addressList(entries?: { emailAddress?: { name?: string; address?: string } }[]): string | undefined {
    if (!entries?.length) return undefined;
    return entries.map(addressOf).join(', ');
}

function toNormalizedMessage(msg: GraphMessage): NormalizedMessage {
    const isHtml = msg.body?.contentType?.toLowerCase() === 'html';
    const raw = msg.body?.content ?? msg.bodyPreview ?? '';
    return {
        id: msg.id,
        from: addressOf(msg.from),
        to: addressList(msg.toRecipients),
        cc: addressList(msg.ccRecipients),
        date: msg.receivedDateTime ?? new Date().toISOString(),
        subject: msg.subject,
        // Downstream expects text; Graph hands back HTML for most real mail.
        body: isHtml ? nhm.translate(raw) : raw,
        bodyHtml: isHtml ? raw : undefined,
        unread: msg.isRead === false,
        isDraft: msg.isDraft === true,
        messageIdHeader: msg.internetMessageId,
    };
}

/** Group a flat delta page into threads by conversation. */
/** Exported for tests. */
export function groupByConversation(messages: GraphMessage[]): Map<string, GraphMessage[]> {
    const byConversation = new Map<string, GraphMessage[]>();
    for (const msg of messages) {
        // A message with no conversationId is its own thread rather than being
        // dropped into a shared bucket with every other orphan.
        const key = msg.conversationId || msg.id;
        const list = byConversation.get(key);
        if (list) list.push(msg);
        else byConversation.set(key, [msg]);
    }
    return byConversation;
}

const SELECT = [
    'id', 'conversationId', 'subject', 'bodyPreview', 'body', 'from',
    'toRecipients', 'ccRecipients', 'receivedDateTime', 'isRead', 'isDraft',
    'hasAttachments', 'internetMessageId', 'webLink',
].join(',');

async function syncAccount(accountId: string): Promise<void> {
    const state = loadSyncState(PROVIDER, accountId);
    let url = state.changeToken
        ?? `/me/mailFolders/inbox/messages/delta?$select=${SELECT}&$top=50`;

    const collected: GraphMessage[] = [];
    let deltaLink: string | undefined;
    let pages = 0;

    // Bounded: a first sync of a large mailbox would otherwise walk years of
    // mail in one pass and block every other account behind it.
    const MAX_PAGES = 20;
    while (pages < MAX_PAGES) {
        const page = await graphRequest<DeltaPage>({ url, accountId });
        collected.push(...(page.value ?? []));
        pages++;
        if (page['@odata.deltaLink']) {
            deltaLink = page['@odata.deltaLink'];
            break;
        }
        if (!page['@odata.nextLink']) break;
        url = page['@odata.nextLink'];
    }

    const removed = collected.filter((m) => m['@removed']);
    const present = collected.filter((m) => !m['@removed']);

    for (const [conversationId, messages] of groupByConversation(present)) {
        messages.sort((a, b) => (a.receivedDateTime ?? '').localeCompare(b.receivedDateTime ?? ''));
        const normalized: NormalizedThread = {
            threadId: conversationId,
            subject: messages[messages.length - 1]?.subject || '(no subject)',
            threadUrl: messages[messages.length - 1]?.webLink,
            unread: messages.some((m) => m.isRead === false),
            messages: messages.map(toNormalizedMessage),
            changeKey: messages[messages.length - 1]?.id,
        };
        writeThreadMirror(PROVIDER, accountId, normalized);
        writeSnapshot(PROVIDER, accountId, conversationId, normalized.changeKey ?? '', {
            accountId,
            provider: 'microsoft',
            threadId: conversationId,
            threadUrl: normalized.threadUrl ?? '',
            subject: normalized.subject,
            from: normalized.messages[0]?.from,
            to: normalized.messages[0]?.to,
            date: normalized.messages[normalized.messages.length - 1]?.date,
            unread: normalized.unread,
            messages: normalized.messages,
        });
    }

    if (removed.length > 0) {
        // Graph reports removals per message, not per conversation, and a
        // thread may survive losing one message — so this is logged rather
        // than acted on. Deleting the mirror here would drop live threads.
        log.log(`${removed.length} message(s) removed upstream for ${accountId}; mirrors left intact`);
    }

    saveSyncState(PROVIDER, accountId, { ...state, changeToken: deltaLink ?? state.changeToken });
    log.log(`Synced ${present.length} message(s) across ${groupByConversation(present).size} thread(s) for ${accountId}`);
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
    const accountIds = accountId ? [accountId] : await GraphClientFactory.listAccountIds();
    for (const id of accountIds) {
        try {
            await syncAccount(id);
        } catch (err) {
            // Isolated per account: an expired grant on one mailbox must not
            // stop the others.
            log.log(`Sync failed for ${id}: ${err instanceof Error ? err.message : String(err)}`);
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
