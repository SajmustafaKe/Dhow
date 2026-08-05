import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { WorkDir } from '../config/config.js';
import { getKnowledgeIndex } from '../knowledge/knowledge_index.js';
import { writeTableNote, removeTableNote } from './graph-bridge.js';
import type { TableProfile } from './types.js';

const FIXTURE: TableProfile = {
    table: 'q1_sales',
    sourcePath: '/tmp/finance/q1_sales.csv',
    sourceKind: 'csv',
    rowCount: 124,
    importedAt: '2026-01-02T03:04:05Z',
    notes: ['header detected on row 1', '1 totals row excluded'],
    columns: [
        { name: 'region', type: 'VARCHAR', nullPct: 0, sample: ['North America', 'EMEA'] },
        { name: 'amount', type: 'DECIMAL', nullPct: 2, sample: ['1234.56', '789.00'] },
    ],
};

describe('graph-bridge', () => {
    const noteDir = path.join(WorkDir, 'knowledge', 'Data');

    beforeAll(() => {
        fs.rmSync(noteDir, { recursive: true, force: true });
    });

    afterAll(() => {
        fs.rmSync(noteDir, { recursive: true, force: true });
    });

    it('writes a markdown note for a table', () => {
        const notePath = writeTableNote(FIXTURE);
        expect(fs.existsSync(notePath)).toBe(true);
        const content = fs.readFileSync(notePath, 'utf8');
        expect(content).toContain('type: data-table');
        expect(content).toContain('source: q1_sales.csv');
        expect(content).toContain('table: q1_sales');
        expect(content).toContain('rows: 124');
        expect(content).toContain('| region | VARCHAR | 0% |');
        expect(content).toContain('# q1_sales');
    });

    it('invalidates the knowledge index so the note is discoverable', () => {
        // Force a fresh index read.
        const idx = getKnowledgeIndex();
        const found = idx.other.find((o) => o.name === 'q1_sales');
        expect(found).toBeTruthy();
        expect(found?.file).toContain(path.join('Data', 'q1_sales.md'));
    });

    it('removes the note and drops it from the index', () => {
        removeTableNote('q1_sales');
        expect(fs.existsSync(path.join(noteDir, 'q1_sales.md'))).toBe(false);
        const idx = getKnowledgeIndex();
        expect(idx.other.some((o) => o.name === 'q1_sales')).toBe(false);
    });
});
