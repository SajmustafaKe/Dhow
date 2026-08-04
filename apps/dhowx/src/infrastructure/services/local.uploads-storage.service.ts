import { IDataSourceDocsRepository } from "@/src/application/repositories/data-source-docs.repository.interface";
import { IUploadsStorageService } from "@/src/application/services/uploads-storage.service.interface";
import fs from "fs";
import path from "path";
import { NotFoundError } from "@/src/entities/errors/common";

const UPLOADS_DIR = process.env.RAG_UPLOADS_DIR || '/uploads';

export class LocalUploadsStorageService implements IUploadsStorageService {
    private readonly dataSourceDocsRepository: IDataSourceDocsRepository;

    constructor({
        dataSourceDocsRepository,
    }: {
        dataSourceDocsRepository: IDataSourceDocsRepository,
    }) {
        this.dataSourceDocsRepository = dataSourceDocsRepository;
    }

    async getUploadUrl(key: string): Promise<string> {
        return `/api/uploads/${key}`;
    }

    async getDownloadUrl(fileId: string): Promise<string> {
        return `/api/uploads/${fileId}`;
    }

    async getFileContents(fileId: string): Promise<Buffer> {
        const file = await this.dataSourceDocsRepository.fetch(fileId);
        if (!file) {
            throw new NotFoundError('File not found');
        }
        if (file.data.type !== 'file_local') {
            throw new NotFoundError('File is not a local file');
        }

        // `path` is caller-supplied: app/actions/data-source.actions.ts accepts a
        // `file_local.path` from any authenticated project member and the docs
        // repository stores it verbatim. Absent the separator, split() yields
        // undefined and path.join throws a raw TypeError.
        const relativePath = file.data.path.split('/api/uploads/')[1];
        if (!relativePath) {
            throw new NotFoundError('File is not a local file');
        }

        return fs.readFileSync(resolveInsideUploads(relativePath));
    }
}

/**
 * Resolve a stored upload path and refuse anything that escapes UPLOADS_DIR.
 *
 * `path.join('/uploads', '../../etc/passwd')` normalises to `/etc/passwd`, so
 * joining alone is not containment. Every authenticated project member could
 * previously read any file the process could read.
 *
 * The lexical check uses path.relative rather than startsWith: a prefix test
 * would also accept a sibling directory like `/uploads-evil`. The realpath
 * check then covers a symlink planted inside the uploads directory, which
 * satisfies the lexical test while pointing outside.
 */
function resolveInsideUploads(relativePath: string): string {
    const root = path.resolve(UPLOADS_DIR);
    const resolved = path.resolve(root, relativePath);

    if (!isInside(root, resolved)) {
        throw new NotFoundError('File not found');
    }

    // Compare real paths too. Both sides are realpath'd because the root itself
    // may reach the filesystem through a symlink (on macOS /var -> /private/var),
    // and comparing a resolved child against an unresolved root never matches.
    let realRoot: string;
    let realResolved: string;
    try {
        realRoot = fs.realpathSync(root);
        realResolved = fs.realpathSync(resolved);
    } catch {
        // Either does not exist yet. The lexical check above already passed, and
        // the read below will raise its own ENOENT.
        return resolved;
    }

    if (!isInside(realRoot, realResolved)) {
        throw new NotFoundError('File not found');
    }

    return resolved;
}

function isInside(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}