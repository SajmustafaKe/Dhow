import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type IngestModule = typeof import('./ingest.js');
type EngineModule = typeof import('./engine.js');

let ingest: IngestModule;
let engineMod: EngineModule;
let workdir: string;
let fixtures: string;

beforeAll(async () => {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'dhow-ingest-'));
    fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'dhow-fixtures-'));
    process.env.DHOW_WORKDIR = workdir;
    process.env.DHOW_DATA_KEY = 'test-key-ingest';
    ingest = await import('./ingest.js');
    engineMod = await import('./engine.js');
});

afterAll(async () => {
    await engineMod.closeAllEngines();
    fs.rmSync(workdir, { recursive: true, force: true });
    fs.rmSync(fixtures, { recursive: true, force: true });
    delete process.env.DHOW_DATA_KEY;
});

describe('ingestCsv', () => {
    it('takes the fast native path on a clean file', async () => {
        const p = path.join(fixtures, 'clean.csv');
        fs.writeFileSync(
            p,
            'region,month,revenue\nEMEA,2026-01,1200.50\nAPAC,2026-01,880.25\nEMEA,2026-02,1310.00\n',
        );
        const profile = await ingest.ingestCsv(p, { workspaceId: 'ing1' });
        expect(profile.rowCount).toBe(3);
        expect(profile.columns.map((c) => c.name)).toEqual(['region', 'month', 'revenue']);
        expect(profile.notes.join(' ')).toMatch(/native CSV type inference/i);

        const engine = await engineMod.getEngine('ing1');
        const r = await engine.query(
            `SELECT region, sum(revenue) AS total FROM ${profile.table} GROUP BY 1 ORDER BY total DESC`,
        );
        expect(r.ok).toBe(true);
        if (!r.ok) throw new Error(r.error);
        expect(r.rows[0]).toEqual({ region: 'EMEA', total: 2510.5 });
    });

    it('repairs an ugly export: title block, blanks, and a totals row', async () => {
        const p = path.join(fixtures, 'ugly.csv');
        fs.writeFileSync(
            p,
            [
                'ACME Trading Ltd,,',
                'Profit and Loss Q1 2026,,',
                ',,',
                'region,month,revenue',
                'EMEA,2026-01,1200.50',
                'APAC,2026-01,880.25',
                ',,',
                'Total,,2080.75',
                '* unaudited figures pending review by the external auditors,,',
            ].join('\n'),
        );
        const profile = await ingest.ingestCsv(p, { workspaceId: 'ing2' });

        // The totals row must NOT be counted as data or every figure doubles.
        expect(profile.rowCount).toBe(2);
        expect(profile.columns.map((c) => c.name)).toEqual(['region', 'month', 'revenue']);
        const notes = profile.notes.join(' ');
        expect(notes).toMatch(/Header detected on row 4/i);
        expect(notes).toMatch(/totals row\(s\) excluded/i);
        expect(notes).toMatch(/structure repair/i);

        const engine = await engineMod.getEngine('ing2');
        const r = await engine.query(`SELECT sum(revenue) AS total FROM ${profile.table}`);
        expect(r.ok).toBe(true);
        if (!r.ok) throw new Error(r.error);
        // 2080.75, not 4161.50.
        expect(r.rows[0]?.total).toBeCloseTo(2080.75, 2);
    });

    it('survives a filename that would break an identifier', async () => {
        const p = path.join(fixtures, 'Q1 P&L (final).csv');
        fs.writeFileSync(p, 'a,b\n1,2\n');
        const profile = await ingest.ingestCsv(p, { workspaceId: 'ing3' });
        expect(profile.table).toMatch(/^[a-z_][a-z0-9_]*$/);
        expect(profile.rowCount).toBe(1);
    });
});

describe('ingestXlsx', () => {
    it('imports one table per sheet and skips cover pages', async () => {
        const XLSX = await import('xlsx');
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(
            wb,
            XLSX.utils.aoa_to_sheet([['Quarterly Pack'], ['prepared by finance']]),
            'Cover',
        );
        XLSX.utils.book_append_sheet(
            wb,
            XLSX.utils.aoa_to_sheet([
                ['region', 'month', 'revenue'],
                ['EMEA', '2026-01', 1200.5],
                ['APAC', '2026-01', 880.25],
                ['Total', '', 2080.75],
            ]),
            'P&L',
        );
        const p = path.join(fixtures, 'book.xlsx');
        XLSX.writeFile(wb, p);

        const profiles = await ingest.ingestXlsx(p, { workspaceId: 'ing4' });
        expect(profiles).toHaveLength(2);

        const cover = profiles.find((x) => x.sheet === 'Cover')!;
        expect(ingest.wasSkipped(cover)).toBe(true);
        expect(cover.notes.join(' ')).toMatch(/cover page/i);

        const pnl = profiles.find((x) => x.sheet === 'P&L')!;
        expect(ingest.wasSkipped(pnl)).toBe(false);
        expect(pnl.rowCount).toBe(2);
        expect(pnl.table).toContain('p_l');

        const engine = await engineMod.getEngine('ing4');
        const r = await engine.query(`SELECT sum(revenue) AS total FROM ${pnl.table}`);
        expect(r.ok).toBe(true);
        if (!r.ok) throw new Error(r.error);
        expect(Number(r.rows[0]?.total)).toBeCloseTo(2080.75, 2);
    });
});

describe('ingestFile routing', () => {
    it('recognises tabular extensions and ignores the rest', () => {
        expect(ingest.isTabularFile('/a/b.csv')).toBe(true);
        expect(ingest.isTabularFile('/a/b.XLSX')).toBe(true);
        expect(ingest.isTabularFile('/a/b.pdf')).toBe(false);
    });

    it('returns nothing for a non-tabular file', async () => {
        const p = path.join(fixtures, 'note.txt');
        fs.writeFileSync(p, 'hello');
        expect(await ingest.ingestFile(p, { workspaceId: 'ing5' })).toEqual([]);
    });
});
