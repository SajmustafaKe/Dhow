import { describe, it, expect, beforeEach } from "vitest";
import { vi } from "vitest";
import { NextRequest } from "next/server";
import { Readable } from "node:stream";
import path from "node:path";

/**
 * Characterization tests for `app/api/uploads/[fileId]` (PUT, GET), ahead of
 * the port into apps/dhowx.
 *
 * `dataSourceDocsRepository` is resolved from the DI container at MODULE
 * IMPORT TIME (`route.ts:10`), not inside the handler — `@/di/container`
 * must be mocked before this module is ever imported, which `vi.mock`'s
 * hoisting guarantees for static imports.
 *
 * Two non-obvious pins:
 *  - GET always serves `Content-Type: application/octet-stream`, regardless
 *    of the `mimeType` field stored on the DataSourceDoc — that field is
 *    read from the DB but never used.
 *  - The on-disk path is derived from `doc.data.path.split('/api/uploads/')[1]`.
 *    If the stored path doesn't contain that literal substring, the split
 *    yields `undefined`, `path.join(dir, undefined)` throws a TypeError —
 *    but that throw lands inside the surrounding try/catch, so it degrades
 *    to the ordinary 404 "File not found", not a 500 crash.
 */

const { dataSourceDocsRepositoryMock, writeFileMock, accessMock, createReadStreamMock } = vi.hoisted(() => ({
    dataSourceDocsRepositoryMock: { fetch: vi.fn() },
    writeFileMock: vi.fn(),
    accessMock: vi.fn(),
    createReadStreamMock: vi.fn(),
}));

vi.mock("@/di/container", () => ({
    container: {
        resolve: vi.fn((name: string) => {
            if (name === "dataSourceDocsRepository") return dataSourceDocsRepositoryMock;
            throw new Error(`unexpected container.resolve(${name})`);
        }),
    },
}));

vi.mock("fs/promises", () => ({
    default: { writeFile: writeFileMock, access: accessMock },
    writeFile: writeFileMock,
    access: accessMock,
}));

vi.mock("fs", () => ({
    default: { createReadStream: createReadStreamMock },
    createReadStream: createReadStreamMock,
}));

const { PUT, GET } = await import("./[fileId]/route");

const UPLOADS_DIR = process.env.RAG_UPLOADS_DIR || "/uploads";

beforeEach(() => {
    accessMock.mockResolvedValue(undefined);
});

describe("uploads/[fileId] (PUT)", () => {
    it("400s when fileId resolves to an empty string, without touching the filesystem", async () => {
        const req = new NextRequest("http://localhost/api/uploads/x", { method: "PUT", body: "abc" });
        const res = await PUT(req, { params: Promise.resolve({ fileId: "" }) });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "Missing file ID" });
        expect(writeFileMock).not.toHaveBeenCalled();
    });

    it("writes the raw request body bytes to UPLOADS_DIR/fileId and returns { success: true }", async () => {
        writeFileMock.mockResolvedValue(undefined);
        const req = new NextRequest("http://localhost/api/uploads/x", { method: "PUT", body: "hello-bytes" });
        const res = await PUT(req, { params: Promise.resolve({ fileId: "file-123" }) });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ success: true });
        expect(writeFileMock).toHaveBeenCalledTimes(1);
        const [writtenPath, writtenBytes] = writeFileMock.mock.calls[0];
        expect(writtenPath).toBe(path.join(UPLOADS_DIR, "file-123"));
        expect(Buffer.from(writtenBytes as Uint8Array).toString()).toBe("hello-bytes");
    });

    it("500s with a generic message when writeFile rejects, without leaking the underlying error", async () => {
        writeFileMock.mockRejectedValue(new Error("ENOSPC: no space left on device"));
        const req = new NextRequest("http://localhost/api/uploads/x", { method: "PUT", body: "x" });
        const res = await PUT(req, { params: Promise.resolve({ fileId: "file-123" }) });
        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ error: "Failed to save file" });
    });
});

describe("uploads/[fileId] (GET)", () => {
    it("400s when fileId resolves to an empty string, without querying the repository", async () => {
        const req = new NextRequest("http://localhost/api/uploads/x");
        const res = await GET(req, { params: Promise.resolve({ fileId: "" }) });
        expect(res.status).toBe(400);
        expect(dataSourceDocsRepositoryMock.fetch).not.toHaveBeenCalled();
    });

    it("404s when no DataSourceDoc exists for the id", async () => {
        dataSourceDocsRepositoryMock.fetch.mockResolvedValue(null);
        const req = new NextRequest("http://localhost/api/uploads/x");
        const res = await GET(req, { params: Promise.resolve({ fileId: "missing" }) });
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: "File not found" });
    });

    it("400s when the doc exists but is not a file_local type", async () => {
        dataSourceDocsRepositoryMock.fetch.mockResolvedValue({
            data: { type: "url", url: "https://example.com" },
        });
        const req = new NextRequest("http://localhost/api/uploads/x");
        const res = await GET(req, { params: Promise.resolve({ fileId: "doc-1" }) });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "File is not local" });
    });

    it("streams the file with a hardcoded application/octet-stream Content-Type, ignoring doc.data.mimeType", async () => {
        dataSourceDocsRepositoryMock.fetch.mockResolvedValue({
            data: {
                type: "file_local",
                name: "report.pdf",
                mimeType: "application/pdf",
                path: "/api/uploads/report-uuid",
            },
        });
        createReadStreamMock.mockReturnValue(Readable.from([Buffer.from("pdf-bytes")]));
        const req = new NextRequest("http://localhost/api/uploads/x");
        const res = await GET(req, { params: Promise.resolve({ fileId: "report-uuid" }) });
        expect(res.status).toBe(200);
        expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
        expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="report.pdf"');
        expect(await res.text()).toBe("pdf-bytes");
        expect(createReadStreamMock).toHaveBeenCalledWith(path.join(UPLOADS_DIR, "report-uuid"));
    });

    it("404s (not a crash) when fs.access rejects because the DB record has no matching file on disk", async () => {
        dataSourceDocsRepositoryMock.fetch.mockResolvedValue({
            data: { type: "file_local", name: "x.txt", mimeType: "text/plain", path: "/api/uploads/x-uuid" },
        });
        accessMock.mockRejectedValue(new Error("ENOENT"));
        const req = new NextRequest("http://localhost/api/uploads/x");
        const res = await GET(req, { params: Promise.resolve({ fileId: "x-uuid" }) });
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: "File not found" });
    });

    it("degrades to 404 (not 500) when the stored path lacks '/api/uploads/', so path.join throws inside the try", async () => {
        dataSourceDocsRepositoryMock.fetch.mockResolvedValue({
            data: { type: "file_local", name: "x.txt", mimeType: "text/plain", path: "s3://not-a-local-path" },
        });
        const req = new NextRequest("http://localhost/api/uploads/x");
        const res = await GET(req, { params: Promise.resolve({ fileId: "x-uuid" }) });
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: "File not found" });
        expect(accessMock).not.toHaveBeenCalled();
    });
});
