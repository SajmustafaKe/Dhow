// Materializing dropped files into the workspace store.
//
// The contract with the rest of Data Mode: after ingest, the model can see a
// TableProfile but never a raw row. Everything that could surprise a user
// (header found on row 4, a totals row excluded, a column demoted to VARCHAR)
// lands in TableProfile.notes so the confirmation step can show it.

import fs from 'node:fs';
import path from 'node:path';
import type { DuckDBConnection } from '@duckdb/node-api';
import { getEngine, sanitizeTableName, sqlIdent, sqlLiteral } from './engine.js';
import {
    coerceColumnTypes,
    dataRowsOf,
    inferStructure,
    looksNumeric,
    trimTrailingBlankRows,
    type Grid,
} from './structure.js';
import type { SourceKind, TableProfile } from './types.js';

// papaparse and xlsx are imported STATICALLY on purpose.
//
// parsing.ts loads its parsers through a computed-path `new Function('return
// import(mod)')` so esbuild cannot inline pdfjs-dist's DOM polyfills. That
// trick has a cost the packaged app pays: forge.config.cjs strips
// /^\/node_modules\//, bundle.mjs stages only the native modules, and an
// unresolvable dynamic import is not inlined either, so the module is simply
// absent at runtime. These two are pure JS with no polyfill problem, so a
// static import both avoids that trap and keeps them testable.
import Papa from 'papaparse';
import * as XLSX from 'xlsx';

/** Rows inserted per INSERT statement. Large enough to be fast, small enough to stay under any statement limit. */
const INSERT_CHUNK = 500;

export type IngestOptions = {
    workspaceId?: string;
    tableName?: string;
};

async function uniqueTableName(
    c: DuckDBConnection,
    base: string,
): Promise<string> {
    const root = sanitizeTableName(base);
    const reader = await c.runAndReadAll(
        `SELECT table_name FROM duckdb_tables() WHERE database_name = 'ws'`,
    );
    const existing = new Set(reader.getRowObjects().map((r) => String(r.table_name)));
    if (!existing.has(root)) return root;
    for (let i = 2; i < 1000; i++) {
        const candidate = `${root}_${i}`;
        if (!existing.has(candidate)) return candidate;
    }
    return `${root}_${Date.now()}`;
}

/** Convert a display cell into a SQL literal appropriate for its target type. */
function cellLiteral(cell: string, type: string): string {
    const s = String(cell ?? '').trim();
    if (s === '') return 'NULL';
    if (type === 'BIGINT' || type === 'DOUBLE') {
        if (!looksNumeric(s)) return 'NULL';
        const cleaned = s
            .replace(/^\((.*)\)$/, '-$1')
            .replace(/[\s\u00a0]/g, '')
            .replace(/[$£€¥₦₹]/g, '')
            .replace(/%$/, '')
            .replace(/,/g, '');
        return Number.isFinite(Number(cleaned)) ? cleaned : 'NULL';
    }
    // DATE and VARCHAR both go in quoted; DuckDB casts DATE on insert.
    return sqlLiteral(s);
}

/**
 * Core path: a parsed grid becomes a typed table plus a profile.
 * Used by CSV, XLSX and (via table-from-boxes) OCR.
 */
export async function ingestGrid(
    grid: Grid,
    meta: {
        sourcePath: string;
        sourceKind: SourceKind;
        sheet?: string;
        workspaceId?: string;
        tableName?: string;
        extraNotes?: string[];
    },
): Promise<TableProfile> {
    const engine = await getEngine(meta.workspaceId);
    const inf = inferStructure(grid);
    const rows = dataRowsOf(grid, inf);
    const { types, notes: typeNotes } = coerceColumnTypes(rows, inf.columns);

    const baseName =
        meta.tableName ??
        (meta.sheet
            ? `${path.basename(meta.sourcePath, path.extname(meta.sourcePath))}__${meta.sheet}`
            : path.basename(meta.sourcePath, path.extname(meta.sourcePath)));

    return engine.withWrite(async (c) => {
        const table = await uniqueTableName(c, baseName);
        const cols = inf.columns
            .map((name, i) => `${sqlIdent(name)} ${types[i] ?? 'VARCHAR'}`)
            .join(', ');
        await c.run(`DROP TABLE IF EXISTS ${sqlIdent(table)}`);
        await c.run(`CREATE TABLE ${sqlIdent(table)} (${cols})`);

        for (let start = 0; start < rows.length; start += INSERT_CHUNK) {
            const chunk = rows.slice(start, start + INSERT_CHUNK);
            const values = chunk
                .map(
                    (row) =>
                        `(${inf.columns
                            .map((_, i) => cellLiteral(row[i] ?? '', types[i] ?? 'VARCHAR'))
                            .join(', ')})`,
                )
                .join(', ');
            await c.run(`INSERT INTO ${sqlIdent(table)} VALUES ${values}`);
        }

        const profile = await engine.profileTable(c, table, {
            sourcePath: meta.sourcePath,
            sourceKind: meta.sourceKind,
            ...(meta.sheet ? { sheet: meta.sheet } : {}),
            notes: [...inf.notes, ...typeNotes, ...(meta.extraNotes ?? [])],
        });
        await engine.saveProfileWithin(c, profile);
        return profile;
    });
}

/**
 * CSV. DuckDB's read_csv_auto is far faster and infers types properly, but it
 * assumes the header is on row 0 with no junk. So: infer first, and only take
 * the fast path when the file is actually clean. Correctness beats speed on
 * the ugly files, which is most of them.
 */
export async function ingestCsv(absPath: string, opts: IngestOptions = {}): Promise<TableProfile> {
    if (!fs.existsSync(absPath)) throw new Error(`No such file: ${absPath}`);
    const text = fs.readFileSync(absPath, 'utf8');
    const parsed = Papa.parse<string[]>(text, { header: false, skipEmptyLines: false });
    const grid: Grid = trimTrailingBlankRows(
        parsed.data.map((r) => r.map((c) => String(c ?? ''))),
    );
    const inf = inferStructure(grid);

    const clean = inf.headerRow === 0 && inf.skippedRows.length === 0 && inf.confidence >= 0.5;
    if (!clean) {
        return ingestGrid(grid, {
            sourcePath: absPath,
            sourceKind: 'csv',
            ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
            ...(opts.tableName ? { tableName: opts.tableName } : {}),
            extraNotes: ['Parsed row by row because the file needed structure repair.'],
        });
    }

    const engine = await getEngine(opts.workspaceId);
    const base = opts.tableName ?? path.basename(absPath, path.extname(absPath));
    return engine.withWrite(async (c) => {
        const table = await uniqueTableName(c, base);
        await c.run(`DROP TABLE IF EXISTS ${sqlIdent(table)}`);
        await c.run(
            `CREATE TABLE ${sqlIdent(table)} AS SELECT * FROM read_csv_auto(${sqlLiteral(absPath)})`,
        );
        const profile = await engine.profileTable(c, table, {
            sourcePath: absPath,
            sourceKind: 'csv',
            notes: ['Clean header on row 1; imported with DuckDB native CSV type inference.'],
        });
        await engine.saveProfileWithin(c, profile);
        return profile;
    });
}

/**
 * XLSX, one table per sheet (plan decision D4). SheetJS rather than DuckDB's
 * read_xlsx: verified that read_xlsx returns A1/B1/C1 as column names on a
 * plain sheet, and we need control over multi-row headers anyway.
 */
export async function ingestXlsx(
    absPath: string,
    opts: IngestOptions = {},
): Promise<TableProfile[]> {
    if (!fs.existsSync(absPath)) throw new Error(`No such file: ${absPath}`);
    const workbook = XLSX.read(fs.readFileSync(absPath), { type: 'buffer' });
    const out: TableProfile[] = [];

    for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        if (!sheet) continue;
        // `header: 1` makes sheet_to_json return an array of row arrays, but
        // SheetJS types it loosely, so narrow it once here.
        const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
            header: 1,
            raw: false,
            defval: '',
            blankrows: true,
        });
        const normalized: Grid = trimTrailingBlankRows(
            grid.map((row) => row.map((cell) => String(cell ?? ''))),
        );

        const inf = inferStructure(normalized);
        const dataCount = dataRowsOf(normalized, inf).length;
        // A cover page or legend: one column of prose, or too few rows to be a
        // dataset. Recorded loudly rather than imported as junk.
        if (inf.columns.length < 2 || dataCount < 2) {
            // A cover page or a legend, not a dataset. Skipped loudly, not silently.
            out.push({
                table: sanitizeTableName(`${path.basename(absPath, path.extname(absPath))}__${sheetName}`),
                sourcePath: absPath,
                sourceKind: 'xlsx',
                sheet: sheetName,
                rowCount: 0,
                columns: [],
                importedAt: new Date().toISOString(),
                notes: [
                    `Sheet "${sheetName}" has ${inf.columns.length} column(s) and ${dataCount} data row(s); skipped as a cover page.`,
                    'skipped',
                ],
            });
            continue;
        }

        out.push(
            await ingestGrid(normalized, {
                sourcePath: absPath,
                sourceKind: 'xlsx',
                sheet: sheetName,
                ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
            }),
        );
    }
    return out;
}

/** True when a profile represents a sheet that was deliberately not imported. */
export function wasSkipped(p: TableProfile): boolean {
    return p.rowCount === 0 && p.notes.includes('skipped');
}

/** Route a dropped file to the right importer. Returns [] for non-tabular input. */
export async function ingestFile(
    absPath: string,
    opts: IngestOptions = {},
): Promise<TableProfile[]> {
    const ext = path.extname(absPath).toLowerCase();
    if (ext === '.csv' || ext === '.tsv') return [await ingestCsv(absPath, opts)];
    if (ext === '.xlsx' || ext === '.xls' || ext === '.xlsm') return ingestXlsx(absPath, opts);
    return [];
}

export function isTabularFile(p: string): boolean {
    return ['.csv', '.tsv', '.xlsx', '.xls', '.xlsm'].includes(path.extname(p).toLowerCase());
}
