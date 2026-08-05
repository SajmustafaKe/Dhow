// The Data Mode engine: an encrypted, per-workspace DuckDB store with a
// two-phase trust model. See apps/x/DATA_MODE_PLAN.md 3.2 for the measured
// evidence behind every choice here.
//
// Phase 1 INGEST (trusted): our own SQL only, read-write, filesystem access ON
// because it has to read the user's CSV off disk.
//
// Phase 2 QUERY (untrusted): everything the model writes. A SEPARATE instance
// with the store attached READ_ONLY, filesystem and network disabled,
// extension loading disabled, and the configuration LOCKED so SQL cannot undo
// any of it. Verified blocked on that instance: DROP, UPDATE, CREATE, ATTACH,
// reading /etc/hosts, COPY to https, INSTALL, LOAD, and re-enabling
// enable_external_access. The AST gate in sql-guard.ts still runs first,
// because a locked-config READ-WRITE connection would happily run DROP.
//
// Why ATTACH rather than an instance option: `encryption_key` is NOT a
// recognized DuckDBInstance config key (verified: "The following options were
// not recognized: encryption_key"). Encryption is only reachable through
// ATTACH ... (ENCRYPTION_KEY '...'). So the instance is always :memory: and
// the real store is an attached catalog named `ws`.
//
// Two instances on one file is legal because DuckDB's lock is per-process.
// Verified: a READ_ONLY attach succeeds while this process holds the writer.
// A DIFFERENT process cannot, not even read-only, which is exactly why the
// brain index lives in SQLite instead (plan 3.6).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { WorkDir } from '../config/config.js';
import { assertSelectOnly, errText } from './sql-guard.js';
import type { ColumnProfile, QueryResult, TableProfile } from './types.js';

/** Hard ceiling on rows handed back from a query. The model never needs more. */
const DEFAULT_MAX_ROWS = 1000;

/** The attached catalog name. All Data Mode tables live inside it. */
const CATALOG = 'ws';

const PROFILE_TABLE = '_dhow_table_profiles';

export function dataDirFor(workspaceId: string): string {
    return path.join(WorkDir, 'data', sanitizeTableName(workspaceId));
}

/**
 * The single source of truth for identifiers. Nothing else in Data Mode may
 * build a table name, because everything downstream interpolates the result
 * straight into SQL.
 */
export function sanitizeTableName(raw: string): string {
    const cleaned = String(raw ?? '')
        .normalize('NFKD')
        .replace(/[^\w]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 60)
        .toLowerCase();
    if (!cleaned) return 't_' + crypto.randomBytes(4).toString('hex');
    // A leading digit is not a valid unquoted identifier.
    return /^[0-9]/.test(cleaned) ? `t_${cleaned}` : cleaned;
}

/** Escape a value for a single-quoted SQL literal. Values only, never identifiers. */
export function sqlLiteral(v: unknown): string {
    if (v === null || v === undefined) return 'NULL';
    return `'${String(v).replace(/'/g, "''")}'`;
}

/** Escape an identifier for a double-quoted SQL name. */
export function sqlIdent(name: string): string {
    return `"${String(name).replace(/"/g, '""')}"`;
}

/**
 * Coerce DuckDB's JS values into things that survive JSON.stringify and that
 * a chart can plot. Every row leaving this module goes through here.
 *
 * Two traps this exists for, both found the hard way:
 *  - COUNT returns BigInt, and JSON.stringify THROWS on BigInt, so the first
 *    aggregate a user asks for would crash the tool-result serializer.
 *  - SUM over a money column returns DuckDBDecimalValue, whose toString gives
 *    "109.75" (a STRING). The charts skill requires JSON numbers, so every
 *    revenue chart would silently render empty. DuckDBDecimalValue exposes
 *    toDouble(); use it.
 * DATE/TIMESTAMP/INTERVAL wrappers stay strings on purpose, since that is the
 * projection a model should reason about.
 */
export function normalizeValue(v: unknown): unknown {
    if (typeof v === 'bigint') {
        return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)
            ? Number(v)
            : v.toString();
    }
    if (v instanceof Date) return v.toISOString();
    if (Array.isArray(v)) return v.map(normalizeValue);
    if (v && typeof v === 'object') {
        const maybeDecimal = v as { toDouble?: () => number };
        if (typeof maybeDecimal.toDouble === 'function') {
            const n = maybeDecimal.toDouble();
            return Number.isFinite(n) ? n : String(v);
        }
        const proto = Object.getPrototypeOf(v) as unknown;
        if (proto && proto !== Object.prototype) return String(v);
        const out: Record<string, unknown> = {};
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
            out[k] = normalizeValue(val);
        }
        return out;
    }
    return v;
}

export function normalizeRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
    return rows.map((r) => normalizeValue(r) as Record<string, unknown>);
}

/**
 * Encryption key for the workspace store. The Electron main process seeds
 * DHOW_DATA_KEY from safeStorage before IPC handlers run (see
 * apps/main/src/data-mode-key.ts). @x/core has no electron dependency and is
 * imported by headless code paths, so the core-level fallback is a 0600
 * keyfile for tests and CLI use.
 */
function resolveKey(dataDir: string): string {
    const fromEnv = process.env.DHOW_DATA_KEY;
    if (fromEnv) return fromEnv;
    const keyPath = path.join(dataDir, '.key');
    if (fs.existsSync(keyPath)) return fs.readFileSync(keyPath, 'utf8').trim();
    const key = crypto.randomBytes(32).toString('base64');
    fs.writeFileSync(keyPath, key, { mode: 0o600 });
    try {
        fs.chmodSync(keyPath, 0o600);
    } catch {
        // Windows has no mode bits worth setting; the file inherits the user
        // profile ACL, which is the platform's answer.
    }
    return key;
}

/**
 * Load the crypto module DuckDB needs to WRITE an encrypted database.
 *
 * The built-in mbedtls module is READ-ONLY, so an encrypted ATTACH fails with
 * "DuckDB currently has a read-only crypto module loaded" unless httpfs is
 * loaded first. This is nothing to do with networking: the query instance
 * still runs with enable_external_access=false, which is verified to block
 * both http reads and https exfiltration even with httpfs present.
 *
 * Returns false when the extension is unavailable, which happens on a build
 * that did not stage it.
 */
async function loadCryptoModule(conn: DuckDBConnection): Promise<boolean> {
    try {
        await conn.run('LOAD httpfs');
        return true;
    } catch {
        return false;
    }
}

/** Whether running without encryption has been explicitly accepted. */
function unencryptedAllowed(): boolean {
    return process.env.DHOW_DATA_ALLOW_UNENCRYPTED === '1';
}

function encryptionClause(key: string, crypto: boolean, readOnly = false): string {
    const parts: string[] = [];
    if (crypto) parts.push(`ENCRYPTION_KEY ${sqlLiteral(key)}`);
    else if (!unencryptedAllowed()) {
        // Fail closed. This store holds finance data the user dropped in, and
        // silently writing it in the clear is the worse outcome.
        throw new Error(
            'Cannot create an encrypted data store: the DuckDB httpfs extension is not available, ' +
                'and it provides the writable crypto module. Rebuild with the extension staged, or ' +
                'set DHOW_DATA_ALLOW_UNENCRYPTED=1 to accept an unencrypted store.',
        );
    }
    if (readOnly) parts.push('READ_ONLY');
    return parts.length ? `(${parts.join(', ')})` : '';
}

const engines = new Map<string, Promise<DataEngine>>();

export async function getEngine(workspaceId = 'default'): Promise<DataEngine> {
    const existing = engines.get(workspaceId);
    if (existing) return existing;
    const created = (async () => {
        const e = new DataEngine(workspaceId);
        await e.init();
        return e;
    })();
    engines.set(workspaceId, created);
    try {
        return await created;
    } catch (err) {
        engines.delete(workspaceId);
        throw err;
    }
}

export async function closeAllEngines(): Promise<void> {
    const all = [...engines.values()];
    engines.clear();
    for (const p of all) {
        try {
            (await p).closeHandles();
        } catch {
            // Best effort: a failed close must not mask the caller's error.
        }
    }
}

export class DataEngine {
    readonly workspaceId: string;
    readonly dataDir: string;
    readonly dbPath: string;

    readonly #key: string;
    #writer: { instance: DuckDBInstance; conn: DuckDBConnection } | null = null;
    #reader: { instance: DuckDBInstance; conn: DuckDBConnection } | null = null;
    /**
     * Serializes every engine operation. DuckDB connections are not safe for
     * concurrent use, and reader recycling must never interleave with a read.
     */
    #chain: Promise<unknown> = Promise.resolve();

    constructor(workspaceId: string) {
        this.workspaceId = workspaceId;
        this.dataDir = dataDirFor(workspaceId);
        fs.mkdirSync(this.dataDir, { recursive: true });
        this.dbPath = path.join(this.dataDir, 'analytics.duckdb');
        this.#key = resolveKey(this.dataDir);
    }

    async init(): Promise<void> {
        await this.withWrite(async (c) => {
            await c.run(
                `CREATE TABLE IF NOT EXISTS ${PROFILE_TABLE}(table_name VARCHAR PRIMARY KEY, json VARCHAR)`,
            );
        });
    }

    /** Run `fn` with exclusive use of the engine. */
    #serialize<T>(fn: () => Promise<T>): Promise<T> {
        const run = this.#chain.then(fn);
        this.#chain = run.then(
            () => undefined,
            () => undefined,
        );
        return run;
    }

    // ---------------------------------------------------------------- writer

    async #writerConn(): Promise<DuckDBConnection> {
        if (this.#writer) return this.#writer.conn;
        const opts: Record<string, string> = {};
        const extDir = process.env.DHOW_DUCKDB_EXTENSIONS;
        if (extDir) {
            // Bundled, signed extensions only. Autoinstall/autoload default to
            // TRUE, which would silently reach out to extensions.duckdb.org on
            // the first read_xlsx. Offline that is a mystery failure.
            opts.extension_directory = extDir;
            opts.autoinstall_known_extensions = 'false';
            opts.autoload_known_extensions = 'false';
        }
        const instance = await DuckDBInstance.create(':memory:', opts);
        const conn = await instance.connect();
        const crypto = await loadCryptoModule(conn);
        try {
            await conn.run(
                `ATTACH ${sqlLiteral(this.dbPath)} AS ${CATALOG} ${encryptionClause(this.#key, crypto)}`,
            );
            await conn.run(`USE ${CATALOG}`);
        } catch (err) {
            conn.disconnectSync();
            instance.closeSync();
            const msg = errText(err);
            if (/encryption key|without a key/i.test(msg)) {
                throw new Error(
                    `Cannot open the workspace data store at ${this.dbPath}: ${msg}`,
                );
            }
            throw err;
        }
        if (extDir) {
            try {
                await conn.run('LOAD excel');
            } catch {
                // Absent excel extension must never break the CSV path. XLSX
                // goes through SheetJS anyway, because read_xlsx's default
                // header handling is wrong (verified: it yields A1/B1/C1).
            }
        }
        this.#writer = { instance, conn };
        return conn;
    }

    /**
     * Trusted phase. Anything that writes goes through here.
     *
     * Recycling the reader afterwards is a CORRECTNESS requirement, not a
     * cache tweak. Verified: a reader attached before a write raises
     * "Table with name b does not exist" for a table created after it
     * attached, so a freshly imported table would be invisible to the very
     * next question the user asks.
     */
    withWrite<T>(fn: (c: DuckDBConnection) => Promise<T>): Promise<T> {
        return this.#serialize(async () => {
            const c = await this.#writerConn();
            const out = await fn(c);
            // Flush to the file so a freshly attached reader sees everything.
            try {
                await c.run('CHECKPOINT');
            } catch {
                // A checkpoint inside an open transaction can refuse; the
                // reader recycle below still picks up committed state.
            }
            this.#disposeReader();
            return out;
        });
    }

    // ---------------------------------------------------------------- reader

    #disposeReader(): void {
        if (!this.#reader) return;
        try {
            this.#reader.conn.disconnectSync();
            this.#reader.instance.closeSync();
        } catch {
            // Already closed; nothing to salvage.
        }
        this.#reader = null;
    }

    async #readerConn(): Promise<DuckDBConnection> {
        if (this.#reader) return this.#reader.conn;
        const instance = await DuckDBInstance.create(':memory:', {
            autoinstall_known_extensions: 'false',
            autoload_known_extensions: 'false',
            allow_community_extensions: 'false',
            allow_unsigned_extensions: 'false',
            memory_limit: process.env.DHOW_DATA_MEMORY_LIMIT ?? '2GB',
            threads: '4',
        });
        const conn = await instance.connect();
        const crypto = await loadCryptoModule(conn);
        try {
            await conn.run(
                `ATTACH ${sqlLiteral(this.dbPath)} AS ${CATALOG} ` +
                    `${encryptionClause(this.#key, crypto, true)}`,
            );
            await conn.run(`USE ${CATALOG}`);
            // Order matters: the attach above needs filesystem access, so the
            // lockdown comes after it. lock_configuration must be last, since
            // it freezes everything set before it.
            await conn.run('SET enable_external_access=false');
            await conn.run('SET lock_configuration=true');
        } catch (err) {
            conn.disconnectSync();
            instance.closeSync();
            throw err;
        }
        this.#reader = { instance, conn };
        return conn;
    }

    /** Untrusted phase. Every model-authored statement lands here. */
    query(sql: string, opts?: { maxRows?: number }): Promise<QueryResult> {
        const maxRows = opts?.maxRows ?? DEFAULT_MAX_ROWS;
        return this.#serialize(async () => {
            const started = Date.now();
            try {
                const c = await this.#readerConn();
                const gate = await assertSelectOnly(c, sql);
                if (!gate.ok) {
                    return {
                        ok: false as const,
                        sql: String(sql ?? ''),
                        error: gate.reason,
                        stage: 'gate' as const,
                    };
                }
                const reader = await c.runAndReadAll(gate.sql);
                const all = reader.getRowObjects();
                const truncated = all.length > maxRows;
                const rows = normalizeRows(truncated ? all.slice(0, maxRows) : all);
                return {
                    ok: true as const,
                    sql: gate.sql,
                    rows,
                    rowCount: rows.length,
                    truncated,
                    elapsedMs: Date.now() - started,
                };
            } catch (err) {
                return {
                    ok: false as const,
                    sql: String(sql ?? ''),
                    error: errText(err),
                    stage: 'execute' as const,
                };
            }
        });
    }

    // -------------------------------------------------------------- profiles

    /**
     * Persist a profile using a connection the caller already holds.
     *
     * Ingest builds the table and its profile inside ONE withWrite block, and
     * every engine operation is serialized on a single chain, so calling the
     * withWrite-wrapping saveProfile from in there would deadlock against
     * itself. Callers already inside withWrite must use this.
     */
    async saveProfileWithin(c: DuckDBConnection, p: TableProfile): Promise<void> {
        await c.run(`DELETE FROM ${PROFILE_TABLE} WHERE table_name = ?`, [p.table]);
        await c.run(`INSERT INTO ${PROFILE_TABLE} VALUES (?, ?)`, [p.table, JSON.stringify(p)]);
    }

    async saveProfile(p: TableProfile): Promise<void> {
        await this.withWrite((c) => this.saveProfileWithin(c, p));
    }

    async listTables(): Promise<TableProfile[]> {
        return this.#serialize(async () => {
            const c = await this.#writerConn();
            const reader = await c.runAndReadAll(
                `SELECT json FROM ${PROFILE_TABLE} ORDER BY table_name`,
            );
            const out: TableProfile[] = [];
            for (const row of reader.getRowObjects()) {
                try {
                    out.push(JSON.parse(String(row.json)) as TableProfile);
                } catch {
                    // A corrupt profile row must not blind the whole listing.
                }
            }
            return out;
        });
    }

    async getProfile(table: string): Promise<TableProfile | null> {
        const all = await this.listTables();
        return all.find((p) => p.table === table) ?? null;
    }

    async dropTable(table: string): Promise<void> {
        const name = sanitizeTableName(table);
        await this.withWrite(async (c) => {
            await c.run(`DROP TABLE IF EXISTS ${sqlIdent(name)}`);
            await c.run(`DELETE FROM ${PROFILE_TABLE} WHERE table_name = ?`, [name]);
        });
    }

    /**
     * Build a TableProfile from a materialized table. SUMMARIZE gives type,
     * min, max, approx_unique and null_percentage in one pass; those five
     * numbers are the schema-linking signal that actually moves NL-to-SQL
     * accuracy, so they are worth the extra scan at import time.
     *
     * Call this from INSIDE a withWrite callback, passing that connection.
     */
    async profileTable(
        c: DuckDBConnection,
        table: string,
        meta: Omit<TableProfile, 'columns' | 'rowCount' | 'importedAt' | 'table'>,
    ): Promise<TableProfile> {
        const name = sanitizeTableName(table);
        const countReader = await c.runAndReadAll(`SELECT count(*) AS n FROM ${sqlIdent(name)}`);
        const rowCount = Number(normalizeValue(countReader.getRowObjects()[0]?.n) ?? 0);

        const sumReader = await c.runAndReadAll(`SUMMARIZE SELECT * FROM ${sqlIdent(name)}`);
        const columns: ColumnProfile[] = [];
        for (const raw of sumReader.getRowObjects()) {
            const row = normalizeValue(raw) as Record<string, unknown>;
            const colName = String(row.column_name ?? '');
            if (!colName) continue;
            const nullPctRaw = row.null_percentage;
            columns.push({
                name: colName,
                type: String(row.column_type ?? 'VARCHAR'),
                nullPct:
                    nullPctRaw === null || nullPctRaw === undefined ? 0 : Number(nullPctRaw),
                ...(row.min !== null && row.min !== undefined ? { min: String(row.min) } : {}),
                ...(row.max !== null && row.max !== undefined ? { max: String(row.max) } : {}),
                ...(row.approx_unique !== null && row.approx_unique !== undefined
                    ? { approxUnique: Number(row.approx_unique) }
                    : {}),
                sample: await this.#sampleColumn(c, name, colName),
            });
        }

        return { table: name, rowCount, columns, importedAt: new Date().toISOString(), ...meta };
    }

    async #sampleColumn(c: DuckDBConnection, table: string, column: string): Promise<string[]> {
        try {
            const reader = await c.runAndReadAll(
                `SELECT DISTINCT ${sqlIdent(column)} AS v FROM ${sqlIdent(table)} ` +
                    `WHERE ${sqlIdent(column)} IS NOT NULL LIMIT 3`,
            );
            return reader
                .getRowObjects()
                .map((r) => String(normalizeValue(r.v) ?? ''))
                .map((s) => (s.length > 40 ? `${s.slice(0, 39)}\u2026` : s));
        } catch {
            return [];
        }
    }

    // ----------------------------------------------------------------- close

    closeHandles(): void {
        this.#disposeReader();
        if (this.#writer) {
            try {
                this.#writer.conn.disconnectSync();
                this.#writer.instance.closeSync();
            } catch {
                // Already closed.
            }
            this.#writer = null;
        }
    }

    async close(): Promise<void> {
        // Let any queued work finish so we never close under an active handle.
        await this.#chain.catch(() => undefined);
        this.closeHandles();
        engines.delete(this.workspaceId);
    }
}
