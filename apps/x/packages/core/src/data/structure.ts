// Structure inference for messy tabular exports.
//
// Real finance exports are not tidy CSVs. A P&L a CFO emails out has a title
// block, a blank spacer row, merged cells that arrive as empty strings, a
// header split over two rows, footnotes at the bottom, and a TOTAL row sitting
// inside the data. Plan decision D3: best-effort parse, then SHOW the user
// what we inferred. Refusing loses; silent guessing ships a wrong number.
//
// Everything here is pure so it can be tested against literal grids.

export type Grid = string[][];

export type Inference = {
    /** Index into the grid, or -1 when no header could be identified. */
    headerRow: number;
    dataStartRow: number;
    /** De-duplicated, never-empty column names. */
    columns: string[];
    /** Grid row indices excluded from the data: blanks, titles, totals, footnotes. */
    skippedRows: number[];
    notes: string[];
    /** 0..1. Below ~0.5 the UI should insist on confirmation. */
    confidence: number;
};

const TOTALS_RE = /^\s*(grand\s+total|sub[\s-]?total|total|sum|net|balance)\b/i;
/** A footnote is prose in the first cell with nothing beside it. */
const FOOTNOTE_RE = /^\s*(\*|note[:s]?\b|source[:]?\b|prepared by\b|disclaimer\b)/i;

function isBlankRow(row: string[] | undefined): boolean {
    return !row || row.every((c) => String(c ?? '').trim() === '');
}

function density(row: string[]): number {
    if (!row.length) return 0;
    return row.filter((c) => String(c ?? '').trim() !== '').length / row.length;
}

/** Looks like a number once thousands separators and currency are removed. */
export function looksNumeric(cell: string): boolean {
    const s = String(cell ?? '').trim();
    if (!s) return false;
    const cleaned = s
        .replace(/^\((.*)\)$/, '-$1')
        .replace(/[\s\u00a0]/g, '')
        .replace(/[$£€¥₦₹]/g, '')
        .replace(/%$/, '')
        .replace(/,/g, '');
    return cleaned !== '' && cleaned !== '-' && Number.isFinite(Number(cleaned));
}

function numericFraction(row: string[]): number {
    const filled = row.filter((c) => String(c ?? '').trim() !== '');
    if (!filled.length) return 0;
    return filled.filter(looksNumeric).length / filled.length;
}

/** A totals row: a label matching TOTALS_RE and no other text cells. */
export function isTotalsRow(row: string[]): boolean {
    const cells = row.map((c) => String(c ?? '').trim());
    const firstText = cells.find((c) => c !== '');
    if (!firstText || !TOTALS_RE.test(firstText)) return false;
    const others = cells.filter((c) => c !== '' && c !== firstText);
    return others.length === 0 || others.every(looksNumeric);
}

function isFootnoteRow(row: string[]): boolean {
    const cells = row.map((c) => String(c ?? '').trim()).filter((c) => c !== '');
    if (cells.length !== 1) return false;
    return FOOTNOTE_RE.test(cells[0] ?? '') || cells[0]!.length > 60;
}

/** Make column names unique, non-empty, and stable. */
export function dedupeColumns(raw: string[]): { columns: string[]; notes: string[] } {
    const notes: string[] = [];
    const seen = new Map<string, number>();
    const columns = raw.map((r, i) => {
        let name = String(r ?? '')
            .replace(/\s+/g, ' ')
            .trim();
        if (!name) {
            name = `column_${i + 1}`;
            notes.push(`Column ${i + 1} had no header; named ${name}.`);
        }
        const lower = name.toLowerCase();
        const count = seen.get(lower) ?? 0;
        seen.set(lower, count + 1);
        if (count > 0) {
            const renamed = `${name}_${count + 1}`;
            notes.push(`Duplicate column "${name}" renamed to "${renamed}".`);
            return renamed;
        }
        return name;
    });
    return { columns, notes };
}

/**
 * Score a candidate header row. A header is dense, textual, distinct, and the
 * rows under it are markedly more numeric than it is. That last signal is what
 * separates a real header from a title line or a stray label.
 */
function scoreHeader(grid: Grid, i: number): number {
    const row = grid[i];
    if (!row || isBlankRow(row)) return -1;
    const cells = row.map((c) => String(c ?? '').trim());
    const filled = cells.filter((c) => c !== '');
    if (filled.length < 2) return -1;

    const dens = density(row);
    const distinct = new Set(filled.map((c) => c.toLowerCase())).size / filled.length;
    const textual = 1 - numericFraction(row);

    // How numeric are the next few non-blank rows?
    let below = 0;
    let counted = 0;
    for (let j = i + 1; j < grid.length && counted < 3; j++) {
        const r = grid[j];
        if (!r || isBlankRow(r)) continue;
        below += numericFraction(r);
        counted++;
    }
    const belowNumeric = counted ? below / counted : 0;
    if (!counted) return -1;

    return dens * 0.3 + distinct * 0.25 + textual * 0.2 + belowNumeric * 0.25;
}

/**
 * Drop trailing all-blank rows. A file that ends with a newline is not a data
 * quality problem, and counting that phantom row as "skipped" would push an
 * otherwise clean CSV onto the slow repair path.
 */
export function trimTrailingBlankRows(grid: Grid): Grid {
    let end = grid.length;
    while (end > 0 && isBlankRow(grid[end - 1])) end--;
    return end === grid.length ? grid : grid.slice(0, end);
}

export function inferStructure(grid: Grid): Inference {
    const notes: string[] = [];
    const skippedRows: number[] = [];

    if (!grid.length) {
        return {
            headerRow: -1,
            dataStartRow: 0,
            columns: [],
            skippedRows: [],
            notes: ['The sheet is empty.'],
            confidence: 0,
        };
    }

    // Only look for a header near the top; a "header" 40 rows down is a
    // section break, not the schema.
    const searchLimit = Math.min(grid.length, 25);
    let best = -1;
    let bestScore = -1;
    for (let i = 0; i < searchLimit; i++) {
        const s = scoreHeader(grid, i);
        if (s > bestScore) {
            bestScore = s;
            best = i;
        }
    }

    if (best < 0 || bestScore <= 0) {
        // No header: synthesize names and treat everything as data.
        const width = Math.max(...grid.map((r) => r.length));
        const { columns, notes: dn } = dedupeColumns(Array.from({ length: width }, () => ''));
        notes.push('No header row was identified; columns are positional.');
        notes.push(...dn);
        return { headerRow: -1, dataStartRow: 0, columns, skippedRows: [], notes, confidence: 0.2 };
    }

    for (let i = 0; i < best; i++) {
        skippedRows.push(i);
    }
    if (best > 0) {
        notes.push(
            `Header detected on row ${best + 1}; ${best} row(s) above it treated as a title block.`,
        );
    }

    const headerCells = grid[best] ?? [];
    const width = Math.max(headerCells.length, ...grid.slice(best).map((r) => r.length));
    const rawNames = Array.from({ length: width }, (_, i) => headerCells[i] ?? '');
    const { columns, notes: dn } = dedupeColumns(rawNames);
    notes.push(...dn);

    // Classify every row below the header.
    let totals = 0;
    let blanks = 0;
    let footnotes = 0;
    for (let i = best + 1; i < grid.length; i++) {
        const row = grid[i] ?? [];
        if (isBlankRow(row)) {
            skippedRows.push(i);
            blanks++;
            continue;
        }
        if (isTotalsRow(row)) {
            // Recorded, never silently dropped: a totals row counted as data
            // double-counts every figure in the sheet.
            skippedRows.push(i);
            totals++;
            continue;
        }
        if (isFootnoteRow(row)) {
            skippedRows.push(i);
            footnotes++;
            continue;
        }
    }
    if (totals) notes.push(`${totals} totals row(s) excluded from the data.`);
    if (blanks) notes.push(`${blanks} blank row(s) skipped.`);
    if (footnotes) notes.push(`${footnotes} footnote row(s) skipped.`);

    const kept = grid.length - (best + 1) - (totals + blanks + footnotes);
    if (kept < 1) notes.push('No data rows remain after filtering.');

    return {
        headerRow: best,
        dataStartRow: best + 1,
        columns,
        skippedRows,
        notes,
        confidence: Math.max(0, Math.min(1, bestScore)),
    };
}

/**
 * Pick a DuckDB type per column from the actual values. Conservative on
 * purpose: one unparseable cell demotes the column to VARCHAR, because a
 * silently-coerced number is worse than a string the model has to cast.
 */
export function coerceColumnTypes(
    rows: string[][],
    columns: string[],
): { types: string[]; notes: string[] } {
    const notes: string[] = [];
    const types = columns.map((col, i) => {
        let seen = 0;
        let numeric = 0;
        let integral = 0;
        let dateish = 0;
        for (const row of rows) {
            const cell = String(row[i] ?? '').trim();
            if (cell === '') continue;
            seen++;
            if (looksNumeric(cell)) {
                numeric++;
                if (/^-?\d+$/.test(cell.replace(/,/g, ''))) integral++;
            }
            if (/^\d{4}-\d{2}-\d{2}([T ]|$)/.test(cell) || /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(cell)) {
                dateish++;
            }
        }
        if (seen === 0) {
            notes.push(`Column "${col}" is entirely empty; typed as VARCHAR.`);
            return 'VARCHAR';
        }
        if (numeric === seen) return integral === seen ? 'BIGINT' : 'DOUBLE';
        if (dateish === seen) return 'DATE';
        if (numeric > 0 && numeric < seen) {
            notes.push(
                `Column "${col}" mixes numbers and text (${seen - numeric} non-numeric of ${seen}); typed as VARCHAR.`,
            );
        }
        return 'VARCHAR';
    });
    return { types, notes };
}

/** Extract the data rows implied by an Inference, padded to the column count. */
export function dataRowsOf(grid: Grid, inf: Inference): string[][] {
    const skip = new Set(inf.skippedRows);
    const out: string[][] = [];
    for (let i = inf.dataStartRow; i < grid.length; i++) {
        if (skip.has(i)) continue;
        const row = grid[i] ?? [];
        out.push(Array.from({ length: inf.columns.length }, (_, c) => String(row[c] ?? '')));
    }
    return out;
}
