import { describe, expect, it } from 'vitest';
import {
    auditLineItems,
    auditStatedTotals,
    describeAudit,
    parseMoney,
    sumColumn,
} from './audit.js';

// The verified invoice from DATA_MODE_PLAN.md 3.5.
const INVOICE = [
    { item: 'Maize flour 50kg', qty: '120', unit: '18.40', amount: '2,208.00' },
    { item: 'Cooking oil 20L', qty: '45', unit: '32.75', amount: '1,473.75' },
    { item: 'Sugar 25kg', qty: '80', unit: '21.05', amount: '1,684.00' },
];

describe('parseMoney', () => {
    it('parses the shapes finance and OCR actually produce', () => {
        expect(parseMoney('2,208.00')).toBe(2208);
        expect(parseMoney('$1,473.75')).toBe(1473.75);
        expect(parseMoney('(500.00)')).toBe(-500);
        expect(parseMoney('-500.00')).toBe(-500);
        expect(parseMoney('1 234,56')).toBeCloseTo(1234.56, 2);
        expect(parseMoney('1.234,56')).toBeCloseTo(1234.56, 2);
        expect(parseMoney('12%')).toBe(12);
        expect(parseMoney(1684)).toBe(1684);
        expect(parseMoney('1,234')).toBe(1234);
    });

    it('returns null rather than zero for placeholders', () => {
        // A blank silently becoming 0 is how a total goes quietly wrong.
        for (const v of ['', '   ', '--', 'n/a', 'N/A', 'nil', null, undefined]) {
            expect(parseMoney(v), String(v)).toBeNull();
        }
    });

    it('rejects text', () => {
        expect(parseMoney('Maize flour')).toBeNull();
        expect(parseMoney('12abc')).toBeNull();
    });
});

describe('auditLineItems', () => {
    it('reconciles the verified invoice', () => {
        const report = auditLineItems(INVOICE);
        expect(report.checked).toBe(3);
        expect(report.failed).toBe(0);
        expect(report.reconciles).toBe(true);
        expect(report.findings.map((f) => f.expected)).toEqual([2208, 1473.75, 1684]);
        expect(describeAudit(report)).toMatch(/3 arithmetic check\(s\) reconcile/);
    });

    it('catches a corrupted line and reports the exact gap', () => {
        const corrupted = [
            ...INVOICE.slice(0, 2),
            // OCR misread 21.05 as 24.05: the amount no longer follows.
            { item: 'Sugar 25kg', qty: '80', unit: '24.05', amount: '1,684.00' },
        ];
        const report = auditLineItems(corrupted);
        expect(report.reconciles).toBe(false);
        expect(report.failed).toBe(1);
        const bad = report.findings.find((f) => !f.ok)!;
        expect(bad.label).toBe('Sugar 25kg');
        expect(bad.expected).toBe(1924);
        expect(bad.actual).toBe(1684);
        expect(bad.delta).toBe(-240);
        expect(describeAudit(report)).toMatch(/DO NOT reconcile/);
    });

    it('stays silent when the columns are not an invoice', () => {
        const report = auditLineItems([{ region: 'EMEA', revenue: '100' }]);
        expect(report.checked).toBe(0);
        expect(report.reconciles).toBe(true);
    });

    it('honours explicit column hints', () => {
        const rows = [{ thing: 'x', n: '2', each: '3.00', line: '6.00' }];
        const report = auditLineItems(rows, { qty: 'n', unit: 'each', amount: 'line' });
        expect(report.checked).toBe(1);
        expect(report.reconciles).toBe(true);
    });
});

describe('sumColumn and auditStatedTotals', () => {
    it('derives the printed subtotal to the cent', () => {
        expect(sumColumn(INVOICE, 'amount')).toBe(5365.75);
    });

    it('confirms a stated subtotal that matches', () => {
        const report = auditStatedTotals(INVOICE, { Subtotal: 5365.75 }, 'amount');
        expect(report.reconciles).toBe(true);
        expect(report.findings[0]?.expected).toBe(5365.75);
    });

    it('flags a stated subtotal that does not match', () => {
        const report = auditStatedTotals(INVOICE, { Subtotal: 5999.99 }, 'amount');
        expect(report.reconciles).toBe(false);
        expect(report.findings[0]?.delta).toBeCloseTo(634.24, 2);
    });
});
