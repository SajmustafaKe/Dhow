import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Characterization tests for auth.actions.ts, ahead of the port into apps/dhowx.
 *
 * `authCheck` is the auth primitive every other action file in this directory
 * calls first. Its branches matter more than almost anything else in the
 * `app/actions` surface:
 *   - USE_AUTH=false (local/dev/demo mode): every caller silently becomes the
 *     same GUEST_DB_USER, no session lookup at all.
 *   - USE_AUTH=true, no Supabase session: throws a plain Error (not a redirect,
 *     not a typed error) — callers that don't wrap this in try/catch surface a
 *     raw 500 to the browser.
 *   - USE_AUTH=true, session but no DB user record: throws a *different*
 *     message, which is the only way to tell "never logged in" apart from
 *     "user row missing" from the outside.
 *
 * `USE_AUTH` is a module-scope constant read from `process.env` at import
 * time (feature_flags.ts), so each USE_AUTH scenario below sets the env var
 * and dynamically re-imports after `vi.resetModules()` — the pattern already
 * established in agents-runtime/agent-loop.test.ts.
 *
 * `@/di/container` and `../lib/supabase` are mocked per the task contract.
 * `../lib/auth` (getUserFromSessionId, GUEST_DB_USER) is deliberately left
 * real: it is the shared plumbing every other action file's auth also goes
 * through, so exercising the real implementation here is more valuable than a
 * hand-rolled stand-in.
 */

const usersRepository = {
    fetchByAuthId: vi.fn(),
    updateEmail: vi.fn(),
    create: vi.fn(),
    fetch: vi.fn(),
    updateBillingCustomerId: vi.fn(),
};

vi.mock("@/di/container", () => ({
    container: {
        resolve: vi.fn(() => usersRepository),
    },
}));

const getSession = vi.fn();

vi.mock("../lib/supabase", () => ({
    getSession,
}));

async function loadWithAuth(useAuth: boolean) {
    vi.resetModules();
    process.env.USE_AUTH = useAuth ? "true" : "false";
    return await import("./auth.actions");
}

beforeEach(() => {
    usersRepository.fetchByAuthId.mockReset();
    usersRepository.updateEmail.mockReset();
    getSession.mockReset();
});

describe("authCheck", () => {
    it("USE_AUTH=false: returns the static guest user without touching supabase or the DB", async () => {
        const { authCheck } = await loadWithAuth(false);
        const user = await authCheck();

        expect(user).toEqual({
            id: "guest_user",
            authId: "guest_user",
            name: "Guest",
            email: "guest@dhow.local",
            createdAt: expect.any(String),
        });
        expect(getSession).not.toHaveBeenCalled();
        expect(usersRepository.fetchByAuthId).not.toHaveBeenCalled();
    });

    it("USE_AUTH=true, no session: throws 'User not authenticated', never queries the DB", async () => {
        getSession.mockResolvedValue(null);
        const { authCheck } = await loadWithAuth(true);

        await expect(authCheck()).rejects.toThrow("User not authenticated");
        expect(usersRepository.fetchByAuthId).not.toHaveBeenCalled();
    });

    it("USE_AUTH=true, session with no `user` field: also throws 'User not authenticated'", async () => {
        // getSession() resolving to a session object that just lacks
        // `.user` (as opposed to resolving to null/undefined) takes the same
        // `{} ` fallback path.
        getSession.mockResolvedValue({});
        const { authCheck } = await loadWithAuth(true);

        await expect(authCheck()).rejects.toThrow("User not authenticated");
    });

    it("USE_AUTH=true, session but no matching DB user: throws a distinct 'User record not found'", async () => {
        getSession.mockResolvedValue({ user: { id: "supabase|abc123" } });
        usersRepository.fetchByAuthId.mockResolvedValue(null);
        const { authCheck } = await loadWithAuth(true);

        await expect(authCheck()).rejects.toThrow("User record not found");
        expect(usersRepository.fetchByAuthId).toHaveBeenCalledWith("supabase|abc123");
    });

    it("USE_AUTH=true, session and DB user: returns the DB user", async () => {
        getSession.mockResolvedValue({ user: { id: "supabase|abc123" } });
        const dbUser = {
            id: "u_1",
            authId: "supabase|abc123",
            name: "Real User",
            email: "real@example.com",
            createdAt: "2024-01-01T00:00:00.000Z",
        };
        usersRepository.fetchByAuthId.mockResolvedValue(dbUser);
        const { authCheck } = await loadWithAuth(true);

        await expect(authCheck()).resolves.toEqual(dbUser);
    });
});

describe("updateUserEmail", () => {
    it("USE_AUTH=false: no-ops entirely — no auth, no validation, no DB write, even for garbage input", async () => {
        // This is the load-bearing quirk: in guest mode the function returns
        // `undefined` immediately, before the email-shape checks below ever
        // run. An empty string or an invalid address is silently accepted.
        const { updateUserEmail } = await loadWithAuth(false);

        await expect(updateUserEmail("not-an-email")).resolves.toBeUndefined();
        expect(usersRepository.updateEmail).not.toHaveBeenCalled();
    });

    it("USE_AUTH=true: auth gates before validation — an auth failure never reaches the email checks", async () => {
        getSession.mockResolvedValue(null); // authCheck() will throw
        const { updateUserEmail } = await loadWithAuth(true);

        // Pass a garbage email too: if validation ran first, this would throw
        // a *different* message ("Email is required"/"Invalid email").
        await expect(updateUserEmail("")).rejects.toThrow("User not authenticated");
        expect(usersRepository.updateEmail).not.toHaveBeenCalled();
    });

    it("USE_AUTH=true, authenticated, whitespace-only email: throws 'Email is required' before Zod runs", async () => {
        getSession.mockResolvedValue({ user: { id: "s1" } });
        usersRepository.fetchByAuthId.mockResolvedValue({ id: "u1", authId: "s1", createdAt: "2024-01-01T00:00:00.000Z" });
        const { updateUserEmail } = await loadWithAuth(true);

        await expect(updateUserEmail("   ")).rejects.toThrow("Email is required");
        expect(usersRepository.updateEmail).not.toHaveBeenCalled();
    });

    it("USE_AUTH=true, authenticated, malformed (non-empty) email: throws 'Invalid email'", async () => {
        getSession.mockResolvedValue({ user: { id: "s1" } });
        usersRepository.fetchByAuthId.mockResolvedValue({ id: "u1", authId: "s1", createdAt: "2024-01-01T00:00:00.000Z" });
        const { updateUserEmail } = await loadWithAuth(true);

        await expect(updateUserEmail("not-an-email")).rejects.toThrow("Invalid email");
        expect(usersRepository.updateEmail).not.toHaveBeenCalled();
    });

    it("USE_AUTH=true, authenticated, valid email: writes user.id + email, returns undefined", async () => {
        getSession.mockResolvedValue({ user: { id: "s1" } });
        usersRepository.fetchByAuthId.mockResolvedValue({ id: "u1", authId: "s1", createdAt: "2024-01-01T00:00:00.000Z" });
        usersRepository.updateEmail.mockResolvedValue({ id: "u1" });
        const { updateUserEmail } = await loadWithAuth(true);

        // The action has no `return` statement on this branch: even though
        // the repo call resolves a value, the action itself resolves undefined.
        await expect(updateUserEmail("new@example.com")).resolves.toBeUndefined();
        expect(usersRepository.updateEmail).toHaveBeenCalledWith("u1", "new@example.com");
    });
});
