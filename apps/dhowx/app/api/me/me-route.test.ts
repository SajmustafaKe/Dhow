import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Characterization tests for `app/api/me` (GET), ahead of the port into
 * apps/dhowx.
 *
 * `USE_AUTH` (`@/app/lib/feature_flags`) is a module-scope constant read
 * from `process.env.USE_AUTH` at import time, and `me/route.ts` imports it
 * directly — so each variant below sets the env var, calls
 * `vi.resetModules()`, and re-imports the route fresh, mirroring the
 * pattern in `agent-loop.test.ts`.
 *
 * THE PIN: with `USE_AUTH` unset (the default in every env config in this
 * repo — see agent-loop.test.ts's note on `USE_NATIVE_HANDOFFS`), this
 * route never calls `authCheck` at all and unconditionally returns
 * `{ id: 'guest_user' }` — i.e. `/api/me` is NOT gated by auth today.
 */

const { authCheckMock } = vi.hoisted(() => ({ authCheckMock: vi.fn() }));
vi.mock("@/app/actions/auth.actions", () => ({ authCheck: authCheckMock }));

const req = () => new NextRequest("http://localhost/api/me");

describe("me (GET) — USE_AUTH unset (default)", () => {
    it("returns { id: 'guest_user' } without ever calling authCheck", async () => {
        delete process.env.USE_AUTH;
        vi.resetModules();
        const { GET } = await import("./route");
        const res = await GET(req());
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ id: "guest_user" });
        expect(authCheckMock).not.toHaveBeenCalled();
    });
});

describe("me (GET) — USE_AUTH=true", () => {
    it("returns { id: user.id } when authCheck resolves", async () => {
        process.env.USE_AUTH = "true";
        authCheckMock.mockResolvedValue({ id: "user-42", email: "u@x.com" });
        vi.resetModules();
        const { GET } = await import("./route");
        const res = await GET(req());
        expect(res.status).toBe(200);
        // Pin: only `id` is projected into the response, not the full user object.
        expect(await res.json()).toEqual({ id: "user-42" });
        delete process.env.USE_AUTH;
    });

    it("401s with a generic { error: 'Unauthorized' } when authCheck rejects, not the underlying message", async () => {
        process.env.USE_AUTH = "true";
        authCheckMock.mockRejectedValue(new Error("no supabase session cookie"));
        vi.resetModules();
        const { GET } = await import("./route");
        const res = await GET(req());
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: "Unauthorized" });
        delete process.env.USE_AUTH;
    });
});
