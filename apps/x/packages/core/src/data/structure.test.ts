import { describe, expect, it } from 'vitest';
import {
    coerceColumnTypes,
    dataRowsOf,
    dedupeColumns,
    inferStructure,
    isTotalsRow,
    looksNumeric,
    type Grid,
} from './structure.js';

const clean: Grid = [
    ['region', 'month', 'revenue'],
    ['EMEA', '2026-01', '1200.50'],
    ['APAC', '2026-01', '880.25'],
];

describe('looksNumeric', () => {
    it('accepts the shapes finance actually exports', () => {
        for (const s of ['1200.50', '1,200.50', '$1,200.50', '(500.00)', '12%', '-3', '0']) {
            expect(looksNumeric(s), s).toBe(true);
        }
    });
    it('rejects text and blanks', () => {
        for (const s of ['', '  ', 'EMEA', 'n/a', '--']) {
            expect(looksNumeric(s), s).toBe(false);
        }
    });
});

describe('isTotalsRow', () => {
    it('spots the row that would double-count the sheet', () => {
        expect(isTotalsRow(['Total', '', '5365.75'])).toBe(true);
        expect(isTotalsRow(['Subtotal', '5365.75'])).toBe(true);
        expect(isTotalsRow(['GRAND TOTAL', '1'])).toBe(true);
    });
    it('leaves real data alone', () => {
        expect(isTotalsRow(['Total Widgets Ltd', 'EMEA', '12'])).toBe(false);
        expect(isTotalsRow(['EMEA', '2026-01', '1200.50'])).toBe(false);
    });
});

describe('inferStructure', () => {
    it('finds a header on row 0', () => {
        const inf = inferStructure(clean);
        expect(inf.headerRow).toBe(0);
        expect(inf.columns).toEqual(['region', 'month', 'revenue']);
        expect(inf.skippedRows).toEqual([]);
        expect(inf.confidence).toBeGreaterThan(0.5);
    });

    it('skips a title block above the header', () => {
        const grid: Grid = [
            ['ACME Trading Ltd', '', ''],
            ['Profit and Loss, Q1 2026', '', ''],
            ['', '', ''],
            ...clean,
        ];
        const inf = inferStructure(grid);
        expect(inf.headerRow).toBe(3);
        expect(inf.columns).toEqual(['region', 'month', 'revenue']);
        expect(inf.skippedRows).toEqual([0, 1, 2]);
        expect(inf.notes.join(' ')).toMatch(/title block/i);
    });

    it('excludes a trailing totals row from the data', () => {
        const grid: Grid = [...clean, ['Total', '', '2080.75']];
        const inf = inferStructure(grid);
        expect(inf.skippedRows).toContain(3);
        expect(inf.notes.join(' ')).toMatch(/totals row/i);
        expect(dataRowsOf(grid, inf)).toHaveLength(2);
    });

    it('drops blank spacer rows and footnotes', () => {
        const grid: Grid = [
            ...clean,
            ['', '', ''],
            ['* figures are unaudited and subject to revision by the auditors', '', ''],
        ];
        const inf = inferStructure(grid);
        expect(dataRowsOf(grid, inf)).toHaveLength(2);
        expect(inf.notes.join(' ')).toMatch(/blank row/i);
        expect(inf.notes.join(' ')).toMatch(/footnote/i);
    });

    it('handles an empty sheet without throwing', () => {
        const inf = inferStructure([]);
        expect(inf.headerRow).toBe(-1);
        expect(inf.confidence).toBe(0);
    });

    it('handles a single data row', () => {
        const inf = inferStructure([clean[0]!, clean[1]!]);
        expect(inf.headerRow).toBe(0);
        expect(dataRowsOf([clean[0]!, clean[1]!], inf)).toHaveLength(1);
    });
});

describe('dedupeColumns', () => {
    it('renames duplicates and names empty headers', () => {
        const { columns, notes } = dedupeColumns(['amount', 'amount', '', 'Amount']);
        expect(columns).toEqual(['amount', 'amount_2', 'column_3', 'Amount_3']);
        expect(notes.length).toBeGreaterThan(0);
    });
});

describe('coerceColumnTypes', () => {
    it('types clean numeric and integer columns', () => {
        const { types } = coerceColumnTypes(
            [
                ['EMEA', '1', '1200.50'],
                ['APAC', '2', '880.25'],
            ],
            ['region', 'qty', 'revenue'],
        );
        expect(types).toEqual(['VARCHAR', 'BIGINT', 'DOUBLE']);
    });

    it('demotes a mixed column to VARCHAR and says so', () => {
        const { types, notes } = coerceColumnTypes(
            [['1200.50'], ['n/a'], ['880.25']],
            ['revenue'],
        );
        expect(types).toEqual(['VARCHAR']);
        expect(notes.join(' ')).toMatch(/mixes numbers and text/i);
    });

    it('flags an entirely empty column', () => {
        const { types, notes } = coerceColumnTypes([[''], ['']], ['notes']);
        expect(types).toEqual(['VARCHAR']);
        expect(notes.join(' ')).toMatch(/entirely empty/i);
    });

    it('detects ISO dates', () => {
        const { types } = coerceColumnTypes([['2026-01-02'], ['2026-02-03']], ['d']);
        expect(types).toEqual(['DATE']);
    });
});
