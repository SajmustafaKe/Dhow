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

const ENV_KEYS = ["NEXT_PUBLIC_APP_URL", "NEXT_PUBLIC_SUPABASE_URL"] as const;

afterEach(() => {
    for (const key of ENV_KEYS) {
        delete process.env[key];
    }
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
