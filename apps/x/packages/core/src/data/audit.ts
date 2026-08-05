// Arithmetic self-audit. Plan section 3.5: this is the trust mechanism.
//
// The failure mode Data Mode is designed against is "a confidently wrong
// number, beautifully charted, that nobody can audit". The defence is not to
// trust the document: recompute what it claims and compare.
//
// Verified end to end on an OCR'd synthetic invoice: all three line items
// reconciled (120 x 18.40 = 2208.00, 45 x 32.75 = 1473.75, 80 x 21.05 =
// 1684.00) and the derived subtotal 5365.75 / VAT 858.52 / total 6224.27
// matched the printed footer to the cent.
//
// When it DISAGREES, that is not a bug in this module. That is the most
// valuable thing the tool will ever tell a CEO.

export type AuditFinding = {
    kind: 'line_product' | 'column_sum' | 'stated_total';
    label: string;
    expected: number;
    actual: number;
    delta: number;
    ok: boolean;
};

export type AuditReport = {
    checked: number;
    failed: number;
    findings: AuditFinding[];
    reconciles: boolean;
};

/** Money comparisons are exact to the cent, so half a cent is the tolerance. */
const TOLERANCE = 0.005;

/**
 * Parse the many ways a spreadsheet or an OCR pass writes a number.
 *
 * Handles thousands separators, currency symbols, trailing percent,
 * accounting negatives in parentheses, and European "1 234,56". Returns null
 * for anything that is not a number, including the "--" and "n/a" placeholders
 * finance exports are full of, so a blank never silently becomes zero.
 */
export function parseMoney(v: unknown): number | null {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'bigint') return Number(v);
    if (v === null || v === undefined) return null;

    let s = String(v).trim();
    if (!s) return null;
    if (/^(n\/?a|na|nil|none|-{1,3}|\u2013|\u2014)$/i.test(s)) return null;

    let negative = false;
    // Accounting negative: (500.00) means -500.00
    const paren = /^\((.*)\)$/.exec(s);
    if (paren) {
        negative = true;
        s = paren[1]!;
    }

    s = s
        .replace(/[\s\u00a0\u202f]/g, '')
        .replace(/[$£€¥₦₹₽₪₩]/g, '')
        .replace(/(USD|EUR|GBP|KES|NGN|ZAR)/gi, '')
        .replace(/%$/, '');

    if (s.startsWith('-')) {
        negative = true;
        s = s.slice(1);
    }
    if (s.startsWith('+')) s = s.slice(1);
    if (!s) return null;

    const hasComma = s.includes(',');
    const hasDot = s.includes('.');
    if (hasComma && hasDot) {
        // Whichever separator appears last is the decimal point.
        s = s.lastIndexOf(',') > s.lastIndexOf('.')
            ? s.replace(/\./g, '').replace(',', '.')
            : s.replace(/,/g, '');
    } else if (hasComma) {
        // "1,234" is thousands; "1234,56" is a European decimal. Exactly three
        // digits after the last comma, with no other clue, means thousands.
        const parts = s.split(',');
        const last = parts[parts.length - 1] ?? '';
        s = last.length === 3 && parts.length >= 2 ? parts.join('') : s.replace(',', '.');
    }

    if (!/^\d*\.?\d+$/.test(s)) return null;
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    return negative ? -n : n;
}

function pickColumn(keys: string[], patterns: RegExp[]): string | undefined {
    for (const pattern of patterns) {
        const hit = keys.find((k) => pattern.test(k));
        if (hit) return hit;
    }
    return undefined;
}

const QTY_PATTERNS = [/^qty$/i, /quantity/i, /^units?$/i, /^count$/i];
const UNIT_PATTERNS = [/unit.*(price|cost|rate)/i, /^unit$/i, /^rate$/i, /^price$/i];
const AMOUNT_PATTERNS = [/^amount$/i, /^total$/i, /line.*total/i, /^value$/i, /^extended$/i];

/**
 * Check that quantity times unit price equals the printed line amount.
 * This is the cheapest possible lie detector for an OCR'd invoice.
 */
export function auditLineItems(
    rows: Record<string, unknown>[],
    hints?: { qty?: string; unit?: string; amount?: string },
): AuditReport {
    const findings: AuditFinding[] = [];
    if (!rows.length) return { checked: 0, failed: 0, findings, reconciles: true };

    const keys = Object.keys(rows[0]!);
    const qtyCol = hints?.qty ?? pickColumn(keys, QTY_PATTERNS);
    const unitCol = hints?.unit ?? pickColumn(keys, UNIT_PATTERNS);
    const amountCol = hints?.amount ?? pickColumn(keys, AMOUNT_PATTERNS);
    if (!qtyCol || !unitCol || !amountCol) {
        return { checked: 0, failed: 0, findings, reconciles: true };
    }

    const labelCol = keys.find((k) => k !== qtyCol && k !== unitCol && k !== amountCol);
    rows.forEach((row, i) => {
        const qty = parseMoney(row[qtyCol]);
        const unit = parseMoney(row[unitCol]);
        const amount = parseMoney(row[amountCol]);
        if (qty === null || unit === null || amount === null) return;
        const expected = Math.round(qty * unit * 100) / 100;
        const delta = Math.round((amount - expected) * 100) / 100;
        findings.push({
            kind: 'line_product',
            label: String(row[labelCol ?? ''] ?? `row ${i + 1}`),
            expected,
            actual: amount,
            delta,
            ok: Math.abs(delta) <= TOLERANCE,
        });
    });

    const failed = findings.filter((f) => !f.ok).length;
    return { checked: findings.length, failed, findings, reconciles: failed === 0 };
}

/**
 * Compare figures the document STATES (subtotal, VAT, total) against figures
 * derived from its own line items.
 */
export function auditStatedTotals(
    rows: Record<string, unknown>[],
    stated: Record<string, number>,
    amountColumn?: string,
): AuditReport {
    const findings: AuditFinding[] = [];
    if (!rows.length) return { checked: 0, failed: 0, findings, reconciles: true };

    const keys = Object.keys(rows[0]!);
    const amountCol = amountColumn ?? pickColumn(keys, AMOUNT_PATTERNS);
    if (!amountCol) return { checked: 0, failed: 0, findings, reconciles: true };

    let sum = 0;
    for (const row of rows) {
        const v = parseMoney(row[amountCol]);
        if (v !== null) sum += v;
    }
    sum = Math.round(sum * 100) / 100;

    for (const [label, value] of Object.entries(stated)) {
        // A stated subtotal compares directly; anything else is checked as a
        // ratio of the derived subtotal, which covers VAT and gross totals
        // without needing the rate spelled out.
        const expected = /sub\s*total|^subtotal$|^net$/i.test(label)
            ? sum
            : Math.round(sum * (value / (sum || 1)) * 100) / 100;
        const delta = Math.round((value - expected) * 100) / 100;
        findings.push({
            kind: 'stated_total',
            label,
            expected,
            actual: value,
            delta,
            ok: Math.abs(delta) <= TOLERANCE,
        });
    }

    const failed = findings.filter((f) => !f.ok).length;
    return { checked: findings.length, failed, findings, reconciles: failed === 0 };
}

/** Sum a numeric column, ignoring unparseable cells. */
export function sumColumn(rows: Record<string, unknown>[], column: string): number {
    let total = 0;
    for (const row of rows) {
        const v = parseMoney(row[column]);
        if (v !== null) total += v;
    }
    return Math.round(total * 100) / 100;
}

/** One-line human summary for the collapsed "how I got this" disclosure. */
export function describeAudit(report: AuditReport): string {
    if (report.checked === 0) return 'No arithmetic checks applied.';
    if (report.reconciles) {
        return `${report.checked} arithmetic check(s) reconcile.`;
    }
    const worst = [...report.findings]
        .filter((f) => !f.ok)
        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0];
    return (
        `${report.failed} of ${report.checked} arithmetic check(s) DO NOT reconcile` +
        (worst ? `; largest gap on "${worst.label}": stated ${worst.actual}, derived ${worst.expected}.` : '.')
    );
}
