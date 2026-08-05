// Natural language to SQL, with the review-and-repair loop that IS the product.
//
// Measured in DATA_MODE_PLAN.md 3: frontier models score 58-64% strict
// execution accuracy on BIRD, but 94-95% when the output is reviewed. Same
// models. So the loop, not the model, is what makes this trustworthy:
//
//   schema prompt -> SQL -> AST gate -> execute
//                      ^                   |
//                      +--- exact error ---+   (bounded retries)
//
// Two other things matter as much as the loop:
//  - Schema linking. The prompt carries column types, null rates, min/max and
//    up to three sample values per column. That sketch is what stops the model
//    inventing a column name, and it costs nothing at query time because
//    ingest already computed it.
//  - Provenance. Every answer records the SQL, the tables and columns touched,
//    and the rows scanned, so the CFO who says "that's wrong" can check in ten
//    seconds. An unauditable number is the failure mode this feature exists to
//    avoid.

import { getEngine } from './engine.js';
import type { QueryResult, TableProfile } from './types.js';

export type AskProvenance = {
    tables: string[];
    columns: string[];
    rowsScanned: number;
    elapsedMs: number;
};

export type AskResult = {
    ok: boolean;
    question: string;
    sql: string | null;
    rows: Record<string, unknown>[];
    rowCount: number;
    truncated: boolean;
    attempts: number;
    provenance: AskProvenance;
    /** Engine errors from failed attempts, plus any plausibility warnings. */
    errors: string[];
};

export type GenerateFn = (prompt: string) => Promise<string>;

const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Render the schema sketch the model reasons over. This is the single highest
 * leverage part of the prompt; everything here came out of SUMMARIZE at import
 * time, so it is free.
 */
export function buildSchemaPrompt(profiles: TableProfile[]): string {
    if (!profiles.length) return 'No tables have been imported yet.';
    const blocks = profiles.map((p) => {
        const cols = p.columns
            .map((c) => {
                const bits = [`  - ${c.name} ${c.type}`];
                if (c.nullPct > 0) bits.push(`${c.nullPct.toFixed(0)}% null`);
                if (c.min !== undefined && c.max !== undefined) bits.push(`range ${c.min}..${c.max}`);
                if (c.approxUnique !== undefined) bits.push(`~${c.approxUnique} distinct`);
                if (c.sample.length) bits.push(`e.g. ${c.sample.map((s) => JSON.stringify(s)).join(', ')}`);
                return bits.join(' | ');
            })
            .join('\n');
        const notes = p.notes.length ? `\n  notes: ${p.notes.join(' ')}` : '';
        const origin = p.sheet ? `${p.sourcePath} (sheet "${p.sheet}")` : p.sourcePath;
        return `TABLE ${p.table}  -- ${p.rowCount} rows, from ${origin}${notes}\n${cols}`;
    });
    return blocks.join('\n\n');
}

function buildPrompt(question: string, schema: string, priorErrors: string[]): string {
    const retry = priorErrors.length
        ? `\n\nYour previous attempt(s) failed. Fix the SQL. Exact engine errors:\n` +
          priorErrors.map((e, i) => `  attempt ${i + 1}: ${e}`).join('\n')
        : '';
    return (
        `You write DuckDB SQL. Answer the question using ONLY the tables below.\n\n` +
        `${schema}\n\n` +
        `Question: ${question}\n\n` +
        `Rules:\n` +
        `- Emit ONE read-only SELECT statement and nothing else. No prose, no markdown fence, no semicolon-separated statements.\n` +
        `- Only use tables and columns that appear above. Never invent a name.\n` +
        `- Aggregate. The caller wants a small result, not raw rows.\n` +
        `- Prefer explicit column aliases so the output is self-describing.\n` +
        `- DuckDB dialect: use strftime(col, '%Y-%m') for month bucketing on DATE columns.` +
        retry
    );
}

/**
 * Models wrap SQL in a fence about a third of the time no matter how firmly
 * you ask them not to, so unwrap rather than fail.
 */
export function extractSql(raw: string): string {
    let text = String(raw ?? '').trim();
    const fence = /```(?:sql)?\s*([\s\S]*?)```/i.exec(text);
    if (fence?.[1]) text = fence[1].trim();
    // Drop a leading label like "SQL:" that some models prepend.
    text = text.replace(/^\s*(sql)\s*:\s*/i, '').trim();
    // A single trailing semicolon is harmless but the AST gate is stricter
    // than it needs to be about them.
    return text.replace(/;\s*$/, '').trim();
}

async function defaultGenerate(prompt: string): Promise<string> {
    // Imported lazily on purpose. The model-provider chain does real work at
    // module load (config reads, catalog warmup), and ask() is also used with
    // an injected generator, so pulling it in at import time would make every
    // consumer of this module pay for a provider stack it may never touch.
    const { generateText } = await import('ai');
    const { getCurrentUseCase, withUseCase } = await import('../analytics/use_case.js');
    const { getDefaultModelAndProvider, resolveProviderConfig } = await import(
        '../models/defaults.js'
    );
    const { createLanguageModel } = await import('../models/models.js');

    const { model: modelId, provider: providerName } = await getDefaultModelAndProvider();
    const providerConfig = await resolveProviderConfig(providerName);
    const model = createLanguageModel(providerConfig, modelId);
    const ctx = getCurrentUseCase();
    const response = await withUseCase(
        {
            useCase: ctx?.useCase ?? 'copilot_chat',
            subUseCase: 'data_ask',
            ...(ctx?.agentName ? { agentName: ctx.agentName } : {}),
        },
        () => generateText({ model, prompt }),
    );
    return response.text;
}

/** Columns mentioned in the SQL that actually exist in the schema. */
function columnsTouched(sql: string, profiles: TableProfile[]): string[] {
    const lower = sql.toLowerCase();
    const out = new Set<string>();
    for (const p of profiles) {
        for (const c of p.columns) {
            if (lower.includes(c.name.toLowerCase())) out.add(c.name);
        }
    }
    return [...out];
}

function tablesTouched(sql: string, profiles: TableProfile[]): string[] {
    const lower = sql.toLowerCase();
    return profiles.filter((p) => lower.includes(p.table.toLowerCase())).map((p) => p.table);
}

/** A result that is technically valid but probably not an answer. */
function plausibilityWarnings(result: Extract<QueryResult, { ok: true }>): string[] {
    const warnings: string[] = [];
    if (result.rowCount === 0) {
        warnings.push('The query returned no rows. The filter may be wrong or the data may not cover that period.');
        return warnings;
    }
    if (result.rowCount === 1) {
        const only = result.rows[0] ?? {};
        const values = Object.values(only);
        if (values.length > 0 && values.every((v) => v === null)) {
            warnings.push('The query returned a single all-NULL row, which usually means an aggregate over zero matching rows.');
        }
    }
    return warnings;
}

export async function ask(
    question: string,
    opts?: {
        workspaceId?: string;
        tables?: string[];
        maxAttempts?: number;
        generate?: GenerateFn;
        maxRows?: number;
    },
): Promise<AskResult> {
    const started = Date.now();
    const maxAttempts = Math.max(1, opts?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    const generate = opts?.generate ?? defaultGenerate;
    const engine = await getEngine(opts?.workspaceId);

    const all = await engine.listTables();
    const usable = all.filter((p) => p.rowCount > 0);
    const profiles = opts?.tables?.length
        ? usable.filter((p) => opts.tables!.includes(p.table))
        : usable;

    const base: AskResult = {
        ok: false,
        question,
        sql: null,
        rows: [],
        rowCount: 0,
        truncated: false,
        attempts: 0,
        provenance: { tables: [], columns: [], rowsScanned: 0, elapsedMs: 0 },
        errors: [],
    };

    if (!profiles.length) {
        return {
            ...base,
            errors: ['No imported tables are available. Import a spreadsheet or CSV first.'],
            provenance: { ...base.provenance, elapsedMs: Date.now() - started },
        };
    }

    const schema = buildSchemaPrompt(profiles);
    const errors: string[] = [];
    let lastSql: string | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        let sql: string;
        try {
            sql = extractSql(await generate(buildPrompt(question, schema, errors)));
        } catch (err) {
            errors.push(`Model call failed: ${err instanceof Error ? err.message : String(err)}`);
            continue;
        }
        lastSql = sql;
        if (!sql) {
            errors.push('The model returned an empty statement.');
            continue;
        }

        const result = await engine.query(sql, { maxRows: opts?.maxRows ?? 200 });
        if (!result.ok) {
            // The EXACT engine error goes back to the model. Paraphrasing it
            // measurably hurts the repair rate.
            errors.push(result.error);
            continue;
        }

        const warnings = plausibilityWarnings(result);
        const rowsScanned = profiles
            .filter((p) => tablesTouched(sql, profiles).includes(p.table))
            .reduce((sum, p) => sum + p.rowCount, 0);

        return {
            ok: true,
            question,
            sql: result.sql,
            rows: result.rows,
            rowCount: result.rowCount,
            truncated: result.truncated,
            attempts: attempt,
            provenance: {
                tables: tablesTouched(sql, profiles),
                columns: columnsTouched(sql, profiles),
                rowsScanned,
                elapsedMs: Date.now() - started,
            },
            errors: warnings,
        };
    }

    return {
        ...base,
        sql: lastSql,
        attempts: maxAttempts,
        errors,
        provenance: { ...base.provenance, elapsedMs: Date.now() - started },
    };
}

/** The collapsed "how I got this" disclosure, as one compact block. */
export function describeProvenance(result: AskResult): string {
    if (!result.ok || !result.sql) return 'No query was executed.';
    const p = result.provenance;
    return [
        `SQL: ${result.sql}`,
        `Tables: ${p.tables.join(', ') || 'none'}`,
        `Columns: ${p.columns.join(', ') || 'none'}`,
        `Rows scanned: ${p.rowsScanned}`,
        `Attempts: ${result.attempts}`,
        `Elapsed: ${p.elapsedMs}ms`,
    ].join('\n');
}
