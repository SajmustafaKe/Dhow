import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

/**
 * Characterization tests for the MongoDB client bootstrap, ahead of the port
 * into apps/dhowx.
 *
 * `app/lib/mongodb.ts` builds one `MongoClient` at module scope and derives
 * `db` and four named collections from it as top-level constants. There is no
 * `global.__mongoClientPromise` hot-reload guard (the pattern MongoDB's own
 * Next.js docs recommend) — the safety this file relies on is entirely
 * Node's ES-module cache: every file that does `import { db } from
 * "@/app/lib/mongodb"` gets the *same* `db` object, so exactly one client (and
 * one connection pool) exists per running process. That is fine for a
 * long-lived server process and for a warm serverless container reusing its
 * module cache, but it means anything that busts the module cache (dev-mode
 * Fast Refresh reinstantiating the module graph, or a port that turns this
 * into a factory function called per-request) silently multiplies live
 * connections. This suite pins the single-construction behaviour and the
 * fallback connection string so a port that changes either is forced to
 * touch a test deliberately.
 *
 * The real `mongodb` driver is replaced with a spy so no socket is ever
 * opened. Every test below dynamically imports the module under test after
 * setting env and mocking the driver — the module reads `process.env` and
 * constructs its client at import time, exactly like the established pattern
 * in agent-loop.test.ts. This is the "module loading boundary" exception:
 * the whole point of the suite is to exercise import-time construction, so a
 * static top-level import cannot be used here.
 */

describe("app/lib/mongodb.ts", () => {
    const ENV_KEY = "MONGODB_CONNECTION_STRING";
    const originalEnv = process.env[ENV_KEY];

    beforeEach(() => {
        vi.resetModules();
    });

    afterAll(() => {
        if (originalEnv === undefined) delete process.env[ENV_KEY];
        else process.env[ENV_KEY] = originalEnv;
    });

    async function importWithMockedDriver(env: Record<string, string | undefined>) {
        const ctorCalls: string[] = [];
        const dbCalls: string[] = [];
        const collectionCalls: string[] = [];

        const fakeDb = {
            collection: vi.fn((name: string) => {
                collectionCalls.push(name);
                return { __name: name };
            }),
        };

        vi.doMock("mongodb", () => ({
            MongoClient: class {
                constructor(url: string) {
                    ctorCalls.push(url);
                }
                db(name: string) {
                    dbCalls.push(name);
                    return fakeDb;
                }
            },
        }));

        for (const [key, value] of Object.entries(env)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }

        const mod = await import("@/app/lib/mongodb");
        return { mod, ctorCalls, dbCalls, collectionCalls, fakeDb };
    }

    it("falls back to mongodb://localhost:27017 when MONGODB_CONNECTION_STRING is unset", async () => {
        const { ctorCalls } = await importWithMockedDriver({ [ENV_KEY]: undefined });
        expect(ctorCalls).toEqual(["mongodb://localhost:27017"]);
    });

    it("uses MONGODB_CONNECTION_STRING verbatim when set", async () => {
        const { ctorCalls } = await importWithMockedDriver({
            [ENV_KEY]: "mongodb://custom-host:27017/replica?ssl=true",
        });
        expect(ctorCalls).toEqual(["mongodb://custom-host:27017/replica?ssl=true"]);
    });

    it("constructs exactly one MongoClient for the whole module, shared by every collection", async () => {
        const { ctorCalls, collectionCalls } = await importWithMockedDriver({});
        // Four collections are exported, all derived from the same client/db.
        expect(collectionCalls.sort()).toEqual(
            ["chat_messages", "chats", "twilio_configs", "twilio_inbound_calls"].sort(),
        );
        expect(ctorCalls).toHaveLength(1);
    });

    it("re-importing the module returns the identical db reference (module-cache singleton)", async () => {
        const { mod: first } = await importWithMockedDriver({});
        // No vi.resetModules() between these two imports: this is what every
        // repository file relies on to share one client across the app.
        const second = await import("@/app/lib/mongodb");
        expect(second.db).toBe(first.db);
    });

    it("opens the 'dhow' database by name", async () => {
        const { dbCalls } = await importWithMockedDriver({});
        expect(dbCalls).toEqual(["dhow"]);
    });
});
