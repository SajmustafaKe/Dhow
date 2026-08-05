import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Mod = typeof import('./fts-index.js');

let mod: Mod;
let workdir: string;
let notesDir: string;
let index: InstanceType<Mod['FtsIndex']>;

function writeNote(name: string, body: string): string {
    const p = path.join(notesDir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
    return p;
}

beforeAll(async () => {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'dhow-fts-'));
    notesDir = path.join(workdir, 'knowledge');
    fs.mkdirSync(notesDir, { recursive: true });
    process.env.DHOW_WORKDIR = workdir;
    mod = await import('./fts-index.js');

    for (let i = 0; i < 30; i++) {
        writeNote(`People/note-${i}.md`, `Contact number ${i}\n\nprocurement quarterly review notes.`);
    }
    writeNote('People/heavy.md', 'supplier supplier supplier supplier supplier margin');
    writeNote('People/light.md', 'supplier margin mentioned once');
    index = new mod.FtsIndex(path.join(workdir, 'idx.sqlite'));
});

afterAll(() => {
    index.close();
    mod.resetSharedIndex();
    fs.rmSync(workdir, { recursive: true, force: true });
});

describe('toMatchExpression', () => {
    it('neutralises FTS5 syntax that users type by accident', () => {
        // Each of these is a syntax error if passed through raw.
        expect(mod.toMatchExpression('say "hello"')).toBe('"say" AND "hello"');
        // Operator words are dropped, not searched for literally.
        expect(mod.toMatchExpression('cats AND dogs')).toBe('"cats" AND "dogs"');
        expect(mod.toMatchExpression('a: b^ c*')).toBe('"a" AND "b" AND "c"');
        expect(mod.toMatchExpression('   ')).toBe('');
    });
});

describe('FtsIndex', () => {
    it('indexes the whole directory on first sync', async () => {
        const stats = await index.syncDir(notesDir);
        expect(stats.added).toBe(32);
        expect(stats.updated).toBe(0);
        expect(index.count()).toBe(32);
    });

    it('is a no-op when nothing changed', async () => {
        const stats = await index.syncDir(notesDir);
        expect(stats.added).toBe(0);
        expect(stats.updated).toBe(0);
        expect(stats.removed).toBe(0);
        expect(stats.scanned).toBe(32);
    });

    it('does not re-index a file whose mtime moved but content did not', async () => {
        const p = path.join(notesDir, 'People/note-0.md');
        const future = new Date(Date.now() + 60_000);
        fs.utimesSync(p, future, future);
        const stats = await index.syncDir(notesDir);
        expect(stats.updated).toBe(0);
        expect(stats.unchanged).toBe(1);
    });

    it('updates only the file that actually changed', async () => {
        writeNote('People/note-1.md', 'Contact number 1\n\nnow mentions zanzibar logistics.');
        const stats = await index.syncDir(notesDir);
        expect(stats.updated).toBe(1);
        expect(stats.added).toBe(0);
    });

    it('finds a term immediately after sync with no full rebuild', async () => {
        // This is the property DuckDB's FTS cannot provide (plan 3.6).
        writeNote('People/fresh.md', 'urgent payroll discrepancy flagged today');
        await index.syncDir(notesDir);
        const hits = index.search('payroll');
        expect(hits.map((h) => path.basename(h.path))).toContain('fresh.md');
    });

    it('removes deleted files from the index', async () => {
        const before = index.count();
        fs.rmSync(path.join(notesDir, 'People/fresh.md'));
        const stats = await index.syncDir(notesDir);
        expect(stats.removed).toBe(1);
        expect(index.count()).toBe(before - 1);
        expect(index.search('payroll')).toHaveLength(0);
    });

    it('ranks a document with many occurrences above one with a single hit', async () => {
        const hits = index.search('supplier');
        expect(hits.length).toBeGreaterThanOrEqual(2);
        const names = hits.map((h) => path.basename(h.path));
        expect(names.indexOf('heavy.md')).toBeLessThan(names.indexOf('light.md'));
    });

    it('returns results rather than throwing for queries containing FTS5 syntax', () => {
        expect(() => index.search('supplier AND margin')).not.toThrow();
        expect(index.search('supplier AND margin').length).toBeGreaterThan(0);
        expect(() => index.search('"unbalanced')).not.toThrow();
        expect(() => index.search('margin*')).not.toThrow();
    });

    it('produces a usable snippet and a sortable score', () => {
        const [top] = index.search('procurement');
        expect(top).toBeDefined();
        expect(top!.snippet.length).toBeGreaterThan(0);
        expect(Number.isFinite(top!.score)).toBe(true);
    });
});
