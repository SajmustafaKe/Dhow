import { describe, expect, it } from 'vitest';
import { hasConfusables, normalizeConfusables } from './confusables.js';
import { extractTableBlock, gridFromBoxes, type OcrLine } from './table-from-boxes.js';

describe('normalizeConfusables', () => {
    it('fixes the exact bug Apple Vision produced', () => {
        // Vision returned U+0421 CYRILLIC CAPITAL LETTER ES for the C in ACME.
        const fromVision = 'A\u0421ME TRADING LTD';
        expect(hasConfusables(fromVision)).toBe(true);
        expect(normalizeConfusables(fromVision)).toBe('ACME TRADING LTD');
        // And the repaired string is pure ASCII again, so it will match.
        // eslint-disable-next-line no-control-regex
        expect(/^[\x00-\x7F]*$/.test(normalizeConfusables(fromVision))).toBe(true);
    });

    it('leaves genuinely Cyrillic text completely alone', () => {
        for (const s of ['Москва', 'Санкт-Петербург', 'Привет мир']) {
            expect(normalizeConfusables(s), s).toBe(s);
        }
    });

    it('leaves genuinely Greek text alone', () => {
        expect(normalizeConfusables('Αθήνα')).toBe('Αθήνα');
    });

    it('is a no-op on clean Latin text', () => {
        expect(normalizeConfusables('ACME TRADING LTD')).toBe('ACME TRADING LTD');
        expect(hasConfusables('ACME TRADING LTD')).toBe(false);
    });

    it('handles empty and non-string input safely', () => {
        expect(normalizeConfusables('')).toBe('');
        expect(hasConfusables('')).toBe(false);
    });
});

// The 26 lines Apple Vision actually returned for the synthetic invoice,
// reduced to the fields the reconstruction uses.
function line(text: string, x: number, y: number, w = 0.1, h = 0.04): OcrLine {
    return { text, confidence: 1, x, y, w, h };
}

const INVOICE_LINES: OcrLine[] = [
    line('ACME TRADING LTD', 0.045, 0.863, 0.265, 0.05),
    line('-', 0.336, 0.869, 0.029, 0.034),
    line('INVOICE 2026-0417', 0.387, 0.865, 0.288, 0.048),
    line('Bill to: Kilimanjaro Foods Ltd', 0.044, 0.763, 0.352, 0.041),
    line('Item', 0.045, 0.648, 0.044, 0.032),
    line('Qty', 0.219, 0.642, 0.035, 0.04),
    line('Unit', 0.307, 0.648, 0.047, 0.037),
    line('Amount', 0.417, 0.648, 0.067, 0.035),
    line('Maize flour 50kg', 0.044, 0.57, 0.176, 0.041),
    line('120', 0.251, 0.57, 0.036, 0.044),
    line('18.40', 0.33, 0.57, 0.057, 0.044),
    line('2,208.00', 0.429, 0.563, 0.09, 0.052),
    line('Cooking oil 20L', 0.044, 0.501, 0.166, 0.044),
    line('45', 0.263, 0.508, 0.025, 0.04),
    line('32.75', 0.328, 0.501, 0.058, 0.047),
    line('1,473.75', 0.429, 0.498, 0.09, 0.047),
    line('Sugar 25kg', 0.044, 0.435, 0.111, 0.042),
    line('80', 0.263, 0.439, 0.025, 0.04),
    line('21.05', 0.328, 0.436, 0.058, 0.044),
    line('1,684.00', 0.429, 0.43, 0.089, 0.044),
    line('Subtotal', 0.044, 0.336, 0.089, 0.035),
    line('5,365.75', 0.417, 0.324, 0.09, 0.05),
    line('VAT 16%', 0.044, 0.271, 0.081, 0.035),
    line('858.52', 0.439, 0.265, 0.068, 0.044),
    line('TOTAL DUE', 0.044, 0.19, 0.113, 0.041),
    line('6,224.27', 0.464, 0.178, 0.102, 0.053),
];

describe('gridFromBoxes', () => {
    it('reconstructs the invoice grid from bounding boxes alone', () => {
        const grid = gridFromBoxes(INVOICE_LINES);
        expect(grid[0]).toEqual(['ACME TRADING LTD', '-', 'INVOICE 2026-0417']);
        expect(grid[1]).toEqual(['Bill to: Kilimanjaro Foods Ltd']);
        expect(grid[2]).toEqual(['Item', 'Qty', 'Unit', 'Amount']);
        expect(grid[3]).toEqual(['Maize flour 50kg', '120', '18.40', '2,208.00']);
        expect(grid[4]).toEqual(['Cooking oil 20L', '45', '32.75', '1,473.75']);
        expect(grid[5]).toEqual(['Sugar 25kg', '80', '21.05', '1,684.00']);
        expect(grid[6]).toEqual(['Subtotal', '5,365.75']);
        expect(grid[7]).toEqual(['VAT 16%', '858.52']);
        expect(grid[8]).toEqual(['TOTAL DUE', '6,224.27']);
    });

    it('normalizes homoglyphs on the way through', () => {
        const grid = gridFromBoxes([line('A\u0421ME LTD', 0.05, 0.9)]);
        expect(grid[0]?.[0]).toBe('ACME LTD');
    });

    it('returns nothing for no input', () => {
        expect(gridFromBoxes([])).toEqual([]);
    });
});

describe('extractTableBlock', () => {
    it('separates the 4-column table from the title and the totals block', () => {
        const { table, before, after, width } = extractTableBlock(gridFromBoxes(INVOICE_LINES));
        expect(width).toBe(4);
        // Header plus three line items, and crucially NOT the totals rows: a
        // "TOTAL DUE" row imported as data double-counts the whole invoice.
        expect(table).toHaveLength(4);
        expect(table[0]).toEqual(['Item', 'Qty', 'Unit', 'Amount']);
        expect(table.at(-1)).toEqual(['Sugar 25kg', '80', '21.05', '1,684.00']);
        expect(before.length).toBeGreaterThan(0);
        expect(after.map((r) => r[0])).toEqual(['Subtotal', 'VAT 16%', 'TOTAL DUE']);
    });

    it('handles a grid with no table shape', () => {
        const r = extractTableBlock([['just one line']]);
        expect(r.table).toEqual([]);
    });
});
