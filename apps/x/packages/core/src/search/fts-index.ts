// Brain search index. Plan Phase 0.
//
// This replaces `grep -ril` over WorkDir/knowledge (search.ts) with a real
// ranked full-text index, and it costs ZERO new dependencies: node:sqlite is
// built into the Electron 39.2.7 runtime (Node 22.21.1, SQLite 3.50.4) and
// ships FTS5.
//
// Why not DuckDB, which Data Mode already pulls in: measured in the plan
// (3.6), DuckDB's FTS index is a materialized snapshot that goes STALE on
// every write and can only be repaired by rebuilding the whole corpus.
// build_graph.ts processes ONE source file per agent run, so writes are
// constant and tiny, which is the worst possible pattern for a rebuild-only
// index. DuckDB also takes an exclusive per-process file lock, and Dhow spawns
// child processes that need to read. SQLite FTS5 is transactional and allows
// concurrent readers, so it wins this specific job outright.
//
// node:sqlite is SYNCHRONOUS (DatabaseSync has no async variant), so a large
// first-run sync is chunked with awaits between batches to keep the main
// process responsive.

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WorkDir } from '../config/config.js';

/** Files per batch before yielding to the event loop. */
const SYNC_BATCH = 200;

/** Body text stored per note. Enough for ranking without bloating the index. */
const MAX_BODY = 200_000;

export type IndexedDoc = {
    path: string;
    title: string;
    body: string;
    mtimeMs: number;
    hash: string;
};

export type SyncStats = {
    added: number;
    updated: number;
    removed: number;
    scanned: number;
    /** Files whose mtime moved but whose content was unchanged. */
    unchanged: number;
};

export type FtsHit = {
    path: string;
    title: string;
    snippet: string;
    score: number;
};

export function defaultIndexPath(): string {
    return path.join(WorkDir, 'knowledge_fts.sqlite');
}

/** FTS5 grammar keywords. As literal search terms they are noise anyway. */
const FTS_KEYWORDS = new Set(['AND', 'OR', 'NOT', 'NEAR']);

/**
 * Turn arbitrary user text into a safe FTS5 MATCH expression.
 *
 * FTS5 has its own query grammar: a bare `"`, `*`, `:`, `^`, `-`, or a token
 * that happens to be AND/OR/NOT/NEAR is a syntax error, not a search term.
 * Users type all of those, so every token is stripped and quoted.
 *
 * Operator words are DROPPED rather than quoted. Someone typing "supplier AND
 * margin" means the operator, and searching for the literal word "AND" finds
 * nothing; conjunction is already the default here.
 */
export function toMatchExpression(query: string): string {
    const tokens = String(query ?? '')
        .replace(/[^\p{L}\p{N}\s_]+/gu, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .filter((t) => !FTS_KEYWORDS.has(t.toUpperCase()))
        .map((t) => `"${t.replace(/"/g, '""')}"`);
    return tokens.join(' AND ');
}

function sha256(s: string): string {
    return crypto.createHash('sha256').update(s).digest('hex');
}

export class FtsIndex {
    readonly dbPath: string;
    #db: DatabaseSync;

    constructor(dbPath: string) {
        this.dbPath = dbPath;
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
        this.#db = new DatabaseSync(dbPath);
        // WAL keeps readers (child processes) from blocking on the writer.
        this.#db.exec('PRAGMA journal_mode=WAL');
        this.#db.exec(`
            CREATE VIRTUAL TABLE IF NOT EXISTS notes
            USING fts5(path UNINDEXED, title, body, tokenize='unicode61');
        `);
        this.#db.exec(`
            CREATE TABLE IF NOT EXISTS docs(
                path TEXT PRIMARY KEY,
                mtime_ms REAL NOT NULL,
                hash TEXT NOT NULL
            );
        `);
    }

    close(): void {
        try {
            this.#db.close();
        } catch {
            // Already closed.
        }
    }

    /**
     * Bring the index in line with `dir`.
     *
     * Change detection mirrors knowledge/graph_state.ts: compare mtime first
     * and only hash when it moved. Hashing every note on every sync would make
     * this slower than the grep it replaces.
     */
    async syncDir(dir: string): Promise<SyncStats> {
        const stats: SyncStats = { added: 0, updated: 0, removed: 0, scanned: 0, unchanged: 0 };
        if (!fs.existsSync(dir)) return stats;

        const known = new Map<string, { mtime_ms: number; hash: string }>();
        for (const row of this.#db.prepare('SELECT path, mtime_ms, hash FROM docs').all()) {
            known.set(String(row.path), {
                mtime_ms: Number(row.mtime_ms),
                hash: String(row.hash),
            });
        }

        const files = await listMarkdown(dir);
        const seen = new Set<string>();

        const insertNote = this.#db.prepare('INSERT INTO notes(path, title, body) VALUES (?, ?, ?)');
        const deleteNote = this.#db.prepare('DELETE FROM notes WHERE path = ?');
        const upsertDoc = this.#db.prepare(
            'INSERT INTO docs(path, mtime_ms, hash) VALUES (?, ?, ?) ' +
                'ON CONFLICT(path) DO UPDATE SET mtime_ms = excluded.mtime_ms, hash = excluded.hash',
        );

        for (let i = 0; i < files.length; i += SYNC_BATCH) {
            const batch = files.slice(i, i + SYNC_BATCH);
            this.#db.exec('BEGIN');
            try {
                for (const file of batch) {
                    stats.scanned++;
                    seen.add(file);
                    let mtimeMs: number;
                    try {
                        mtimeMs = (await fsp.stat(file)).mtimeMs;
                    } catch {
                        continue;
                    }
                    const prior = known.get(file);
                    if (prior && prior.mtime_ms === mtimeMs) continue;

                    let body: string;
                    try {
                        body = (await fsp.readFile(file, 'utf8')).slice(0, MAX_BODY);
                    } catch {
                        continue;
                    }
                    const hash = sha256(body);
                    if (prior && prior.hash === hash) {
                        // mtime moved but content did not: a touch, a sync, a
                        // checkout. Refresh the mtime so the next pass is cheap.
                        upsertDoc.run(file, mtimeMs, hash);
                        stats.unchanged++;
                        continue;
                    }

                    const title = path.basename(file, path.extname(file));
                    if (prior) {
                        deleteNote.run(file);
                        stats.updated++;
                    } else {
                        stats.added++;
                    }
                    insertNote.run(file, title, body);
                    upsertDoc.run(file, mtimeMs, hash);
                }
                this.#db.exec('COMMIT');
            } catch (err) {
                this.#db.exec('ROLLBACK');
                throw err;
            }
            // Yield so a first-run sync over a large vault does not wedge the
            // main process; DatabaseSync blocks for the whole batch.
            await new Promise((r) => setImmediate(r));
        }

        // Anything indexed but no longer on disk.
        for (const known_path of known.keys()) {
            if (seen.has(known_path)) continue;
            deleteNote.run(known_path);
            this.#db.prepare('DELETE FROM docs WHERE path = ?').run(known_path);
            stats.removed++;
        }

        return stats;
    }

    search(query: string, limit = 20): FtsHit[] {
        const match = toMatchExpression(query);
        if (!match) return [];
        try {
            const rows = this.#db
                .prepare(
                    `SELECT path, title,
                            snippet(notes, 2, '', '', '\u2026', 16) AS snippet,
                            bm25(notes, 0.0, 5.0, 1.0) AS score
                     FROM notes WHERE notes MATCH ? ORDER BY score LIMIT ?`,
                )
                .all(match, limit);
            return rows.map((r) => ({
                path: String(r.path),
                title: String(r.title),
                snippet: String(r.snippet ?? '').replace(/\s+/g, ' ').trim(),
                // bm25 returns a negative number where more negative is better.
                // Flip it so callers can sort descending like every other score.
                score: -Number(r.score ?? 0),
            }));
        } catch {
            // A malformed MATCH must degrade to "no results", never throw into
            // the caller's search path.
            return [];
        }
    }

    /** Rows currently indexed. Exposed for diagnostics and tests. */
    count(): number {
        const row = this.#db.prepare('SELECT count(*) AS n FROM docs').get();
        return Number(row?.n ?? 0);
    }
}

let shared: FtsIndex | null = null;
let sharedFailed = false;

/** Process-wide index handle. Returns null once opening has failed. */
export function openIndex(dbPath = defaultIndexPath()): FtsIndex | null {
    if (shared && shared.dbPath === dbPath) return shared;
    if (sharedFailed) return null;
    try {
        shared = new FtsIndex(dbPath);
        return shared;
    } catch (err) {
        // node:sqlite is absent, or the file is unwritable. Callers fall back
        // to grep rather than losing search entirely.
        sharedFailed = true;
        console.warn(
            '[fts-index] falling back to grep search:',
            err instanceof Error ? err.message : String(err),
        );
        return null;
    }
}

/** Test helper: forget the shared handle. */
export function resetSharedIndex(): void {
    shared?.close();
    shared = null;
    sharedFailed = false;
}

async function listMarkdown(dir: string): Promise<string[]> {
    const out: string[] = [];
    async function walk(current: string): Promise<void> {
        let entries: import('node:fs').Dirent[];
        try {
            entries = await fsp.readdir(current, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === '.git' || entry.name === 'node_modules') continue;
                await walk(full);
            } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
                out.push(full);
            }
        }
    }
    await walk(dir);
    return out;
}
