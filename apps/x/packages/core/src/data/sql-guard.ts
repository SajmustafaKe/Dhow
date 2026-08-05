// The AST allowlist for model-authored SQL.
//
// This is layer one of four (see DATA_MODE_PLAN.md 3.2). It matters because the
// READ_ONLY instance blocks writes but NOT everything: a locked-config
// connection still happily executes DROP unless something stops it earlier.
// Verified on DuckDB 1.5.5:
//
//   json_serialize_sql('SELECT 1')                   -> {"statements":[{"node":{"type":"SELECT_NODE"...
//   json_serialize_sql('SELECT 1; DROP TABLE t')     -> {"error":true,"error_type":"not implemented"}
//   json_serialize_sql('DROP TABLE t')               -> {"error":true,"error_type":"not implemented"}
//   json_serialize_sql('PRAGMA version')             -> {"error":true,"error_type":"not implemented"}
//
// So the serializer IS the allowlist: only a single SELECT round-trips. That
// also kills stacked-statement injection for free, using the engine's own
// parser rather than a JS reimplementation that could disagree with it.

import type { DuckDBConnection } from '@duckdb/node-api';

export type GateResult = { ok: true; sql: string } | { ok: false; reason: string };

/** Beyond this the payload is not a question, it is an attack or a bug. */
const MAX_SQL_LENGTH = 20_000;

export async function assertSelectOnly(
    c: DuckDBConnection,
    sql: string,
): Promise<GateResult> {
    const trimmed = typeof sql === 'string' ? sql.trim() : '';
    if (!trimmed) return { ok: false, reason: 'Empty SQL.' };
    if (trimmed.length > MAX_SQL_LENGTH) {
        return { ok: false, reason: `SQL exceeds ${MAX_SQL_LENGTH} characters.` };
    }
    if (trimmed.includes('\u0000')) {
        return { ok: false, reason: 'SQL contains a NUL byte.' };
    }

    let serialized: string;
    try {
        // json_serialize_sql refuses a bound parameter ("first argument must
        // be a VARCHAR"), so the candidate has to go in as a quoted literal.
        // That is safe: doubling single quotes makes it a string, and the
        // function only PARSES it, never executes it. Verified that a
        // quote-escape attempt like `SELECT 1') ; DROP TABLE t; --` comes back
        // as {"error":true,"error_type":"parser"} rather than running.
        const literal = `'${trimmed.replace(/'/g, "''")}'`;
        const reader = await c.runAndReadAll(`SELECT json_serialize_sql(${literal}) AS j`);
        serialized = String(reader.getRowObjects()[0]?.j ?? '');
    } catch (err) {
        // A serializer throw means the statement did not parse at all.
        return { ok: false, reason: `Rejected: ${errText(err)}` };
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(serialized);
    } catch {
        return { ok: false, reason: 'Rejected: statement could not be serialized.' };
    }

    if (!parsed || typeof parsed !== 'object') {
        return { ok: false, reason: 'Rejected: unexpected serializer output.' };
    }
    const obj = parsed as Record<string, unknown>;
    if (obj.error === true) {
        // DuckDB reports "not implemented" for everything that is not a plain
        // SELECT, which is exactly the signal we want.
        return { ok: false, reason: 'Only a single read-only SELECT statement is allowed.' };
    }

    const statements = obj.statements;
    if (!Array.isArray(statements) || statements.length !== 1) {
        return { ok: false, reason: 'Exactly one SELECT statement is allowed.' };
    }

    const node = (statements[0] as Record<string, unknown> | undefined)?.node as
        | Record<string, unknown>
        | undefined;
    const type = typeof node?.type === 'string' ? node.type : undefined;
    if (type !== 'SELECT_NODE' && type !== 'SET_OPERATION_NODE') {
        // SET_OPERATION_NODE covers UNION / EXCEPT / INTERSECT of SELECTs,
        // which are still read-only and are legitimate analytical answers.
        return { ok: false, reason: `Only SELECT is allowed (parsed as ${type ?? 'unknown'}).` };
    }

    return { ok: true, sql: trimmed };
}

export function errText(err: unknown): string {
    if (err instanceof Error) return err.message.split('\n')[0] ?? err.message;
    return String(err);
}
