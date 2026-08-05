import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type AskModule = typeof import('./ask.js');
type EngineModule = typeof import('./engine.js');

let askMod: AskModule;
let engineMod: EngineModule;
let workdir: string;

beforeAll(async () => {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'dhow-ask-'));
    process.env.DHOW_WORKDIR = workdir;
    process.env.DHOW_DATA_KEY = 'test-key-ask';
    askMod = await import('./ask.js');
    engineMod = await import('./engine.js');

    const engine = await engineMod.getEngine('askws');
    await engine.withWrite(async (c) => {
        await c.run(
            `CREATE TABLE sales AS SELECT * FROM (VALUES
                ('EMEA', 'Widget', 100.0),
                ('EMEA', 'Gadget', 50.0),
                ('APAC', 'Widget', 200.0)
             ) t(region, product, amount)`,
        );
        const profile = await engine.profileTable(c, 'sales', {
            sourcePath: '/tmp/sales.csv',
            sourceKind: 'csv',
            notes: [],
        });
        await engine.saveProfileWithin(c, profile);
    });
});

afterAll(async () => {
    await engineMod.closeAllEngines();
    fs.rmSync(workdir, { recursive: true, force: true });
    delete process.env.DHOW_DATA_KEY;
});

describe('extractSql', () => {
    it('unwraps a fenced response', () => {
        expect(askMod.extractSql('```sql\nSELECT 1\n```')).toBe('SELECT 1');
        expect(askMod.extractSql('```\nSELECT 2\n```')).toBe('SELECT 2');
    });
    it('strips a label and a trailing semicolon', () => {
        expect(askMod.extractSql('SQL: SELECT 3;')).toBe('SELECT 3');
    });
    it('leaves bare SQL alone', () => {
        expect(askMod.extractSql('SELECT 4')).toBe('SELECT 4');
    });
});

describe('buildSchemaPrompt', () => {
    it('carries the schema-linking signal the model needs', async () => {
        const engine = await engineMod.getEngine('askws');
        const prompt = askMod.buildSchemaPrompt(await engine.listTables());
        expect(prompt).toContain('TABLE sales');
        expect(prompt).toContain('region');
        expect(prompt).toContain('amount');
        // Sample values are what stop the model inventing categories.
        expect(prompt).toMatch(/e\.g\./);
    });

    it('says so plainly when nothing is imported', () => {
        expect(askMod.buildSchemaPrompt([])).toMatch(/No tables have been imported/i);
    });
});

describe('ask', () => {
    it('answers and records provenance', async () => {
        const result = await askMod.ask('total revenue by region', {
            workspaceId: 'askws',
            generate: async () =>
                'SELECT region, sum(amount) AS total FROM sales GROUP BY 1 ORDER BY total DESC',
        });
        expect(result.ok).toBe(true);
        expect(result.attempts).toBe(1);
        expect(result.rows).toEqual([
            { region: 'EMEA', total: 150 },
            { region: 'APAC', total: 200 },
        ].sort((a, b) => b.total - a.total));
        expect(result.provenance.tables).toEqual(['sales']);
        expect(result.provenance.columns).toEqual(expect.arrayContaining(['region', 'amount']));
        expect(result.provenance.rowsScanned).toBe(3);
        expect(askMod.describeProvenance(result)).toContain('SQL:');
    });

    it('repairs a bad column name from the exact engine error', async () => {
        // This is the loop that takes accuracy from ~60% to ~95%.
        let call = 0;
        const seenPrompts: string[] = [];
        const result = await askMod.ask('total revenue by region', {
            workspaceId: 'askws',
            generate: async (prompt) => {
                seenPrompts.push(prompt);
                call++;
                return call === 1
                    ? 'SELECT regionn, sum(amount) AS total FROM sales GROUP BY 1'
                    : 'SELECT region, sum(amount) AS total FROM sales GROUP BY 1';
            },
        });
        expect(result.ok).toBe(true);
        expect(result.attempts).toBe(2);
        // The retry prompt must carry the engine's own words back to the model.
        expect(seenPrompts[1]).toMatch(/previous attempt/i);
        expect(seenPrompts[1]).toMatch(/regionn/);
    });

    it('never lets a destructive statement through, however many times it is tried', async () => {
        const result = await askMod.ask('delete everything', {
            workspaceId: 'askws',
            maxAttempts: 3,
            generate: async () => 'DROP TABLE sales',
        });
        expect(result.ok).toBe(false);
        expect(result.attempts).toBe(3);
        expect(result.errors.join(' ')).toMatch(/SELECT/i);

        // And the table is still there.
        const engine = await engineMod.getEngine('askws');
        const check = await engine.query('SELECT count(*) AS n FROM sales');
        expect(check.ok).toBe(true);
        if (!check.ok) throw new Error(check.error);
        expect(check.rows[0]?.n).toBe(3);
    });

    it('flags an empty result as suspicious instead of presenting it as an answer', async () => {
        const result = await askMod.ask('revenue in Antarctica', {
            workspaceId: 'askws',
            generate: async () => "SELECT region FROM sales WHERE region = 'ANTARCTICA'",
        });
        expect(result.ok).toBe(true);
        expect(result.rowCount).toBe(0);
        expect(result.errors.join(' ')).toMatch(/no rows/i);
    });

    it('reports cleanly when nothing has been imported', async () => {
        const result = await askMod.ask('anything', {
            workspaceId: 'emptyws',
            generate: async () => 'SELECT 1',
        });
        expect(result.ok).toBe(false);
        expect(result.errors.join(' ')).toMatch(/no imported tables/i);
    });

    it('survives a model that throws', async () => {
        const result = await askMod.ask('total revenue', {
            workspaceId: 'askws',
            maxAttempts: 2,
            generate: async () => {
                throw new Error('provider offline');
            },
        });
        expect(result.ok).toBe(false);
        expect(result.errors.join(' ')).toMatch(/provider offline/);
    });
});
