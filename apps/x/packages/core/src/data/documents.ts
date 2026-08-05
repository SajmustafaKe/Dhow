// Document to markdown conversion, filling the gaps around parseFile.
//
// MarkItDown is not an option in JS: @microsoft/markitdown does not exist on
// npm, the `markitdown` package is an unrelated 2012 pandoc wrapper, and
// markitdown-ts is a single-maintainer port at v0.0.10. MarkItDown is anyway
// just a dispatcher over parsers this app already ships (pdf-parse, xlsx,
// mammoth, papaparse). The genuine gaps are pptx, odt/ods/odp, and HTML, so
// this module fills exactly those and reuses what exists for the rest.

import fs from 'node:fs';
import path from 'node:path';

export type DocText = {
    format: string;
    markdown: string;
    pages?: number;
    notes: string[];
};

const OFFICE_EXTS = new Set(['.pptx', '.odt', '.ods', '.odp', '.ppt']);
const HTML_EXTS = new Set(['.html', '.htm', '.xhtml']);
const PLAIN_EXTS = new Set(['.md', '.markdown', '.txt', '.text', '.log']);

export function supportedDocumentExtensions(): string[] {
    return [...OFFICE_EXTS, ...HTML_EXTS, ...PLAIN_EXTS, '.pdf', '.docx'].sort();
}

export function isSupportedDocument(p: string): boolean {
    return supportedDocumentExtensions().includes(path.extname(p).toLowerCase());
}

/**
 * Convert a document to markdown.
 *
 * Returns an error-shaped DocText rather than throwing for an unsupported
 * extension, because this sits behind a tool boundary where a thrown error is
 * a worse experience than a clear message.
 */
export async function toMarkdown(absPath: string): Promise<DocText> {
    const ext = path.extname(absPath).toLowerCase();
    const notes: string[] = [];

    if (!fs.existsSync(absPath)) {
        return { format: ext.slice(1) || 'unknown', markdown: '', notes: [`No such file: ${absPath}`] };
    }

    if (PLAIN_EXTS.has(ext)) {
        return { format: ext.slice(1), markdown: fs.readFileSync(absPath, 'utf8'), notes };
    }

    if (HTML_EXTS.has(ext)) {
        const TurndownService = (await import('turndown')).default;
        const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
        const html = fs.readFileSync(absPath, 'utf8');
        return { format: 'html', markdown: turndown.turndown(html), notes };
    }

    if (OFFICE_EXTS.has(ext)) {
        const { parseOffice } = await import('officeparser');
        // v7 returns a content AST rather than a string; toText() is its own
        // plain-text projection, which is what we want to hand a model.
        const ast = await parseOffice(absPath);
        notes.push('Converted with officeparser; layout and styling are not preserved.');
        return { format: ext.slice(1), markdown: ast.toText(), notes };
    }

    if (ext === '.docx') {
        const mammoth = (await import('mammoth')).default;
        const result = await mammoth.extractRawText({ path: absPath });
        return { format: 'docx', markdown: result.value, notes };
    }

    if (ext === '.pdf') {
        const { PDFParse } = await import('pdf-parse');
        const parser = new PDFParse({ data: new Uint8Array(fs.readFileSync(absPath)) });
        try {
            const textResult = await parser.getText();
            if (!textResult.text.trim()) {
                notes.push('This PDF has no text layer; it needs OCR.');
            }
            return {
                format: 'pdf',
                markdown: textResult.text,
                pages: textResult.total,
                notes,
            };
        } finally {
            await parser.destroy();
        }
    }

    return {
        format: ext.slice(1) || 'unknown',
        markdown: '',
        notes: [
            `Unsupported document format "${ext || '(none)'}". Supported: ${supportedDocumentExtensions().join(', ')}.`,
        ],
    };
}

/** True when the conversion produced nothing usable and OCR is the next step. */
export function needsOcr(doc: DocText): boolean {
    return doc.markdown.trim().length === 0 && doc.notes.some((n) => /ocr/i.test(n));
}
