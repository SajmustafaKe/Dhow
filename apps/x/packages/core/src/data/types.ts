// Data Mode shared types. See apps/x/DATA_MODE_PLAN.md.
//
// The whole subsystem exists to keep raw rows away from the model: files are
// materialized into DuckDB tables, the model sees a TableProfile (schema plus
// a statistical sketch), and it receives aggregates back. Nothing here should
// ever carry a full dataset.

export type SourceKind = 'csv' | 'xlsx' | 'ocr' | 'pdf' | 'docx' | 'pptx' | 'html';

export type ColumnProfile = {
    name: string;
    /** DuckDB type name as reported by SUMMARIZE. */
    type: string;
    /** 0..100. Feeding this to the model materially improves generated SQL. */
    nullPct: number;
    min?: string;
    max?: string;
    approxUnique?: number;
    /** <= 3 example values, stringified and truncated. Schema linking, not data. */
    sample: string[];
};

export type TableProfile = {
    /** Physical DuckDB identifier. Already passed through sanitizeTableName. */
    table: string;
    /** Absolute path of the file this table came from. */
    sourcePath: string;
    sourceKind: SourceKind;
    sheet?: string;
    rowCount: number;
    columns: ColumnProfile[];
    /** ISO8601. */
    importedAt: string;
    /**
     * Human-readable inference notes ("header detected on row 4", "1 totals row
     * excluded"). These are shown to the user at the confirmation step and to
     * the model in the schema prompt, so an ugly parse is never silent.
     */
    notes: string[];
};

export type QueryOk = {
    ok: true;
    sql: string;
    rows: Record<string, unknown>[];
    rowCount: number;
    truncated: boolean;
    elapsedMs: number;
};

export type QueryErr = {
    ok: false;
    sql: string;
    error: string;
    /** "gate" = rejected before execution by the AST allowlist. */
    stage: 'gate' | 'execute';
};

export type QueryResult = QueryOk | QueryErr;
