// Builtin tools: parsing domain. Entries moved VERBATIM from the historical
// monolith — the merge order in ../builtin-tools.ts preserves the original
// catalog key order (provider-payload bytes; see the key-order test there).

import { z } from "zod";
import * as path from "path";
import * as files from "../../../filesystem/files.js";
import { BuiltinToolsSchema } from "../types.js";
import { capLines, capRows, TABULAR_HINT } from "./parsing-caps.js";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import mammoth from "mammoth";



// pdf-parse ALONE is loaded through a computed path, so esbuild cannot pull
// pdfjs-dist's DOM polyfills into the main bundle.
//
// papaparse, xlsx and mammoth used to go the same way, and that was a bug:
// forge.config.cjs strips /^\/node_modules\// from the packaged app, bundle.mjs
// stages only the native modules, and a dynamic import esbuild cannot resolve
// is not inlined either. So in a packaged build those three simply were not
// there and every CSV, spreadsheet and Word drop failed with "Cannot find
// module". They are pure JS with no polyfill problem, so they are static now
// and get inlined. pdf-parse keeps the trick and is staged by bundle.mjs.
const _importDynamic = new Function('mod', 'return import(mod)') as (
    mod: string,
) => Promise<unknown>;

type PdfParseModule = {
    PDFParse: new (opts: { data: Uint8Array }) => {
        getText(): Promise<{ text: string; total: number }>;
        getInfo(): Promise<{ info?: { Title?: string; Author?: string } }>;
        destroy(): Promise<void>;
    };
};

const LLMPARSE_MIME_TYPES: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.doc': 'application/msword',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.xls': 'application/vnd.ms-excel',
    '.csv': 'text/csv',
    '.txt': 'text/plain',
    '.html': 'text/html',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.bmp': 'image/bmp',
    '.tiff': 'image/tiff',
};

export const parsingTools: z.infer<typeof BuiltinToolsSchema> = {
    'parseFile': {
        permission: "file-boundary",
        description: 'Parse and extract text content from files (PDF, Excel, CSV, Word .docx). Auto-detects format from file extension.',
        inputSchema: z.object({
            path: z.string().min(1).describe('File path to parse. Can be absolute, ~/..., or relative to the default root.'),
        }),
        execute: async ({ path: filePath }: { path: string }) => {
            try {
                const fileName = path.basename(filePath);
                const ext = path.extname(filePath).toLowerCase();
                const supportedExts = ['.pdf', '.xlsx', '.xls', '.csv', '.docx'];

                if (!supportedExts.includes(ext)) {
                    return {
                        success: false,
                        error: `Unsupported file format '${ext}'. Supported formats: ${supportedExts.join(', ')}`,
                    };
                }

                const { buffer, resolvedPath } = await files.readBuffer(filePath);

                if (ext === '.pdf') {
                    const { PDFParse } = (await _importDynamic("pdf-parse")) as PdfParseModule;
                    const parser = new PDFParse({ data: new Uint8Array(buffer) });
                    try {
                        const textResult = await parser.getText();
                        const infoResult = await parser.getInfo();
                        return {
                            success: true,
                            fileName,
                            format: 'pdf',
                            content: textResult.text,
                            metadata: {
                                pages: textResult.total,
                                title: infoResult.info?.Title || undefined,
                                author: infoResult.info?.Author || undefined,
                                resolvedPath,
                            },
                        };
                    } finally {
                        await parser.destroy();
                    }
                }

                if (ext === '.xlsx' || ext === '.xls') {
                    const workbook = XLSX.read(buffer, { type: 'buffer' });
                    const sheets: Record<string, string> = {};
                    let anyTruncated = false;
                    for (const sheetName of workbook.SheetNames) {
                        const sheet = workbook.Sheets[sheetName];
                        const csv = XLSX.utils.sheet_to_csv(sheet);
                        const capped = capLines(csv);
                        if (capped.truncated) anyTruncated = true;
                        sheets[sheetName] = capped.text;
                    }
                    const joined = capLines(Object.values(sheets).join('\n\n'));
                    return {
                        success: true,
                        fileName,
                        format: ext === '.xlsx' ? 'xlsx' : 'xls',
                        content: joined.text,
                        metadata: {
                            sheetNames: workbook.SheetNames,
                            sheetCount: workbook.SheetNames.length,
                        },
                        sheets,
                        ...(anyTruncated || joined.truncated
                            ? { truncated: true, hint: TABULAR_HINT }
                            : {}),
                    };
                }

                if (ext === '.csv') {
                    const text = buffer.toString('utf8');
                    const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
                    const cappedRows = capRows(parsed.data);
                    const capped = capLines(text);
                    const truncated = cappedRows.truncated || capped.truncated;
                    return {
                        success: true,
                        fileName,
                        format: 'csv',
                        content: capped.text,
                        metadata: {
                            rowCount: cappedRows.totalRows,
                            headers: parsed.meta.fields || [],
                        },
                        data: cappedRows.rows,
                        ...(truncated
                            ? { truncated: true, totalRows: cappedRows.totalRows, hint: TABULAR_HINT }
                            : {}),
                    };
                }

                if (ext === '.docx') {
                    const docResult = await mammoth.extractRawText({ buffer });
                    return {
                        success: true,
                        fileName,
                        format: 'docx',
                        content: docResult.value,
                    };
                }

                return { success: false, error: 'Unexpected error' };
            } catch (error) {
                return {
                    success: false,
                    error: error instanceof Error ? error.message : 'Unknown error',
                };
            }
        },
    },

    'LLMParse': {
        permission: "file-boundary",
        description: 'Send a file to the configured LLM as a multimodal attachment and ask it to extract content as markdown. Best for scanned PDFs, images with text, complex layouts, or any format where local parsing falls short. Supports documents (PDF, Word, Excel, PowerPoint, CSV, TXT, HTML) and images (PNG, JPG, GIF, WebP, SVG, BMP, TIFF).',
        inputSchema: z.object({
            path: z.string().min(1).describe('File path to parse. Can be absolute, ~/..., or relative to the default root.'),
            prompt: z.string().optional().describe('Custom instruction for the LLM (defaults to "Convert this file to well-structured markdown.")'),
        }),
        execute: async ({ path: filePath, prompt }: { path: string; prompt?: string }) => {
            try {
                // Imported lazily: models/defaults.js pulls in the DI container,
                // which transitively reaches this catalog. Importing it at module
                // scope makes parsing.ts un-importable on its own ("Cannot access
                // 'parsingTools' before initialization") and blocks it under a
                // test runner. Only LLMParse needs the provider stack.
                const { generateText } = await import("ai");
                const { createLanguageModel } = await import("../../../models/models.js");
                const { getDefaultModelAndProvider, resolveProviderConfig } = await import(
                    "../../../models/defaults.js"
                );
                const { getCurrentUseCase, withUseCase } = await import(
                    "../../../analytics/use_case.js"
                );

                const fileName = path.basename(filePath);
                const ext = path.extname(filePath).toLowerCase();
                const mimeType = LLMPARSE_MIME_TYPES[ext];

                if (!mimeType) {
                    return {
                        success: false,
                        error: `Unsupported file format '${ext}'. Supported formats: ${Object.keys(LLMPARSE_MIME_TYPES).join(', ')}`,
                    };
                }

                const { buffer } = await files.readBuffer(filePath);

                const base64 = buffer.toString('base64');

                const { model: modelId, provider: providerName } = await getDefaultModelAndProvider();
                const providerConfig = await resolveProviderConfig(providerName);
                const model = createLanguageModel(providerConfig, modelId);

                const userPrompt = prompt || 'Convert this file to well-structured markdown.';

                const ctx = getCurrentUseCase();
                const response = await withUseCase({
                    useCase: ctx?.useCase ?? 'copilot_chat',
                    subUseCase: 'file_parse',
                    ...(ctx?.agentName ? { agentName: ctx.agentName } : {}),
                }, () => generateText({
                    model,
                    messages: [
                        {
                            role: 'user',
                            content: [
                                { type: 'text', text: userPrompt },
                                { type: 'file', data: base64, mediaType: mimeType },
                            ],
                        },
                    ],
                }));

                return {
                    success: true,
                    fileName,
                    format: ext.slice(1),
                    mimeType,
                    content: response.text,
                    usage: response.usage,
                };
            } catch (error) {
                return {
                    success: false,
                    error: error instanceof Error ? error.message : 'Unknown error',
                };
            }
        },
    },
};
