// Caps on what a tabular parse may push into the model's context.
//
// Before these, parseFile's CSV branch returned the ENTIRE raw text plus EVERY
// parsed row, and the XLSX branch concatenated every sheet. A 50 MB export did
// not get analyzed, it detonated the context window. Data Mode's premise is
// that big tables get imported and QUERIED rather than pasted, so parseFile
// returns a readable sample and points at that path instead.
//
// This lives in its own module so it can be unit tested: importing parsing.ts
// pulls in the model-provider chain, which does blocking work at load time.

export const MAX_TOOL_ROWS = 50;
export const MAX_TOOL_LINES = 200;

export const TABULAR_HINT =
    'Output truncated. This file is tabular: import it with the data tools and query it ' +
    'with SQL instead of reading rows into context. Load the "data-analysis" skill.';

export function capLines(text: string): { text: string; truncated: boolean } {
    const lines = text.split('\n');
    if (lines.length <= MAX_TOOL_LINES) return { text, truncated: false };
    return {
        text:
            lines.slice(0, MAX_TOOL_LINES).join('\n') +
            `\n... [${lines.length - MAX_TOOL_LINES} more line(s) omitted]`,
        truncated: true,
    };
}

/** Cap a parsed row array, reporting the true total so the model is not misled. */
export function capRows<T>(rows: T[]): { rows: T[]; truncated: boolean; totalRows: number } {
    if (rows.length <= MAX_TOOL_ROWS) {
        return { rows, truncated: false, totalRows: rows.length };
    }
    return { rows: rows.slice(0, MAX_TOOL_ROWS), truncated: true, totalRows: rows.length };
}
