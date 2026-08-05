// OCR with a platform-appropriate engine and an LLM escape hatch.
//
// Plan decision D6:
//   macOS        -> Apple Vision via the compiled native/ocr.swift helper.
//                   On device, no network, ~1.05 s per page warm, 30 languages,
//                   72 KB binary, and it returns bounding boxes.
//   win32/linux  -> tesseract.js (WASM, no native build, works offline).
//   either       -> escalate to LLMParse when mean confidence drops below 0.8.
//
// Both engines are normalized to ONE coordinate system: normalized 0..1 with a
// BOTTOM-left origin, which is Vision's convention. Tesseract reports
// top-left pixels, so it is converted here rather than at every call site.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OcrLine } from './table-from-boxes.js';

export type { OcrLine };

export type OcrResult = {
    lines: OcrLine[];
    engine: 'vision' | 'tesseract';
    meanConfidence: number;
    ms: number;
    pages: number;
    notes: string[];
};

/** Below this, the page is probably a bad scan and an LLM will do better. */
export const ESCALATION_THRESHOLD = 0.8;

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.tif']);

export function isOcrCandidate(p: string): boolean {
    const ext = path.extname(p).toLowerCase();
    return ext === '.pdf' || IMAGE_EXTS.has(ext);
}

/**
 * Locate the compiled Vision helper.
 *
 * bundle.mjs stages it next to the bundled main process, so in a packaged app
 * it sits beside main.cjs. In dev it is built into apps/main/.package/dist.
 * DHOW_OCR_BIN overrides both, which is also how tests point at a fixture.
 */
export function resolveVisionBinary(): string | null {
    if (process.platform !== 'darwin') return null;
    const fromEnv = process.env.DHOW_OCR_BIN;
    if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
        // Packaged: alongside the esbuild bundle.
        path.join(path.dirname(process.execPath), '..', 'Resources', 'app', 'dist', 'ocr'),
        path.join(path.dirname(process.execPath), 'dist', 'ocr'),
        // Dev: the staging directory bundle.mjs writes into.
        path.join(here, '..', '..', '..', '..', 'apps', 'main', '.package', 'dist', 'ocr'),
    ];
    for (const candidate of candidates) {
        try {
            if (fs.existsSync(candidate)) return candidate;
        } catch {
            // Unreadable path; try the next candidate.
        }
    }
    return null;
}

/**
 * Locate the local tesseract.js language data.
 *
 * tesseract.js defaults to downloading eng.traineddata from a CDN. That is
 * fine in dev, but the packaged app must be offline-capable. bundle.mjs
 * stages the gzipped traineddata into .package/tesseract-langs/.
 */
export function resolveTesseractLangPath(): string | null {
    const fromEnv = process.env.DHOW_TESSERACT_LANG;
    if (fromEnv) {
        if (fs.existsSync(path.join(fromEnv, 'eng.traineddata.gz'))) return fromEnv;
        return null;
    }

    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
        // Packaged: inside the app bundle.
        path.join(path.dirname(process.execPath), '..', 'Resources', 'app', 'tesseract-langs'),
        path.join(path.dirname(process.execPath), 'tesseract-langs'),
        // Dev.
        path.join(here, '..', '..', '..', '..', 'apps', 'main', '.package', 'tesseract-langs'),
    ];
    for (const candidate of candidates) {
        try {
            if (fs.existsSync(path.join(candidate, 'eng.traineddata.gz'))) return candidate;
        } catch {
            // Unreadable path; try the next candidate.
        }
    }
    return null;
}

type MetaLine = { __meta: { ms: number; lineCount: number; pages: number; engine: string } };

function isMetaLine(v: unknown): v is MetaLine {
    return !!v && typeof v === 'object' && '__meta' in v;
}

async function runVision(binary: string, absPath: string): Promise<OcrResult> {
    const started = Date.now();
    const stdout = await new Promise<string>((resolve, reject) => {
        const child = spawn(binary, [absPath], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        child.stdout.on('data', (chunk: Buffer) => {
            out += chunk.toString('utf8');
        });
        child.stderr.on('data', (chunk: Buffer) => {
            err += chunk.toString('utf8');
        });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) resolve(out);
            else reject(new Error(err.trim() || `ocr helper exited ${code}`));
        });
    });

    const lines: OcrLine[] = [];
    let pages = 1;
    let ms = Date.now() - started;
    for (const raw of stdout.split('\n')) {
        const text = raw.trim();
        if (!text) continue;
        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch {
            continue;
        }
        if (isMetaLine(parsed)) {
            pages = parsed.__meta.pages ?? 1;
            ms = parsed.__meta.ms ?? ms;
            continue;
        }
        lines.push(parsed as OcrLine);
    }

    return {
        lines,
        engine: 'vision',
        meanConfidence: meanConfidenceOf(lines),
        ms,
        pages,
        notes: [],
    };
}

type TesseractWord = {
    text: string;
    confidence: number;
    bbox: { x0: number; y0: number; x1: number; y1: number };
};

async function runTesseract(absPath: string): Promise<OcrResult> {
    const started = Date.now();
    const { createWorker } = await import('tesseract.js');
    const langPath = resolveTesseractLangPath();
    const worker = await createWorker('eng', undefined, langPath ? { langPath } : {});
    try {
        const { data } = await worker.recognize(absPath, {}, { blocks: true });

        const words: TesseractWord[] = [];
        for (const block of data.blocks ?? []) {
            for (const paragraph of block.paragraphs ?? []) {
                for (const textLine of paragraph.lines ?? []) {
                    words.push({
                        text: textLine.text.trim(),
                        confidence: textLine.confidence / 100,
                        bbox: textLine.bbox,
                    });
                }
            }
        }

        // tesseract.js does not expose page dimensions on its Page type, so
        // derive the extents from the boxes themselves. That is also more
        // robust than trusting an undocumented field across versions.
        const pageWidth = Math.max(1, ...words.map((w) => w.bbox.x1));
        const pageHeight = Math.max(1, ...words.map((w) => w.bbox.y1));

        const lines: OcrLine[] = words
            .filter((w) => w.text.length > 0)
            .map((w) => ({
                text: w.text,
                confidence: w.confidence,
                // Tesseract is top-left pixels; Vision is bottom-left
                // normalized. Convert so downstream code has one convention.
                x: w.bbox.x0 / pageWidth,
                y: 1 - w.bbox.y1 / pageHeight,
                w: (w.bbox.x1 - w.bbox.x0) / pageWidth,
                h: (w.bbox.y1 - w.bbox.y0) / pageHeight,
                page: 0,
            }));

        return {
            lines,
            engine: 'tesseract',
            meanConfidence: meanConfidenceOf(lines),
            ms: Date.now() - started,
            pages: 1,
            notes: [],
        };
    } finally {
        await worker.terminate();
    }
}

function meanConfidenceOf(lines: OcrLine[]): number {
    if (!lines.length) return 0;
    return lines.reduce((sum, l) => sum + (Number.isFinite(l.confidence) ? l.confidence : 0), 0) / lines.length;
}

export type OcrOptions = { engine?: 'vision' | 'tesseract' | 'best' };

/** OCR a file with the best engine available on this platform. */
export async function ocrFile(absPath: string, options: OcrOptions = {}): Promise<OcrResult> {
    if (!fs.existsSync(absPath)) throw new Error(`No such file: ${absPath}`);

    const prefer = options.engine ?? 'best';
    const vision = prefer !== 'tesseract' ? resolveVisionBinary() : null;
    if (vision) {
        try {
            return await runVision(vision, absPath);
        } catch (err) {
            if (prefer === 'vision') throw err;
            // A missing or broken helper must degrade, not fail the drop.
            const note = `Vision OCR failed (${err instanceof Error ? err.message : String(err)}); used tesseract.`;
            const fallback = await runTesseract(absPath);
            fallback.notes.push(note);
            return fallback;
        }
    }
    return runTesseract(absPath);
}

/**
 * True when the result is too uncertain to trust and the caller should hand
 * the file to a multimodal model instead. Empty output also escalates: zero
 * lines from a document that clearly has text is a failure, not a blank page.
 */
export function shouldEscalateToLLM(r: OcrResult): boolean {
    if (r.lines.length === 0) return true;
    return r.meanConfidence < ESCALATION_THRESHOLD;
}
