import fs from 'fs/promises';
import path from 'path';
import type { CouncilAttachment } from './types.js';

/**
 * Turn chosen files into text every council member can read.
 *
 * The council is a text-in/text-out surface, so a document has to become
 * characters before it is worth anything here. Two constraints shape this:
 *
 * - Every member receives the *same* text. A cabinet reviewing different
 *   excerpts of a contract is not reviewing the same contract, so truncation
 *   happens once, up front, rather than per member.
 * - A truncated document is labelled as such. A reviewer who believes they
 *   have seen a whole agreement will report on clauses that were never in
 *   front of them.
 */

/**
 * Per-document character ceiling. Deliberately conservative: this text is
 * duplicated into every member's prompt and again into the synthesis, so the
 * real cost is roughly this times the roster size.
 */
export const MAX_ATTACHMENT_CHARS = 24_000;

/** Extensions we can read as text with confidence. */
const TEXT_EXTENSIONS = new Set([
    '.txt', '.md', '.markdown', '.rst', '.log',
    '.json', '.yaml', '.yml', '.toml', '.ini', '.env',
    '.csv', '.tsv',
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.h', '.cpp', '.cs', '.php', '.sh',
    '.html', '.htm', '.xml', '.css', '.scss', '.sql', '.graphql',
]);

export interface ReadAttachmentsResult {
    attachments: CouncilAttachment[];
    errors: { path: string; error: string }[];
}

/**
 * Binary sniff. A PDF or image read as UTF-8 becomes mojibake that looks like
 * content to a model, which is worse than refusing it — the council would
 * confidently review noise.
 */
function looksBinary(buf: Buffer): boolean {
    const sample = buf.subarray(0, 4096);
    if (sample.includes(0)) return true;
    let suspicious = 0;
    for (const byte of sample) {
        // Control characters outside tab/newline/carriage-return.
        if (byte < 9 || (byte > 13 && byte < 32)) suspicious++;
    }
    return suspicious / Math.max(sample.length, 1) > 0.1;
}

export async function readAttachments(paths: string[]): Promise<ReadAttachmentsResult> {
    const attachments: CouncilAttachment[] = [];
    const errors: { path: string; error: string }[] = [];

    for (const filePath of paths) {
        const name = path.basename(filePath);
        try {
            const ext = path.extname(filePath).toLowerCase();
            const buf = await fs.readFile(filePath);

            if (!TEXT_EXTENSIONS.has(ext) && looksBinary(buf)) {
                errors.push({
                    path: filePath,
                    // Named precisely so the user knows what to do instead.
                    error: `${name} is not readable as text. Convert it (e.g. export a PDF to Markdown) and attach that.`,
                });
                continue;
            }

            const raw = buf.toString('utf-8');
            const truncated = raw.length > MAX_ATTACHMENT_CHARS;
            attachments.push({
                name,
                content: truncated ? raw.slice(0, MAX_ATTACHMENT_CHARS) : raw,
                truncated,
            });
        } catch (err) {
            errors.push({ path: filePath, error: err instanceof Error ? err.message : String(err) });
        }
    }

    return { attachments, errors };
}
