// Direct tests for the AST allowlist. The engine tests exercise it through
// query(), but this is the security boundary for model-authored SQL, so it
// gets its own coverage against a bare in-memory connection.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { assertSelectOnly } from './sql-guard.js';

let instance: DuckDBInstance;
let conn: DuckDBConnection;

beforeAll(async () => {
    instance = await DuckDBInstance.create(':memory:');
    conn = await instance.connect();
    await conn.run('CREATE TABLE t AS SELECT 1 AS a');
});

afterAll(() => {
    conn.disconnectSync();
    instance.closeSync();
});

describe('assertSelectOnly', () => {
    it('accepts a plain SELECT', async () => {
        const r = await assertSelectOnly(conn, 'SELECT a FROM t');
        expect(r.ok).toBe(true);
    });

    it('accepts a CTE and a set operation, which are still read-only', async () => {
        expect((await assertSelectOnly(conn, 'WITH x AS (SELECT 1 AS a) SELECT a FROM x')).ok).toBe(true);
        expect((await assertSelectOnly(conn, 'SELECT 1 UNION SELECT 2')).ok).toBe(true);
    });

    it('trims and tolerates a trailing newline', async () => {
        expect((await assertSelectOnly(conn, '  SELECT a FROM t \n')).ok).toBe(true);
    });

    it.each([
        ['DDL', 'DROP TABLE t'],
        ['DML update', 'UPDATE t SET a = 2'],
        ['DML insert', 'INSERT INTO t VALUES (2)'],
        ['DML delete', 'DELETE FROM t'],
        ['CREATE', 'CREATE TABLE z AS SELECT 1'],
        ['ATTACH', "ATTACH '/tmp/x.db' AS x"],
        ['PRAGMA', 'PRAGMA version'],
        ['SET', 'SET enable_external_access=true'],
        ['INSTALL', 'INSTALL httpfs'],
        ['LOAD', 'LOAD spatial'],
        ['COPY out', "COPY t TO '/tmp/x.csv'"],
        ['stacked statements', 'SELECT 1; DROP TABLE t'],
        ['trailing injection', "SELECT 1') ; DROP TABLE t; --"],
        ['garbage', 'not sql at all'],
    ])('rejects %s', async (_label, sql) => {
        const r = await assertSelectOnly(conn, sql);
        expect(r.ok).toBe(false);
    });

    it('accepts a statement whose second half is commented out, and it is inert', async () => {
        // `SELECT 1; -- DROP TABLE t` really IS one statement: the DROP is
        // inside a comment. The serializer accepts it, which is correct, so
        // prove the accepted text is harmless rather than assuming it.
        const sql = 'SELECT 1; -- DROP TABLE t';
        const r = await assertSelectOnly(conn, sql);
        expect(r.ok).toBe(true);
        await conn.run(sql);
        const check = await conn.runAndReadAll('SELECT count(*) AS n FROM t');
        expect(Number(check.getRowObjects()[0]?.n)).toBe(1);
    });

    it('rejects empty and whitespace-only input', async () => {
        expect((await assertSelectOnly(conn, '')).ok).toBe(false);
        expect((await assertSelectOnly(conn, '   ')).ok).toBe(false);
    });

    it('rejects a NUL byte before the engine ever sees it', async () => {
        const r = await assertSelectOnly(conn, 'SELECT 1\u0000 DROP TABLE t');
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('expected rejection');
        expect(r.reason).toMatch(/NUL/);
    });

    it('rejects an oversized payload', async () => {
        const r = await assertSelectOnly(conn, `SELECT '${'x'.repeat(20_001)}'`);
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('expected rejection');
        expect(r.reason).toMatch(/exceeds/);
    });

    it('does not execute what it rejects', async () => {
        await assertSelectOnly(conn, 'DROP TABLE t');
        await assertSelectOnly(conn, "SELECT 1') ; DROP TABLE t; --");
        // The table is still there, so serialization really is parse-only.
        const check = await conn.runAndReadAll('SELECT count(*) AS n FROM t');
        expect(Number(check.getRowObjects()[0]?.n)).toBe(1);
    });
});
