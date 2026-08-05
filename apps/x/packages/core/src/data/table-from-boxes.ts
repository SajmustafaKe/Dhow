// Reconstructing a table from OCR bounding boxes.
//
// OCR gives you a bag of text lines, each with a box. That is not a table, and
// a model handed the raw bag will hallucinate the column alignment. But the
// geometry is right there: lines sharing a y-centre are a row, and their x
// order is the column order.
//
// Verified against Apple Vision output for a synthetic invoice: this
// reproduced the header row and all three line items exactly, with the
// Subtotal / VAT / TOTAL block correctly falling out as 2-cell rows.

import { normalizeConfusables } from './confusables.js';

export type OcrLine = {
    text: string;
    confidence: number;
    /** Normalized 0..1, origin BOTTOM-left (Vision's convention). */
    x: number;
    y: number;
    w: number;
    h: number;
    page?: number;
};

function median(values: number[]): number {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid]! : ((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/**
 * Cluster OCR lines into a dense grid.
 *
 * Tolerance defaults to half the median glyph height: tight enough that a
 * table's header does not merge into its first data row, loose enough that
 * baseline jitter within one printed row does not split it in two.
 */
export function gridFromBoxes(
    lines: OcrLine[],
    opts?: { rowTolerance?: number; normalize?: boolean },
): string[][] {
    if (!lines.length) return [];
    const normalize = opts?.normalize ?? true;
    // Median height can be 0 for degenerate boxes; fall back to a small
    // absolute tolerance so clustering still terminates sensibly.
    const tolerance = opts?.rowTolerance ?? (median(lines.map((l) => l.h)) / 2 || 0.01);

    type Row = { y: number; cells: OcrLine[]; page: number };
    const rows: Row[] = [];

    // Top to bottom. y is bottom-origin, so descending y reads down the page.
    const ordered = [...lines].sort((a, b) => {
        const pa = a.page ?? 0;
        const pb = b.page ?? 0;
        if (pa !== pb) return pa - pb;
        return b.y + b.h / 2 - (a.y + a.h / 2);
    });

    for (const line of ordered) {
        const centre = line.y + line.h / 2;
        const page = line.page ?? 0;
        const existing = rows.find((r) => r.page === page && Math.abs(r.y - centre) < tolerance);
        if (existing) {
            existing.cells.push(line);
        } else {
            rows.push({ y: centre, cells: [line], page });
        }
    }

    return rows.map((row) =>
        row.cells
            .sort((a, b) => a.x - b.x)
            .map((cell) => (normalize ? normalizeConfusables(cell.text) : cell.text)),
    );
}

/**
 * Split a reconstructed grid into the rectangular block that is actually a
 * table, plus the loose lines around it.
 *
 * An invoice is a title, then a table, then a totals block. The table is the
 * run of rows that share the modal cell count, and only that run should be
 * imported: a 2-cell "TOTAL DUE | 6,224.27" row masquerading as data is
 * exactly how a figure gets double counted.
 */
export function extractTableBlock(grid: string[][]): {
    table: string[][];
    before: string[][];
    after: string[][];
    width: number;
} {
    if (!grid.length) return { table: [], before: [], after: [], width: 0 };

    const counts = new Map<number, number>();
    for (const row of grid) {
        if (row.length < 2) continue;
        counts.set(row.length, (counts.get(row.length) ?? 0) + 1);
    }
    if (!counts.size) return { table: [], before: grid, after: [], width: 0 };

    // Widest among the most frequent widths: a 4-column table with three data
    // rows beats two coincidental 2-cell rows.
    let width = 0;
    let best = 0;
    for (const [w, n] of counts) {
        if (n > best || (n === best && w > width)) {
            best = n;
            width = w;
        }
    }

    const start = grid.findIndex((r) => r.length === width);
    if (start < 0) return { table: [], before: grid, after: [], width: 0 };
    let end = start;
    for (let i = start; i < grid.length; i++) {
        if (grid[i]!.length === width) end = i;
        // Allow a single narrower row inside the run (a wrapped description)
        // without ending the table.
        else if (i - end > 1) break;
    }

    return {
        table: grid.slice(start, end + 1).filter((r) => r.length === width),
        before: grid.slice(0, start),
        after: grid.slice(end + 1),
        width,
    };
}
