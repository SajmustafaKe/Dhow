import { describe, it, expect, vi } from "vitest";

/**
 * Characterization tests for app/lib/auth.ts, ahead of the port into
 * apps/dhowx.
 *
 * `requireAuth()` is the authentication half of the tenant boundary: it
 * resolves "who is calling" before any project-level authorization check
 * (ProjectActionAuthorizationPolicy — see ../src/application/policies/
 * authorization.test.ts) ever runs. It is reused directly by page components
 * (app/onboarding/page.tsx:12, app/projects/[projectId]/workflow/page.tsx:36)
 * and API routes (app/api/stream-response/[streamId]/route.ts:13,
 * app/api/copilot-stream-response/[streamId]/route.ts:11).
 *
 * It is NOT the only implementation of "resolve the caller", though.
 * app/actions/auth.actions.ts defines a separate `authCheck()` used by every
 * Server Action (project.actions.ts, composio.actions.ts, etc.) that does the
 * same underlying job — Auth0 session -> db user — but with different
 * failure semantics: it THROWS a plain Error instead of redirecting when
 * there is no session (auth.actions.ts:18-20 vs. this file's redirect at
 * line 42), and it THROWS instead of auto-provisioning when the db user
 * record does not exist yet (auth.actions.ts:23-25 vs. this file's
 * usersRepository.create at lines 50-55). That divergence is exactly the
 * kind of thing a mechanical port either preserves by accident or silently
 * unifies — pinned here (this file) and left for the report to flag.
 *
 * `USE_AUTH` (app/lib/feature_flags.ts) is read into a module constant at
 * import time, so it must be set before the dynamic import below, and
 * modules must be reset between tests that need different values. The
 * `await import(...)` calls throughout this file are the documented
 * ts-no-dynamic-import exception ("test cases that intentionally exercise
 * module loading boundaries") — a static top-level import would freeze
 * USE_AUTH at whichever value happened to be set first and make the other
 * branch untestable in this file, matching the established pattern in
 * src/application/lib/agents-runtime/agent-loop.test.ts.
 *
 * `@/app/lib/auth0`, `@/di/container` and `next/navigation` are always
 * mocked: auth0.ts constructs a real Auth0Client at import time (needs
 * env-configured secrets), and di/container.ts transitively imports every
 * Mongo/Redis-backed repository in the app — neither is safe to import in a
 * test process.
 */

describe("requireAuth", () => {
    it("guest mode (USE_AUTH=false): returns the guest db user without touching auth0, redirect, or the container", async () => {
        vi.resetModules();
        process.env.USE_AUTH = "false";

        const getSession = vi.fn();
        vi.doMock("@/app/lib/auth0", () => ({ auth0: { getSession } }));
        const redirect = vi.fn();
        vi.doMock("next/navigation", () => ({ redirect }));
        const resolve = vi.fn();
        vi.doMock("@/di/container", () => ({ container: { resolve } }));

        const { requireAuth, GUEST_DB_USER } = await import("@/app/lib/auth");
        const user = await requireAuth();

        expect(user).toEqual(GUEST_DB_USER);
        expect(getSession).not.toHaveBeenCalled();
        expect(redirect).not.toHaveBeenCalled();
        expect(resolve).not.toHaveBeenCalled();
    });

    it("unauthenticated (no session at all): redirects to /auth/login and never resolves a users repository", async () => {
        vi.resetModules();
        process.env.USE_AUTH = "true";

        const getSession = vi.fn().mockResolvedValue(undefined);
        vi.doMock("@/app/lib/auth0", () => ({ auth0: { getSession } }));
        const redirect = vi.fn((url: string) => {
            // Next.js's real redirect() always throws (a NEXT_REDIRECT-digest
            // error) and never returns; requireAuth relies on that to stop
            // execution instead of an explicit `return` after the call
            // (auth.ts:42) — see the next test for what that reliance costs.
            throw new Error(`NEXT_REDIRECT:${url}`);
        });
        vi.doMock("next/navigation", () => ({ redirect }));
        const resolve = vi.fn();
        vi.doMock("@/di/container", () => ({ container: { resolve } }));

        const { requireAuth } = await import("@/app/lib/auth");

        await expect(requireAuth()).rejects.toThrow("NEXT_REDIRECT:/auth/login");
        expect(redirect).toHaveBeenCalledWith("/auth/login");
        expect(redirect).toHaveBeenCalledTimes(1);
        expect(resolve).not.toHaveBeenCalled();
    });

    it("unauthenticated (session object present but with no user field): still redirects — pins the `{ user } = await getSession() || {}` destructure, not just a falsy-session check", async () => {
        vi.resetModules();
        process.env.USE_AUTH = "true";

        const getSession = vi.fn().mockResolvedValue({});
        vi.doMock("@/app/lib/auth0", () => ({ auth0: { getSession } }));
        const redirect = vi.fn((url: string) => {
            throw new Error(`NEXT_REDIRECT:${url}`);
        });
        vi.doMock("next/navigation", () => ({ redirect }));
        vi.doMock("@/di/container", () => ({ container: { resolve: vi.fn() } }));

        const { requireAuth } = await import("@/app/lib/auth");

        await expect(requireAuth()).rejects.toThrow("NEXT_REDIRECT:/auth/login");
    });

    it("authenticated, existing db user: returns the found user and never calls usersRepository.create", async () => {
        vi.resetModules();
        process.env.USE_AUTH = "true";

        const getSession = vi.fn().mockResolvedValue({ user: { sub: "auth0|123", email: "a@b.com" } });
        vi.doMock("@/app/lib/auth0", () => ({ auth0: { getSession } }));
        vi.doMock("next/navigation", () => ({ redirect: vi.fn() }));

        const existingUser = {
            id: "u1",
            auth0Id: "auth0|123",
            email: "a@b.com",
            createdAt: "2024-01-01T00:00:00.000Z",
        };
        const fetchByAuth0Id = vi.fn().mockResolvedValue(existingUser);
        const create = vi.fn();
        const resolve = vi.fn(() => ({ fetchByAuth0Id, create }));
        vi.doMock("@/di/container", () => ({ container: { resolve } }));

        const { requireAuth } = await import("@/app/lib/auth");
        const user = await requireAuth();

        expect(user).toEqual(existingUser);
        expect(create).not.toHaveBeenCalled();
        expect(resolve).toHaveBeenCalledWith("usersRepository");
    });

    it("authenticated, first login (no db user yet): auto-provisions via usersRepository.create({ auth0Id, email }) — no allowlist/invite gate beyond a valid Auth0 session, and the session's `name` is silently dropped", async () => {
        vi.resetModules();
        process.env.USE_AUTH = "true";

        const getSession = vi.fn().mockResolvedValue({
            user: { sub: "auth0|new-user", email: "new@example.com", name: "New User" },
        });
        vi.doMock("@/app/lib/auth0", () => ({ auth0: { getSession } }));
        vi.doMock("next/navigation", () => ({ redirect: vi.fn() }));

        const createdUser = {
            id: "u_new",
            auth0Id: "auth0|new-user",
            email: "new@example.com",
            createdAt: "2024-01-01T00:00:00.000Z",
        };
        const fetchByAuth0Id = vi.fn().mockResolvedValue(null);
        const create = vi.fn().mockResolvedValue(createdUser);
        vi.doMock("@/di/container", () => ({ container: { resolve: vi.fn(() => ({ fetchByAuth0Id, create })) } }));

        const { requireAuth } = await import("@/app/lib/auth");
        const user = await requireAuth();

        expect(user).toEqual(createdUser);
        // Exact shape pin: only auth0Id + email are forwarded to create(). If
        // a port adds `name` to this call, or drops `email`, this fails.
        expect(create).toHaveBeenCalledWith({ auth0Id: "auth0|new-user", email: "new@example.com" });
        expect(create).toHaveBeenCalledTimes(1);
    });

    it("a session lookup failure propagates as a rejection — there is no fallback to guest", async () => {
        vi.resetModules();
        process.env.USE_AUTH = "true";
        const getSession = vi.fn().mockRejectedValue(new Error("auth0 unreachable"));
        vi.doMock("@/app/lib/auth0", () => ({ auth0: { getSession } }));
        vi.doMock("next/navigation", () => ({ redirect: vi.fn() }));
        vi.doMock("@/di/container", () => ({ container: { resolve: vi.fn() } }));

        const { requireAuth } = await import("@/app/lib/auth");
        await expect(requireAuth()).rejects.toThrow("auth0 unreachable");
    });
});

describe("getUserFromSessionId", () => {
    it("guest mode (USE_AUTH=false): returns the guest db user regardless of the id argument, without touching the container", async () => {
        vi.resetModules();
        process.env.USE_AUTH = "false";
        const resolve = vi.fn();
        vi.doMock("@/di/container", () => ({ container: { resolve } }));
        vi.doMock("@/app/lib/auth0", () => ({ auth0: { getSession: vi.fn() } }));
        vi.doMock("next/navigation", () => ({ redirect: vi.fn() }));

        const { getUserFromSessionId, GUEST_DB_USER } = await import("@/app/lib/auth");
        const user = await getUserFromSessionId("literally-anything");

        expect(user).toEqual(GUEST_DB_USER);
        expect(resolve).not.toHaveBeenCalled();
    });

    it('USE_AUTH=true, found: returns the repository result verbatim, resolved by exactly "usersRepository"', async () => {
        vi.resetModules();
        process.env.USE_AUTH = "true";
        const found = { id: "u1", auth0Id: "auth0|123", createdAt: "2024-01-01T00:00:00.000Z" };
        const fetchByAuth0Id = vi.fn().mockResolvedValue(found);
        const resolve = vi.fn(() => ({ fetchByAuth0Id }));
        vi.doMock("@/di/container", () => ({ container: { resolve } }));
        vi.doMock("@/app/lib/auth0", () => ({ auth0: { getSession: vi.fn() } }));
        vi.doMock("next/navigation", () => ({ redirect: vi.fn() }));

        const { getUserFromSessionId } = await import("@/app/lib/auth");
        const user = await getUserFromSessionId("auth0|123");

        expect(user).toEqual(found);
        expect(fetchByAuth0Id).toHaveBeenCalledWith("auth0|123");
        expect(resolve).toHaveBeenCalledWith("usersRepository");
    });

    it("USE_AUTH=true, not found: RETURNS null — it does not throw. app/actions/auth.actions.ts:22-25 and requireAuth's own auto-provision check (auth.ts:50) both branch on this being a falsy return, not a caught exception", async () => {
        vi.resetModules();
        process.env.USE_AUTH = "true";
        const fetchByAuth0Id = vi.fn().mockResolvedValue(null);
        vi.doMock("@/di/container", () => ({ container: { resolve: vi.fn(() => ({ fetchByAuth0Id })) } }));
        vi.doMock("@/app/lib/auth0", () => ({ auth0: { getSession: vi.fn() } }));
        vi.doMock("next/navigation", () => ({ redirect: vi.fn() }));

        const { getUserFromSessionId } = await import("@/app/lib/auth");
        await expect(getUserFromSessionId("auth0|unknown")).resolves.toBeNull();
    });
});
