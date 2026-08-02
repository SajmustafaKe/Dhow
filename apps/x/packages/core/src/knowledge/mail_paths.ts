import path from 'path';
import { WorkDir } from '../config/config.js';

/**
 * Per-account vault layout for mail.
 *
 * Mail artifacts used to live in flat top-level directories (`gmail_sync/`,
 * `inbox_lists/`), which silently assumed one mailbox. Thread ids are only
 * unique *within* a mailbox, so a second account sharing those directories
 * would overwrite the first account's threads rather than sit beside them.
 * Namespacing by account is what makes more than one mailbox possible at all.
 *
 * Ids are opaque and never parsed. They are used as path segments, so they
 * must be filesystem-safe — see `assertSafeAccountId`.
 */

export const MAIL_ROOT = path.join(WorkDir, 'mail');

/** Legacy flat directories, still read by the one-time migration. */
export const LEGACY_GMAIL_SYNC_DIR = path.join(WorkDir, 'gmail_sync');
export const LEGACY_INBOX_LISTS_DIR = path.join(WorkDir, 'inbox_lists');

export interface MailPaths {
    /** Markdown thread mirrors — the directory registered as a knowledge source. */
    threads: string;
    /** Thread snapshot JSON backing the inbox UI. */
    cache: string;
    attachments: string;
    /** Per-account search index. */
    searchIndex: string;
    /** The account's root; delete this to remove every trace of the account. */
    root: string;
}

/**
 * Reject anything that could escape the account's directory or collide after
 * case-folding on macOS/Windows. Ids come from provider subject claims, so
 * this should never fire — it is a containment guarantee, not validation of
 * user input.
 */
export function assertSafeAccountId(accountId: string): void {
    if (!accountId || !/^[A-Za-z0-9._@-]+$/.test(accountId) || accountId === '.' || accountId === '..') {
        throw new Error(`Unsafe mail account id: ${JSON.stringify(accountId)}`);
    }
}

export function mailPaths(provider: string, accountId: string): MailPaths {
    assertSafeAccountId(provider);
    assertSafeAccountId(accountId);
    const root = path.join(MAIL_ROOT, provider, accountId);
    return {
        root,
        threads: path.join(root, 'threads'),
        cache: path.join(root, 'cache'),
        attachments: path.join(root, 'attachments'),
        searchIndex: path.join(root, 'search_index'),
    };
}

/**
 * Stable knowledge-source id for one mailbox, e.g. `mail:google:default`.
 * `build_graph` keys per-source state off this, so it must not change once an
 * account has synced.
 */
export function mailSourceId(provider: string, accountId: string): string {
    return `mail:${provider}:${accountId}`;
}

/** Vault-relative artifact dir, which is how KnowledgeSourceConfig stores it. */
export function mailArtifactDir(provider: string, accountId: string): string {
    return path.relative(WorkDir, mailPaths(provider, accountId).threads);
}
