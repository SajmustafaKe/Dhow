"use client";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import {
  ChevronDownIcon,
  DatabaseIcon,
  LoaderIcon,
  TableIcon,
  TimerIcon,
  AlertTriangleIcon,
  XCircleIcon,
} from "lucide-react";
import { useState } from "react";
import type {
  DataImportCardData,
  DataImportProfile,
  DataProvenanceCardData,
} from "@/lib/chat-conversation";

interface DataImportResultProps {
  data: DataImportCardData;
  status: "pending" | "running" | "completed" | "error";
}

function basenameFromPath(p: string | undefined): string | undefined {
  if (!p) return undefined;
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx >= 0 ? p.slice(idx + 1) : p;
}

function formatNumber(n: number | undefined): string {
  if (n === undefined || n === null) return "—";
  return n.toLocaleString();
}

function ImportProfileRow({ profile }: { profile: DataImportProfile }) {
  return (
    <div className="rounded-md border bg-muted/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <TableIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="font-mono text-sm truncate" title={profile.table}>
            {profile.table}
          </span>
        </div>
        <span className="text-xs text-muted-foreground shrink-0">
          {formatNumber(profile.rowCount)} rows
        </span>
      </div>
      {profile.sourcePath && (
        <p className="mt-1.5 text-xs text-muted-foreground truncate" title={profile.sourcePath}>
          {basenameFromPath(profile.sourcePath)}
        </p>
      )}
      {!!profile.columns?.length && (
        <div className="mt-2 flex flex-wrap gap-1">
          {profile.columns.slice(0, 6).map((col) => (
            <span
              key={col.name}
              className="inline-flex items-center rounded bg-background px-1.5 py-0.5 text-[10px] border"
              title={col.type}
            >
              {col.name}
              <span className="ml-1 text-muted-foreground">{col.type}</span>
            </span>
          ))}
          {profile.columns.length > 6 && (
            <span className="text-[10px] text-muted-foreground px-1">
              +{profile.columns.length - 6} more
            </span>
          )}
        </div>
      )}
      {!!profile.notes?.length && (
        <ul className="mt-2 space-y-0.5 text-[10px] text-muted-foreground">
          {profile.notes.slice(0, 3).map((note, i) => (
            <li key={i} className="flex gap-1.5">
              <span className="text-foreground/60">•</span>
              {note}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function DataImportResult({ data, status }: DataImportResultProps) {
  const [open, setOpen] = useState(false);
  const importedCount = data.imported.length;
  const skippedCount = data.skipped.length;

  if (status === "pending" || status === "running") {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
        <LoaderIcon className="h-4 w-4 animate-spin" />
        Importing data…
      </div>
    );
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border bg-card">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left hover:bg-muted/50 transition-colors"
        >
          <div className="flex items-center gap-2 min-w-0">
            <DatabaseIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="text-sm font-medium">
              {importedCount === 0
                ? "No tables imported"
                : `Imported ${importedCount} table${importedCount !== 1 ? "s" : ""}`}
            </span>
            {skippedCount > 0 && (
              <span className="text-xs text-muted-foreground">
                ({skippedCount} skipped)
              </span>
            )}
          </div>
          <ChevronDownIcon
            className={cn(
              "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-180"
            )}
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="px-3 pb-3">
        <div className="space-y-2">
          {data.imported.map((profile) => (
            <ImportProfileRow key={profile.table} profile={profile} />
          ))}
          {data.skipped.map((s, i) => (
            <div
              key={`skip-${i}`}
              className="flex items-start gap-2 rounded-md border border-dashed p-2 text-xs text-muted-foreground"
            >
              <XCircleIcon className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span>
                {s.sheet ? `Sheet "${s.sheet}"` : "Table"} skipped: {s.reason}
              </span>
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

interface DataProvenanceResultProps {
  data: DataProvenanceCardData;
  status: "pending" | "running" | "completed" | "error";
}

export function DataProvenanceResult({ data, status }: DataProvenanceResultProps) {
  const [open, setOpen] = useState(false);

  if (status === "pending" || status === "running") {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
        <LoaderIcon className="h-4 w-4 animate-spin" />
        Querying data…
      </div>
    );
  }

  const hasDetails = data.sql || data.provenance || data.attempts || data.elapsedMs;

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border bg-card">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left hover:bg-muted/50 transition-colors"
        >
          <div className="flex items-center gap-2 min-w-0">
            <DatabaseIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="text-sm font-medium">
              {data.rowCount !== undefined
                ? `${formatNumber(data.rowCount)} result${data.rowCount !== 1 ? "s" : ""}`
                : "Data result"}
            </span>
            {data.truncated && (
              <span className="text-[10px] text-amber-600 dark:text-amber-400 border border-amber-200 dark:border-amber-800 rounded px-1 py-0">
                truncated
              </span>
            )}
            {data.error && (
              <span className="text-[10px] text-destructive border border-destructive/20 rounded px-1 py-0">
                error
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="text-xs text-muted-foreground">How I got this</span>
            <ChevronDownIcon
              className={cn(
                "h-4 w-4 text-muted-foreground transition-transform",
                open && "rotate-180"
              )}
            />
          </div>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="px-3 pb-3">
        <div className="space-y-2 text-xs">
          {data.error && (
            <div className="rounded-md bg-destructive/10 p-2.5 text-destructive flex gap-2">
              <AlertTriangleIcon className="h-4 w-4 shrink-0" />
              <span className="whitespace-pre-wrap">{data.error}</span>
            </div>
          )}
          {data.sql && (
            <div className="rounded-md border bg-muted/50 overflow-hidden">
              <div className="px-2.5 py-1.5 border-b bg-muted/80 text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                SQL
              </div>
              <pre className="p-2.5 overflow-auto max-h-48 font-mono text-[11px] leading-relaxed">
                {data.sql}
              </pre>
            </div>
          )}
          {data.provenance && (
            <div className="rounded-md border bg-muted/50 p-2.5 whitespace-pre-wrap font-mono text-[11px] leading-relaxed">
              {data.provenance}
            </div>
          )}
          {hasDetails && (
            <div className="flex flex-wrap gap-3 text-[10px] text-muted-foreground">
              {data.elapsedMs !== undefined && (
                <span className="inline-flex items-center gap-1">
                  <TimerIcon className="h-3 w-3" />
                  {data.elapsedMs} ms
                </span>
              )}
              {data.attempts !== undefined && (
                <span>{data.attempts} attempt{data.attempts !== 1 ? "s" : ""}</span>
              )}
            </div>
          )}
          {!hasDetails && !data.error && (
            <span className="text-muted-foreground">No provenance details available.</span>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
