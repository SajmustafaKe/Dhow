// Builtin tools: data domain. Data Mode's query surface.
//
// These are SKILL-SCOPED, not base tools. base-tools.ts warns that every
// always-attached entry is schema bytes on every single model call and that
// tool-selection accuracy degrades as the attached count grows, so the drop
// path stays with parseFile (already base) and the model pulls these in by
// loading the data-analysis skill.
//
// Permissions: reads are "none" because the store holds only what the user
// already dropped in, and every statement is AST-gated and executed against a
// READ_ONLY, network-disabled, config-locked DuckDB instance. data-forget is
// "prompt" because dropping a table is destructive and irreversible.

import { z } from "zod";
import * as path from "path";
import { ask, describeProvenance } from "../../../data/ask.js";
import { getEngine, sanitizeTableName } from "../../../data/engine.js";
import { ingestFile, isTabularFile, wasSkipped } from "../../../data/ingest.js";
import { writeTableNote } from "../../../data/graph-bridge.js";
import type { TableProfile } from "../../../data/types.js";
import { BuiltinToolsSchema } from "../types.js";

/** Compact profile view. Full column stats would swamp the tool result. */
function summarizeProfile(p: TableProfile) {
    return {
        table: p.table,
        rows: p.rowCount,
        source: path.basename(p.sourcePath),
        ...(p.sheet ? { sheet: p.sheet } : {}),
        columns: p.columns.map((c) => ({
            name: c.name,
            type: c.type,
            ...(c.nullPct > 0 ? { nullPct: Math.round(c.nullPct) } : {}),
            ...(c.sample.length ? { sample: c.sample } : {}),
        })),
        ...(p.notes.length ? { notes: p.notes } : {}),
    };
}

export const dataTools: z.infer<typeof BuiltinToolsSchema> = {
    'data-import': {
        permission: "file-boundary",
        description:
            'Import a spreadsheet or CSV into the workspace data store so it can be queried with SQL. ' +
            'Use this instead of parseFile for any tabular file you intend to analyze. Returns the ' +
            'inferred schema and any structure repairs that were applied.',
        inputSchema: z.object({
            path: z.string().min(1).describe('Absolute path to a .csv, .tsv, .xlsx or .xls file.'),
        }),
        execute: async ({ path: filePath }: { path: string }) => {
            try {
                if (!isTabularFile(filePath)) {
                    return {
                        success: false,
                        error: `Not a tabular file: ${filePath}. Supported: .csv, .tsv, .xlsx, .xls.`,
                    };
                }
                const profiles = await ingestFile(filePath);
                if (!profiles.length) {
                    return { success: false, error: `Nothing importable found in ${filePath}.` };
                }
                for (const p of profiles) {
                    if (!wasSkipped(p)) writeTableNote(p);
                }
                return {
                    success: true,
                    imported: profiles.filter((p) => !wasSkipped(p)).map(summarizeProfile),
                    skipped: profiles.filter(wasSkipped).map((p) => ({
                        sheet: p.sheet,
                        reason: p.notes[0],
                    })),
                };
            } catch (error) {
                return {
                    success: false,
                    error: error instanceof Error ? error.message : 'Unknown error',
                };
            }
        },
    },

    'data-listTables': {
        permission: "none",
        description:
            'List the tables already imported into the workspace data store, with their schema, ' +
            'row counts and any notes from import. Call this BEFORE answering a data question so ' +
            'you use real column names.',
        inputSchema: z.object({}),
        execute: async () => {
            try {
                const engine = await getEngine();
                const tables = await engine.listTables();
                return {
                    success: true,
                    count: tables.length,
                    tables: tables.map(summarizeProfile),
                };
            } catch (error) {
                return {
                    success: false,
                    error: error instanceof Error ? error.message : 'Unknown error',
                };
            }
        },
    },

    'data-ask': {
        permission: "none",
        description:
            'Answer a question about the imported data in natural language. Generates SQL, executes it, ' +
            'repairs it from the engine error if it fails, and returns the rows plus full provenance ' +
            '(SQL, tables, columns, rows scanned). Prefer this over writing SQL yourself.',
        inputSchema: z.object({
            question: z.string().min(1).describe('The question, in plain English.'),
            tables: z
                .array(z.string())
                .optional()
                .describe('Restrict to these table names. Omit to consider every imported table.'),
        }),
        execute: async ({ question, tables }: { question: string; tables?: string[] }) => {
            try {
                const result = await ask(question, {
                    ...(tables?.length ? { tables } : {}),
                });
                if (!result.ok) {
                    return {
                        success: false,
                        error:
                            result.errors[result.errors.length - 1] ??
                            'Could not produce a working query.',
                        attempts: result.attempts,
                        lastSql: result.sql,
                    };
                }
                return {
                    success: true,
                    rows: result.rows,
                    rowCount: result.rowCount,
                    truncated: result.truncated,
                    provenance: describeProvenance(result),
                    ...(result.errors.length ? { warnings: result.errors } : {}),
                };
            } catch (error) {
                return {
                    success: false,
                    error: error instanceof Error ? error.message : 'Unknown error',
                };
            }
        },
    },

    'data-sql': {
        permission: "none",
        description:
            'Run one read-only SELECT against the imported data. Use only when data-ask cannot express ' +
            'the question. Anything other than a single SELECT is rejected before execution.',
        inputSchema: z.object({
            sql: z.string().min(1).describe('A single SELECT statement. No DDL, no DML, no PRAGMA.'),
            maxRows: z.number().int().positive().max(1000).optional(),
        }),
        execute: async ({ sql, maxRows }: { sql: string; maxRows?: number }) => {
            try {
                const engine = await getEngine();
                const result = await engine.query(sql, { maxRows: maxRows ?? 200 });
                if (!result.ok) {
                    return { success: false, error: result.error, stage: result.stage };
                }
                return {
                    success: true,
                    sql: result.sql,
                    rows: result.rows,
                    rowCount: result.rowCount,
                    truncated: result.truncated,
                    elapsedMs: result.elapsedMs,
                };
            } catch (error) {
                return {
                    success: false,
                    error: error instanceof Error ? error.message : 'Unknown error',
                };
            }
        },
    },

    'data-forget': {
        permission: "prompt",
        description:
            'Permanently delete an imported table from the workspace data store. Irreversible. ' +
            'The original source file is not touched.',
        inputSchema: z.object({
            table: z.string().min(1).describe('The table name as reported by data-listTables.'),
        }),
        execute: async ({ table }: { table: string }) => {
            try {
                const engine = await getEngine();
                const name = sanitizeTableName(table);
                const existing = await engine.getProfile(name);
                if (!existing) {
                    return { success: false, error: `No imported table named "${table}".` };
                }
                await engine.dropTable(name);
                return { success: true, forgotten: name };
            } catch (error) {
                return {
                    success: false,
                    error: error instanceof Error ? error.message : 'Unknown error',
                };
            }
        },
    },
};
