import { describe, it, expect, afterEach } from "vitest";
import { GET } from "./route";

/**
 * Characterization tests for `GET /api/v1/config` — the bootstrap endpoint
 * the desktop app fetches at startup to discover its identity provider.
 *
 * THE PIN: this route is unauthenticated by design (it must be reachable
 * before a client has signed in) and reads two env vars fresh on every
 * call — `NEXT_PUBLIC_APP_URL` and `NEXT_PUBLIC_SUPABASE_URL` — so a single
 * static import of `GET` is safe here (unlike `me-route.test.ts`, nothing
 * in this route is cached at module-import time): each test just sets
 * `process.env` before calling `GET()`.
 *
 * The allowlist test is the load-bearing one: it asserts the response's
 * key set is EXACTLY `["appUrl", "supabaseUrl"]`. Any new field — secret
 * or not — has to be a deliberate edit to this test, not a silent
 * addition that slips a service-role key or anon key into an
 * unauthenticated response.
 */

const ENV_KEYS = [
    "NEXT_PUBLIC_APP_URL",
    "NEXT_PUBLIC_SUPABASE_URL",
    "APP_URL",
    "SUPABASE_URL",
] as const;

afterEach(() => {
    for (const key of ENV_KEYS) {
        delete process.env[key];
    }
});

describe("GET /api/v1/config — runtime configurability", () => {
    /**
     * REGRESSION GUARD. `NEXT_PUBLIC_*` is inlined by the bundler at build
     * time, even in a server route, so a deployed build serves whatever it
     * was compiled with and ignores the process environment entirely. This
     * was found by starting a real standalone build with a different
     * NEXT_PUBLIC_SUPABASE_URL and watching it return the baked one.
     *
     * That defeats the only reason this endpoint exists: the desktop app
     * fetches it so the identity provider can be swapped without shipping a
     * new desktop build. These tests pin the unprefixed names as the ones
     * that win, so the endpoint stays configurable per deployment.
     */
    it("prefers APP_URL / SUPABASE_URL over the build-inlined NEXT_PUBLIC_ values", async () => {
        process.env.NEXT_PUBLIC_APP_URL = "https://baked-at-build-time.example";
        process.env.NEXT_PUBLIC_SUPABASE_URL = "https://baked-ref.supabase.co";
        process.env.APP_URL = "https://dhow.io";
        process.env.SUPABASE_URL = "https://runtime-ref.supabase.co";

        const body = await (await GET()).json();

        expect(body).toEqual({
            appUrl: "https://dhow.io",
            supabaseUrl: "https://runtime-ref.supabase.co",
        });
    });

    it("falls back to the NEXT_PUBLIC_ values when the unprefixed ones are absent", async () => {
        process.env.NEXT_PUBLIC_APP_URL = "https://dhow.example.com";
        process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project-ref.supabase.co";

        const body = await (await GET()).json();

        expect(body).toEqual({
            appUrl: "https://dhow.example.com",
            supabaseUrl: "https://project-ref.supabase.co",
        });
    });

    it("still 500s when neither form is set", async () => {
        expect((await GET()).status).toBe(500);
    });

    it("a runtime override alone is sufficient — no NEXT_PUBLIC_ needed", async () => {
        process.env.APP_URL = "https://dhow.io";
        process.env.SUPABASE_URL = "https://runtime-ref.supabase.co";

        const res = await GET();

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            appUrl: "https://dhow.io",
            supabaseUrl: "https://runtime-ref.supabase.co",
        });
    });
});

describe("GET /api/v1/config — happy path", () => {
    it("returns { appUrl, supabaseUrl } sourced from env, and nothing else", async () => {
        process.env.NEXT_PUBLIC_APP_URL = "https://dhow.example.com";
        process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project-ref.supabase.co";

        const res = await GET();
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body).toEqual({
            appUrl: "https://dhow.example.com",
            supabaseUrl: "https://project-ref.supabase.co",
        });
    });

    it("ALLOWLIST: response body keys are exactly ['appUrl', 'supabaseUrl'] — no more, no less", async () => {
        process.env.NEXT_PUBLIC_APP_URL = "https://dhow.example.com";
        process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project-ref.supabase.co";

        const res = await GET();
        const body = await res.json();

        expect(Object.keys(body).sort()).toEqual(["appUrl", "supabaseUrl"]);
    });

    it("SECRET LEAK GUARD: no secret-looking env var value ever appears in the response body", async () => {
        process.env.NEXT_PUBLIC_APP_URL = "https://dhow.example.com";
        process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project-ref.supabase.co";
        // Values a real deployment would have set alongside the public ones.
        // None of these must ever reach the client.
        process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-secret-do-not-leak";
        process.env.SUPABASE_ANON_KEY = "anon-key-should-not-appear-either";
        process.env.AUTH0_CLIENT_SECRET = "auth0-secret-legacy-do-not-leak";
        process.env.MONGODB_URI = "mongodb://user:supersecretpassword@host/db";

        try {
            const res = await GET();
            const raw = await res.text();

            expect(raw).not.toContain("service-role-secret-do-not-leak");
            expect(raw).not.toContain("anon-key-should-not-appear-either");
            expect(raw).not.toContain("auth0-secret-legacy-do-not-leak");
            expect(raw).not.toContain("supersecretpassword");

            // Belt-and-suspenders: the allowlist test above already guarantees
            // this, but pin it explicitly so a future edit that touches only
            // one of the two tests still has an independent guard.
            const body = JSON.parse(raw);
            expect(Object.keys(body).sort()).toEqual(["appUrl", "supabaseUrl"]);
        } finally {
            delete process.env.SUPABASE_SERVICE_ROLE_KEY;
            delete process.env.SUPABASE_ANON_KEY;
            delete process.env.AUTH0_CLIENT_SECRET;
            delete process.env.MONGODB_URI;
        }
    });
});

describe("GET /api/v1/config — missing env vars", () => {
    it("500s with a generic error, never leaking `undefined` into the payload, when NEXT_PUBLIC_SUPABASE_URL is unset", async () => {
        process.env.NEXT_PUBLIC_APP_URL = "https://dhow.example.com";
        delete process.env.NEXT_PUBLIC_SUPABASE_URL;

        const res = await GET();
        const raw = await res.text();

        expect(res.status).toBe(500);
        expect(raw).not.toContain("undefined");
        expect(JSON.parse(raw)).toEqual({ error: "Server misconfigured" });
    });

    it("500s with a generic error when NEXT_PUBLIC_APP_URL is unset", async () => {
        delete process.env.NEXT_PUBLIC_APP_URL;
        process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project-ref.supabase.co";

        const res = await GET();
        const raw = await res.text();

        expect(res.status).toBe(500);
        expect(raw).not.toContain("undefined");
        expect(JSON.parse(raw)).toEqual({ error: "Server misconfigured" });
    });

    it("500s with a generic error when both are unset", async () => {
        delete process.env.NEXT_PUBLIC_APP_URL;
        delete process.env.NEXT_PUBLIC_SUPABASE_URL;

        const res = await GET();

        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ error: "Server misconfigured" });
    });
});
