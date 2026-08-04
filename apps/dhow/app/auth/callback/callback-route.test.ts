import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * `app/auth/callback/route.ts` is where the OAuth authorization-code flow
 * finishes: Supabase redirects the browser here with `?code=...` after
 * `signInWithOAuth`, and this route exchanges that code for a session
 * (setting the session cookie) before sending the browser on.
 *
 * Two failure modes matter more than the happy path:
 *   1. A missing/empty `code` must never reach exchangeCodeForSession — that
 *      would either throw inside the route or (worse) leave a
 *      half-authenticated response in flight. It must bail out to the login
 *      page instead.
 *   2. The `?next=` param controls where the browser lands after a
 *      successful exchange. Since it's attacker-controlled query input, a
 *      value that isn't a same-origin path (an absolute URL, `//evil.com`,
 *      or a backslash trick that a naive `startsWith('/')` check wouldn't
 *      catch) must never be honored — that's a credential-theft-adjacent
 *      open redirect riding a legitimate login.
 *
 * `@/app/lib/supabase` is mocked: the real module needs `next/headers`
 * cookies() (no request context in a unit test) and real Supabase env vars.
 */

const exchangeCodeForSession = vi.fn();
const createClient = vi.fn(() => ({ auth: { exchangeCodeForSession } }));
vi.mock("@/app/lib/supabase", () => ({ createClient }));

function req(query: string) {
    return new NextRequest(`http://localhost:3000/auth/callback${query}`);
}

beforeEach(() => {
    exchangeCodeForSession.mockReset();
    createClient.mockClear();
});

describe("GET /auth/callback", () => {
    it("missing code: redirects to /auth/login?error=missing_code and never calls exchangeCodeForSession", async () => {
        const { GET } = await import("./route");
        const res = await GET(req(""));

        expect(res.status).toBe(307);
        expect(res.headers.get("location")).toBe("http://localhost:3000/auth/login?error=missing_code");
        expect(exchangeCodeForSession).not.toHaveBeenCalled();
    });

    it("empty/whitespace code: also rejected before exchangeCodeForSession is called", async () => {
        const { GET } = await import("./route");
        const res = await GET(req("?code=%20%20"));

        expect(res.headers.get("location")).toBe("http://localhost:3000/auth/login?error=missing_code");
        expect(exchangeCodeForSession).not.toHaveBeenCalled();
    });

    it("valid code, exchange succeeds, no next param: redirects to /", async () => {
        exchangeCodeForSession.mockResolvedValue({ error: null });
        const { GET } = await import("./route");
        const res = await GET(req("?code=abc123"));

        expect(exchangeCodeForSession).toHaveBeenCalledWith("abc123");
        expect(res.headers.get("location")).toBe("http://localhost:3000/");
    });

    it("valid code, exchange fails: redirects to /auth/login?error=exchange_failed — does not land on a next target", async () => {
        exchangeCodeForSession.mockResolvedValue({ error: { message: "invalid grant" } });
        const { GET } = await import("./route");
        const res = await GET(req("?code=abc123&next=/projects"));

        expect(res.headers.get("location")).toBe("http://localhost:3000/auth/login?error=exchange_failed");
    });

    it("valid code + safe relative next: redirects to the exact same-origin path, query and hash preserved", async () => {
        exchangeCodeForSession.mockResolvedValue({ error: null });
        const { GET } = await import("./route");
        const res = await GET(req("?code=abc123&next=%2Fprojects%2F42%3Ftab%3Doverview"));

        expect(res.headers.get("location")).toBe("http://localhost:3000/projects/42?tab=overview");
    });

    it.each([
        ["protocol-relative host swap", "//evil.com"],
        ["absolute URL to another origin", "https://evil.com/steal"],
        ["backslash trick (normalizes to //evil.com for special schemes)", "/\\evil.com"],
        ["javascript: scheme", "javascript:alert(1)"],
        ["different port on same host", "http://localhost:9999/steal"],
    ])("open-redirect guard — %s (%s) never leaves this origin, falls back to /", async (_label, malicious) => {
        exchangeCodeForSession.mockResolvedValue({ error: null });
        const { GET } = await import("./route");
        const res = await GET(req(`?code=abc123&next=${encodeURIComponent(malicious)}`));

        const location = res.headers.get("location")!;
        expect(new URL(location).origin).toBe("http://localhost:3000");
        expect(location).toBe("http://localhost:3000/");
    });
});
