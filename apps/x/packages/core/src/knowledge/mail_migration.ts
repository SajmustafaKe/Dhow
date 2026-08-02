import fs from 'fs';
import path from 'path';
import { WorkDir } from '../config/config.js';
import { LEGACY_ACCOUNT_ID } from '../auth/repo.js';
import {
    LEGACY_GMAIL_SYNC_DIR,
    LEGACY_INBOX_LISTS_DIR,
    mailPaths,
} from './mail_paths.js';

/**
 * One-time move from the flat, single-mailbox layout to the per-account one.
 *
 * Old:  <WorkDir>/gmail_sync/*.md, gmail_sync/attachments, gmail_sync/cache,
 *       <WorkDir>/inbox_lists/*.json, <WorkDir>/search_index
 * New:  <WorkDir>/mail/google/<accountId>/{threads,cache,attachments,search_index}
 *
 * The pre-existing connection migrates to LEGACY_ACCOUNT_ID, matching the
 * credential-store migration so the mail and its grant stay associated.
 *
 * Safe to call on every startup: a fresh install has no legacy directories and
 * this is a no-op. Individual files that already exist at the destination are
 * skipped rather than overwritten, so a partially-completed run resumes
 * without destroying newer data.
 */

const LEGACY_SEARCH_INDEX_DIR = path.join(WorkDir, 'search_index');
const LEGACY_CACHE_IN_SYNC_DIR = path.join(LEGACY_GMAIL_SYNC_DIR, 'cache');
const LEGACY_ATTACHMENTS_DIR = path.join(LEGACY_GMAIL_SYNC_DIR, 'attachments');

export interface MailMigrationResult {
    migrated: boolean;
    movedFiles: number;
    skipped: number;
}

/** Move one file, falling back to copy+unlink when rename crosses a device. */
function moveFile(from: string, to: string): 'moved' | 'skipped' {
    if (fs.existsSync(to)) return 'skipped';
    fs.mkdirSync(path.dirname(to), { recursive: true });
    try {
        fs.renameSync(from, to);
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        // EXDEV: separate filesystems (e.g. the vault on an external volume).
        if (code !== 'EXDEV') throw err;
        fs.copyFileSync(from, to);
        fs.unlinkSync(from);
    }
    return 'moved';
}

/** Move a directory's immediate file children, leaving subdirectories alone. */
function moveDirFiles(fromDir: string, toDir: string, filter?: (name: string) => boolean): { moved: number; skipped: number } {
    let moved = 0;
    let skipped = 0;
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(fromDir, { withFileTypes: true });
    } catch {
        return { moved, skipped };
    }
    for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (filter && !filter(entry.name)) continue;
        const result = moveFile(path.join(fromDir, entry.name), path.join(toDir, entry.name));
        if (result === 'moved') moved++;
        else skipped++;
    }
    return { moved, skipped };
}

export function migrateLegacyMailLayout(): MailMigrationResult {
    const hasLegacy =
        fs.existsSync(LEGACY_GMAIL_SYNC_DIR) ||
        fs.existsSync(LEGACY_INBOX_LISTS_DIR) ||
        fs.existsSync(LEGACY_SEARCH_INDEX_DIR);
    if (!hasLegacy) return { migrated: false, movedFiles: 0, skipped: 0 };

    const target = mailPaths('google', LEGACY_ACCOUNT_ID);
    let movedFiles = 0;
    let skipped = 0;

    try {
        // Markdown thread mirrors — the directory registered as a knowledge source.
        const threads = moveDirFiles(LEGACY_GMAIL_SYNC_DIR, target.threads, (n) => n.endsWith('.md'));
        movedFiles += threads.moved;
        skipped += threads.skipped;

        // sync_state.json holds the historyId and belongs beside the account.
        if (fs.existsSync(path.join(LEGACY_GMAIL_SYNC_DIR, 'sync_state.json'))) {
            const r = moveFile(
                path.join(LEGACY_GMAIL_SYNC_DIR, 'sync_state.json'),
                path.join(target.root, 'sync_state.json'),
            );
            if (r === 'moved') movedFiles++; else skipped++;
        }

        // Snapshot cache. `inbox_lists` superseded `gmail_sync/cache`, so the
        // newer location wins where both exist — moveFile skips collisions.
        for (const from of [LEGACY_INBOX_LISTS_DIR, LEGACY_CACHE_IN_SYNC_DIR]) {
            const r = moveDirFiles(from, target.cache, (n) => n.endsWith('.json'));
            movedFiles += r.moved;
            skipped += r.skipped;
        }

        const attachments = moveDirFiles(LEGACY_ATTACHMENTS_DIR, target.attachments);
        movedFiles += attachments.moved;
        skipped += attachments.skipped;

        const search = moveDirFiles(LEGACY_SEARCH_INDEX_DIR, target.searchIndex, (n) => n.endsWith('.json'));
        movedFiles += search.moved;
        skipped += search.skipped;

        // Remove the legacy directories only once they are actually empty, so
        // anything unrecognised is preserved rather than silently deleted.
        for (const dir of [LEGACY_ATTACHMENTS_DIR, LEGACY_CACHE_IN_SYNC_DIR, LEGACY_GMAIL_SYNC_DIR, LEGACY_INBOX_LISTS_DIR, LEGACY_SEARCH_INDEX_DIR]) {
            try {
                if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
            } catch {
                // Leave it; a non-empty or busy directory is not a failure.
            }
        }

        console.log(`[Mail] Migrated legacy mail layout to ${target.root} (${movedFiles} files, ${skipped} skipped)`);
        return { migrated: true, movedFiles, skipped };
    } catch (err) {
        // A partial migration is resumable — nothing is deleted until its
        // directory is empty, and existing destinations are never overwritten.
        console.error('[Mail] Legacy mail layout migration failed:', err);
        return { migrated: false, movedFiles, skipped };
    }
}
