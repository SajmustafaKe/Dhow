import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST as guestSessionPOST } from "./session/guest/route";
import { POST as userSessionPOST } from "./session/user/route";
import { POST as chatsPOST, GET as chatsGET } from "./chats/route";
import { GET as chatByIdGET } from "./chats/[chatId]/route";
import { GET as chatMessagesGET } from "./chats/[chatId]/messages/route";
import { POST as chatClosePOST } from "./chats/[chatId]/close/route";
import { POST as chatTurnPOST } from "./chats/[chatId]/turn/route";

/**
 * Characterization tests for `app/api/widget/v1/**`, ahead of the port into
 * apps/dhowx.
 *
 * THE LANDMINE: none of these 7 route files are reachable today. Two
 * (`session/user`, `chats/[chatId]/turn`) have an explicit
 * `return new Response('Not implemented', { status: 501 })` as their first
 * line. The other five (`session/guest`, `chats` GET+POST,
 * `chats/[chatId]` GET, `chats/[chatId]/messages` GET,
 * `chats/[chatId]/close` POST) look "live" when you read only the route
 * file — they call the shared `clientIdCheck`/`authCheck` wrappers from
 * `./utils.ts` and go on to build JWTs / touch Mongo. But `clientIdCheck`
 * and `authCheck` themselves each start with an unconditional
 * `return new Response('Not implemented', { status: 501 })` before ever
 * invoking the handler callback they were given (utils.ts:20, utils.ts:47).
 * So all 7 files are stubs; only 2 of the 9 repo-wide 501s (this dir +
 * twilio/) are visible without reading utils.ts.
 *
 * A port that "revives" a route by deleting its own 501 line without also
 * fixing clientIdCheck/authCheck will still get 501 — and a port that reads
 * only route.ts and concludes 5 of these files are live is wrong. Every
 * test below proves BOTH the status code AND that the real handler body
 * (Mongo write/read, JWT mint) never ran, using mocks that throw if touched.
 */
const { chatsCollectionMock, chatMessagesCollectionMock, signJwtCtor, jwtVerifyFn } = vi.hoisted(() => ({
    chatsCollectionMock: {
        insertOne: vi.fn(),
        find: vi.fn(),
        findOne: vi.fn(),
    },
    chatMessagesCollectionMock: {
        find: vi.fn(),
    },
    signJwtCtor: vi.fn(() => {
        throw new Error("SignJWT constructed — session-minting code ran past the auth stub");
    }),
    jwtVerifyFn: vi.fn(() => {
        throw new Error("jwtVerify called — session-minting code ran past the auth stub");
    }),
}));

vi.mock("@/app/lib/mongodb", () => ({
    db: {
        collection: vi.fn(() => chatsCollectionMock),
    },
    chatsCollection: chatsCollectionMock,
    chatMessagesCollection: chatMessagesCollectionMock,
}));

vi.mock("jose", () => ({
    SignJWT: signJwtCtor,
    jwtVerify: jwtVerifyFn,
}));

const req = (opts: { method?: string; url?: string; body?: unknown } = {}) =>
    new NextRequest(opts.url ?? "http://localhost/api/widget/v1/x", {
        method: opts.method ?? "GET",
        ...(opts.body !== undefined
            ? { body: JSON.stringify(opts.body), headers: { "content-type": "application/json" } }
            : {}),
    });

/**
 * A params promise that blows up the instant it's awaited — proves (or disproves)
 * that a route touches it. Pre-catches itself so the never-awaited cases (proving
 * a route does NOT read params) don't trip Node's unhandled-rejection detector;
 * routes that DO await it still observe the rejection independently.
 */
const explodingParams = () => {
    const p = Promise.reject(new Error("params awaited — this route reads params before short-circuiting"));
    p.catch(() => {});
    return p;
};

describe("widget/v1/session/guest (POST) — stub via clientIdCheck", () => {
    it("returns 501 and never mints a guest session", async () => {
        const res = await guestSessionPOST(req({ method: "POST" }));
        expect(res.status).toBe(501);
        expect(await res.text()).toBe("Not implemented");
        expect(signJwtCtor).not.toHaveBeenCalled();
    });
});

describe("widget/v1/session/user (POST) — direct stub", () => {
    it("returns 501 and never verifies/mints a JWT", async () => {
        const res = await userSessionPOST(req({ method: "POST", body: { userDataJwt: "x" } }));
        expect(res.status).toBe(501);
        expect(await res.text()).toBe("Not implemented");
        expect(jwtVerifyFn).not.toHaveBeenCalled();
        expect(signJwtCtor).not.toHaveBeenCalled();
    });
});

describe("widget/v1/chats (POST, GET) — stub via authCheck", () => {
    it("POST returns 501 and never inserts a chat, even with a valid empty body", async () => {
        const res = await chatsPOST(req({ method: "POST", body: {} }));
        expect(res.status).toBe(501);
        expect(chatsCollectionMock.insertOne).not.toHaveBeenCalled();
    });

    it("GET returns 501 and never queries chats, even with a malformed cursor", async () => {
        // `next=not-a-valid-objectid` would throw inside `new ObjectId(next)` if the
        // dead query-parsing code ever ran; it stays dead behind the 501.
        const res = await chatsGET(req({ url: "http://localhost/api/widget/v1/chats?next=not-a-valid-objectid" }));
        expect(res.status).toBe(501);
        expect(chatsCollectionMock.find).not.toHaveBeenCalled();
    });
});

describe("widget/v1/chats/[chatId] (GET) — stub via authCheck, params read AFTER the stub", () => {
    it("returns 501 without ever awaiting params (a rejecting params promise does not surface)", async () => {
        const res = await chatByIdGET(req(), { params: explodingParams() });
        expect(res.status).toBe(501);
        expect(chatsCollectionMock.findOne).not.toHaveBeenCalled();
    });
});

describe("widget/v1/chats/[chatId]/messages (GET) — stub via authCheck, params read BEFORE the stub", () => {
    it("rejects if params rejects — params is awaited before authCheck runs, unlike the sibling routes", async () => {
        await expect(chatMessagesGET(req(), { params: explodingParams() })).rejects.toThrow(/params awaited/);
        // Never even reached authCheck / the DB, since the throw happens first.
        expect(chatsCollectionMock.findOne).not.toHaveBeenCalled();
    });

    it("returns 501 (not a DB error) when params resolves cleanly", async () => {
        const res = await chatMessagesGET(req(), { params: Promise.resolve({ chatId: "not-a-valid-objectid" }) });
        expect(res.status).toBe(501);
        expect(chatsCollectionMock.findOne).not.toHaveBeenCalled();
    });
});

describe("widget/v1/chats/[chatId]/close (POST) — stub via authCheck, params read BEFORE the stub", () => {
    it("rejects if params rejects — same early-params ordering as messages/route.ts", async () => {
        await expect(chatClosePOST(req({ method: "POST" }), { params: explodingParams() })).rejects.toThrow(
            /params awaited/,
        );
    });

    it("returns 501 (not a DB error) when params resolves cleanly", async () => {
        const res = await chatClosePOST(req({ method: "POST" }), {
            params: Promise.resolve({ chatId: "not-a-valid-objectid" }),
        });
        expect(res.status).toBe(501);
    });
});

describe("widget/v1/chats/[chatId]/turn (POST) — direct stub, params never touched", () => {
    it("returns 501 without ever awaiting params, even a rejecting one", async () => {
        const res = await chatTurnPOST(req({ method: "POST" }), { params: explodingParams() });
        expect(res.status).toBe(501);
        expect(await res.text()).toBe("Not implemented");
    });
});
