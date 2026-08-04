import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

/**
 * Characterization tests for the Qdrant client bootstrap, ahead of the port
 * into apps/dhowx.
 *
 * `app/lib/qdrant.ts` builds one `QdrantClient` at module scope, same
 * singleton-via-module-cache shape as mongodb.ts and redis.ts. The one
 * behaviour worth pinning here that isn't obvious from reading the file: the
 * `apiKey` option is spread in *conditionally* — when `QDRANT_API_KEY` is
 * unset, the options object has no `apiKey` key at all (not `apiKey:
 * undefined`). A port that "simplifies" this to
 * `{ url, apiKey: process.env.QDRANT_API_KEY }` looks equivalent but is not:
 * some HTTP clients treat an explicitly-present-but-undefined key differently
 * from an absent one when serializing headers.
 *
 * `QDRANT_URL` has no fallback at all (unlike mongodb.ts's
 * "mongodb://localhost:27017" or redis.ts's `''`) — an unset env var reaches
 * the driver as `url: undefined`, whatever the driver does with that is
 * entirely on it.
 */

describe("app/lib/qdrant.ts", () => {
    const URL_KEY = "QDRANT_URL";
    const API_KEY_KEY = "QDRANT_API_KEY";
    const originalUrl = process.env[URL_KEY];
    const originalApiKey = process.env[API_KEY_KEY];

    beforeEach(() => {
        vi.resetModules();
    });

    afterAll(() => {
        if (originalUrl === undefined) delete process.env[URL_KEY];
        else process.env[URL_KEY] = originalUrl;
        if (originalApiKey === undefined) delete process.env[API_KEY_KEY];
        else process.env[API_KEY_KEY] = originalApiKey;
    });

    async function importWithMockedDriver(env: Record<string, string | undefined>) {
        const ctorCalls: Record<string, unknown>[] = [];

        vi.doMock("@qdrant/js-client-rest", () => ({
            QdrantClient: class {
                constructor(opts: Record<string, unknown>) {
                    ctorCalls.push(opts);
                }
            },
        }));

        for (const [key, value] of Object.entries(env)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }

        await import("@/app/lib/qdrant");
        return { ctorCalls };
    }

    it("passes url:undefined through when QDRANT_URL is unset — no localhost fallback", async () => {
        const { ctorCalls } = await importWithMockedDriver({ [URL_KEY]: undefined, [API_KEY_KEY]: undefined });
        expect(ctorCalls[0].url).toBeUndefined();
    });

    it("omits the apiKey property entirely when QDRANT_API_KEY is unset", async () => {
        const { ctorCalls } = await importWithMockedDriver({
            [URL_KEY]: "http://localhost:6333",
            [API_KEY_KEY]: undefined,
        });
        expect(Object.prototype.hasOwnProperty.call(ctorCalls[0], "apiKey")).toBe(false);
    });

    it("includes apiKey when QDRANT_API_KEY is set", async () => {
        const { ctorCalls } = await importWithMockedDriver({
            [URL_KEY]: "http://localhost:6333",
            [API_KEY_KEY]: "secret-key",
        });
        expect(ctorCalls[0]).toEqual({ url: "http://localhost:6333", apiKey: "secret-key" });
    });

    it("constructs exactly one client for the whole module", async () => {
        const { ctorCalls } = await importWithMockedDriver({});
        expect(ctorCalls).toHaveLength(1);
    });
});
