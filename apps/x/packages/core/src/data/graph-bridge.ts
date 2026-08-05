/**
 * Bridge imported Data Mode tables into the Obsidian-style brain graph.
 *
 * Tables are materialized as markdown notes under `knowledge/Data/`. They are
 * indexed as "other" notes by buildKnowledgeIndex(), so the model can find
 * them by name, column, or source file when answering later questions.
 */

import fs from "node:fs";
import path from "node:path";
import { WorkDir } from "../config/config.js";
import { invalidateKnowledgeIndex } from "../knowledge/knowledge_index.js";
import type { TableProfile } from "./types.js";

const DATA_NOTES_DIR = path.join(WorkDir, "knowledge", "Data");

function sanitizeFilename(name: string): string {
    return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "table";
}

function escapeMdCell(v: unknown): string {
    const s = String(v ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
    return s.length > 40 ? s.slice(0, 37) + "..." : s;
}

function renderNote(profile: TableProfile): string {
    const sourceName = path.basename(profile.sourcePath);
    const colNames = profile.columns.map((c) => c.name);
    const colHeader = colNames.join(" | ");
    const colDashes = colNames.map(() => "---").join(" | ");

    const schemaRows = profile.columns
        .map(
            (c) =>
                `| ${escapeMdCell(c.name)} | ${escapeMdCell(c.type)} | ${c.nullPct.toFixed(0)}% | ${c.sample.map(escapeMdCell).join(", ")} |`,
        )
        .join("\n");

    const sampleRows = profile.columns[0]?.sample.length
        ? profile.columns[0].sample
              .map((_, i) => `| ${profile.columns.map((c) => escapeMdCell(c.sample[i])).join(" | ")} |`)
              .join("\n")
        : "_No sample rows available._";

    const notes = profile.notes.length ? profile.notes.map((n) => `- ${n}`).join("\n") : "_No inference notes._";

    return `---
type: data-table
source: ${sourceName}
source_path: ${profile.sourcePath}
source_kind: ${profile.sourceKind}
sheet: ${profile.sheet ?? ""}
table: ${profile.table}
rows: ${profile.rowCount}
columns: ${profile.columns.length}
imported_at: ${profile.importedAt}
---

# ${profile.table}

Imported from \`${sourceName}\` on ${new Date(profile.importedAt).toLocaleDateString()}.

## Schema

| Column | Type | Null % | Sample values |
| --- | --- | --- | --- |
${schemaRows}

## Sample rows

| ${colHeader} |
| ${colDashes} |
${sampleRows}

## Inference notes

${notes}
`;
}

/**
 * Write or update a markdown note for an imported table and invalidate the
 * cached knowledge index so the next query sees it.
 */
export function writeTableNote(profile: TableProfile): string {
    fs.mkdirSync(DATA_NOTES_DIR, { recursive: true });
    const fileName = `${sanitizeFilename(profile.table)}.md`;
    const notePath = path.join(DATA_NOTES_DIR, fileName);
    fs.writeFileSync(notePath, renderNote(profile), "utf8");
    invalidateKnowledgeIndex();
    return notePath;
}

/**
 * Remove a table note, e.g. when a table is explicitly dropped by the user.
 */
export function removeTableNote(tableName: string): void {
    const notePath = path.join(DATA_NOTES_DIR, `${sanitizeFilename(tableName)}.md`);
    if (fs.existsSync(notePath)) {
        fs.unlinkSync(notePath);
        invalidateKnowledgeIndex();
    }
}
