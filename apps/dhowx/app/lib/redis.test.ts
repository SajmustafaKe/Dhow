import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

/**
 * Characterization tests for the ioredis client bootstrap, ahead of the port
 * into apps/dhowx.
 *
 * `app/lib/redis.ts` builds one `Redis` instance at module scope from
 * `process.env.REDIS_URL || ''`. Unlike mongodb.ts, there is no explicit
 * `localhost` fallback string — when REDIS_URL is unset the driver receives
 * a literal empty string. Reading ioredis's own `parseURL`
 * (node_modules/ioredis/built/utils/index.js:199), an empty string produces
 * no `host`/`port` in the parsed result, so ioredis's *own* defaults
 * (127.0.0.1:6379) apply — the effect is the same as calling `new Redis()`,
 * but arrived at accidentally through a falsy-string fallback rather than a
 * declared default. This suite pins the argument that actually reaches the
 * driver, not what it deep down resolves to (that's ioredis's contract, not
 * this file's).
 *
 * Every consuming module in src/infrastructure (redis.cache.service,
 * redis.pub-sub.service, redis.usage-quota.policy) imports the same
 * `redisClient` singleton from here, so the "one client, module-cache
 * scoped" pin matters for every one of them.
 */

describe("app/lib/redis.ts", () => {
    const ENV_KEY = "REDIS_URL";
    const originalEnv = process.env[ENV_KEY];

    beforeEach(() => {
        vi.resetModules();
    });

    afterAll(() => {
        if (originalEnv === undefined) delete process.env[ENV_KEY];
        else process.env[ENV_KEY] = originalEnv;
    });

    async function importWithMockedDriver(env: Record<string, string | undefined>) {
        const ctorCalls: unknown[] = [];

        vi.doMock("ioredis", () => ({
            default: class {
                constructor(arg: unknown) {
                    ctorCalls.push(arg);
                }
            },
        }));

        for (const [key, value] of Object.entries(env)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }

        await import("@/app/lib/redis");
        return { ctorCalls };
    }

    it("passes an empty string to the driver when REDIS_URL is unset (no explicit localhost literal)", async () => {
        const { ctorCalls } = await importWithMockedDriver({ [ENV_KEY]: undefined });
        expect(ctorCalls).toEqual([""]);
    });

    it("passes REDIS_URL straight through, unmodified, when set", async () => {
        const { ctorCalls } = await importWithMockedDriver({ [ENV_KEY]: "redis://cache-host:6379/2" });
        expect(ctorCalls).toEqual(["redis://cache-host:6379/2"]);
    });

    it("constructs exactly one client for the module, shared by every importer", async () => {
        const { ctorCalls } = await importWithMockedDriver({});
        expect(ctorCalls).toHaveLength(1);
    });
});
