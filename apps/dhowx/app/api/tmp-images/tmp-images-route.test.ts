import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./[id]/route";
import { tempBinaryCache } from "@/src/application/services/temp-binary-cache";

/**
 * Characterization tests for `app/api/tmp-images/[id]` (GET), ahead of the
 * port into apps/dhowx.
 *
 * `tempBinaryCache` is a real in-process Map-backed singleton — no network,
 * so it is used directly rather than mocked. Pins: the missing-id 400, the
 * cache-miss 404 (both "not found" and "expired" collapse to the same 404
 * body, indistinguishable to the caller), and the success header set
 * (Content-Type from the stored mimeType, inline Content-Disposition using
 * the raw `id` as filename with no extension normalization, Cache-Control
 * no-store).
 */

const req = (url: string) => new NextRequest(url);

describe("tmp-images/[id] (GET)", () => {
    it("400s when id resolves to an empty string", async () => {
        const res = await GET(req("http://localhost/api/tmp-images/x"), { params: Promise.resolve({ id: "" }) });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "Missing id" });
    });

    it("404s for an id that was never cached", async () => {
        const res = await GET(req("http://localhost/api/tmp-images/x"), {
            params: Promise.resolve({ id: "never-put-this-id" }),
        });
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: "Not found or expired" });
    });

    it("404s for an id whose entry has already expired (ttl elapsed)", async () => {
        const id = tempBinaryCache.put(Buffer.from("hello"), "text/plain", -1);
        const res = await GET(req("http://localhost/api/tmp-images/x"), { params: Promise.resolve({ id }) });
        expect(res.status).toBe(404);
    });

    it("200s with the cached buffer's bytes and mimeType, and an inline Content-Disposition using the raw id", async () => {
        const id = tempBinaryCache.put(Buffer.from("png-bytes"), "image/png");
        const res = await GET(req("http://localhost/api/tmp-images/x"), { params: Promise.resolve({ id }) });
        expect(res.status).toBe(200);
        expect(res.headers.get("Content-Type")).toBe("image/png");
        expect(res.headers.get("Cache-Control")).toBe("no-store");
        expect(res.headers.get("Content-Disposition")).toBe(`inline; filename="${id}"`);
        expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("png-bytes");
    });

    it("falls back to application/octet-stream when no mimeType was stored", async () => {
        const id = tempBinaryCache.put(Buffer.from("bytes"), "");
        const res = await GET(req("http://localhost/api/tmp-images/x"), { params: Promise.resolve({ id }) });
        expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    });
});
