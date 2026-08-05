import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isSupportedDocument, supportedDocumentExtensions, toMarkdown } from './documents.js';

let dir: string;

beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dhow-docs-'));
});

afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('supportedDocumentExtensions', () => {
    it('covers the gaps parseFile leaves', () => {
        const exts = supportedDocumentExtensions();
        // pptx, odt and html are exactly what parseFile cannot do today.
        expect(exts).toEqual(expect.arrayContaining(['.pptx', '.odt', '.html', '.pdf', '.docx']));
        expect(isSupportedDocument('/a/deck.pptx')).toBe(true);
        expect(isSupportedDocument('/a/thing.zip')).toBe(false);
    });
});

describe('toMarkdown', () => {
    it('converts HTML to markdown', async () => {
        const p = path.join(dir, 'page.html');
        fs.writeFileSync(
            p,
            '<h1>Q1 Results</h1><p>Revenue was <strong>up 12%</strong>.</p><ul><li>EMEA</li><li>APAC</li></ul>',
        );
        const doc = await toMarkdown(p);
        expect(doc.format).toBe('html');
        expect(doc.markdown).toContain('# Q1 Results');
        expect(doc.markdown).toContain('**up 12%**');
        expect(doc.markdown).toMatch(/[-*]\s+EMEA/);
    });

    it('passes plain text through', async () => {
        const p = path.join(dir, 'note.md');
        fs.writeFileSync(p, '# hello\n\nworld');
        const doc = await toMarkdown(p);
        expect(doc.markdown).toBe('# hello\n\nworld');
    });

    it('returns a clean message for an unsupported format rather than throwing', async () => {
        const p = path.join(dir, 'thing.zip');
        fs.writeFileSync(p, 'not really a zip');
        const doc = await toMarkdown(p);
        expect(doc.markdown).toBe('');
        expect(doc.notes.join(' ')).toMatch(/Unsupported document format/i);
    });

    it('reports a missing file rather than throwing', async () => {
        const doc = await toMarkdown(path.join(dir, 'nope.html'));
        expect(doc.notes.join(' ')).toMatch(/No such file/i);
    });
});

describe('parseFile tabular caps', () => {
    it('caps rows and reports the TRUE total so the model is not misled', async () => {
        const { capRows, MAX_TOOL_ROWS } = await import('../runtime/tools/domains/parsing-caps.js');
        const rows = Array.from({ length: 500 }, (_, i) => ({ i }));
        const capped = capRows(rows);
        expect(capped.rows).toHaveLength(MAX_TOOL_ROWS);
        expect(capped.truncated).toBe(true);
        expect(capped.totalRows).toBe(500);
    });

    it('leaves a small result completely untouched', async () => {
        const { capRows, capLines } = await import('../runtime/tools/domains/parsing-caps.js');
        const capped = capRows([{ a: 1 }, { a: 2 }]);
        expect(capped.truncated).toBe(false);
        expect(capped.rows).toHaveLength(2);
        expect(capLines('a\nb\nc').truncated).toBe(false);
    });

    it('caps raw text and says how much it dropped', async () => {
        const { capLines, MAX_TOOL_LINES } = await import('../runtime/tools/domains/parsing-caps.js');
        const text = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
        const capped = capLines(text);
        expect(capped.truncated).toBe(true);
        expect(capped.text.split('\n')).toHaveLength(MAX_TOOL_LINES + 1);
        expect(capped.text).toMatch(/300 more line\(s\) omitted/);
    });

    it('points the model at the query path instead of the read path', async () => {
        const { TABULAR_HINT } = await import('../runtime/tools/domains/parsing-caps.js');
        expect(TABULAR_HINT).toMatch(/data-analysis/);
        expect(TABULAR_HINT).toMatch(/SQL/);
    });
});

describe('parseFile end to end', () => {
    // parsing.ts is importable on its own now that its model-provider imports
    // are lazy. Before that it hit "Cannot access 'parsingTools' before
    // initialization" via models/defaults -> di/container -> catalog -> parsing.
    it('caps a huge CSV instead of pushing every row into context', async () => {
        const p = path.join(dir, 'big.csv');
        const rows = ['region,month,revenue'];
        for (let i = 0; i < 500; i++) rows.push(`EMEA,2026-01,${i}.50`);
        fs.writeFileSync(p, rows.join('\n'));

        const { parsingTools } = await import('../runtime/tools/domains/parsing.js');
        const result = (await parsingTools['parseFile']!.execute({ path: p })) as {
            success: boolean;
            data?: unknown[];
            content?: string;
            truncated?: boolean;
            totalRows?: number;
            hint?: string;
            metadata?: { rowCount?: number };
        };

        expect(result.success).toBe(true);
        expect(result.data).toHaveLength(50);
        expect(result.truncated).toBe(true);
        expect(result.totalRows).toBe(500);
        // rowCount still reports the TRUE size so the model is not misled.
        expect(result.metadata?.rowCount).toBe(500);
        expect(result.content!.split('\n').length).toBeLessThanOrEqual(201);
        expect(result.hint).toMatch(/data-analysis/);
    });

    it('leaves a small CSV completely untouched', async () => {
        const p = path.join(dir, 'small.csv');
        fs.writeFileSync(p, 'a,b\n1,2\n3,4');
        const { parsingTools } = await import('../runtime/tools/domains/parsing.js');
        const result = (await parsingTools['parseFile']!.execute({ path: p })) as {
            success: boolean;
            data?: unknown[];
            truncated?: boolean;
            hint?: string;
        };
        expect(result.success).toBe(true);
        expect(result.data).toHaveLength(2);
        expect(result.truncated).toBeUndefined();
        expect(result.hint).toBeUndefined();
    });
});
