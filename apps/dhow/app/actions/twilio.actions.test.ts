import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Characterization tests for twilio.actions.ts, ahead of the port into
 * apps/dhowx.
 *
 * TENANT/AUTH FINDING (see report): `mockConfigureTwilioNumber` is exported
 * from a `'use server'` file, which makes it a callable RPC endpoint from the
 * browser exactly like every other export here — despite the "Mock
 * implementation for testing/development" comment. Unlike its three siblings
 * (`configureTwilioNumber`, `getTwilioConfigs`, `deleteTwilioConfig`, all of
 * which call `projectAuthCheck(projectId)` first), it calls **no auth check
 * at all** and writes directly to `twilioConfigsCollection` — including
 * `account_sid`/`auth_token` — for whatever `project_id` the caller supplies.
 * That's proven below by driving it through the exact same DB-write path as
 * the real function and asserting `projectAuthCheck` is never invoked.
 *
 * `configureTwilioNumber` has an asymmetry worth pinning too: the
 * `projectAuthCheck` call sits OUTSIDE the function's own try/catch, so an
 * auth failure throws a raw Error, while every *business* failure inside the
 * try block (bad phone number, Twilio API error) is caught and converted to
 * `{ success: false, error }`. Callers cannot treat this function's errors
 * uniformly.
 */

const projectAuthCheck = vi.fn();
vi.mock("./project.actions", () => ({ projectAuthCheck }));

const twilioConfigsCollection = {
    find: vi.fn(),
    findOne: vi.fn(),
    insertOne: vi.fn(),
    updateOne: vi.fn(),
};
vi.mock("../lib/mongodb", () => ({ twilioConfigsCollection }));

function cursor(items: unknown[]) {
    const c = { sort: vi.fn(() => c), limit: vi.fn(() => c), toArray: vi.fn().mockResolvedValue(items) };
    return c;
}

// twilio's `incomingPhoneNumbers` property is both callable (`.incomingPhoneNumbers(sid)`)
// and carries a `.list()` method — a shape a plain vi.fn() alone can't express.
function incomingPhoneNumbers(listImpl: ReturnType<typeof vi.fn>, updateImpl: ReturnType<typeof vi.fn>) {
    const fn = vi.fn(() => ({ update: updateImpl })) as ReturnType<typeof vi.fn> & { list: ReturnType<typeof vi.fn> };
    fn.list = listImpl;
    return fn;
}

const topLevelList = vi.fn(); // twilio(sid, token).incomingPhoneNumbers.list()
const inboundList = vi.fn(); // new Twilio(sid, token).incomingPhoneNumbers.list({phoneNumber})
const inboundUpdate = vi.fn();

vi.mock("twilio", () => {
    const twilioFn = vi.fn(() => ({ incomingPhoneNumbers: incomingPhoneNumbers(topLevelList, inboundUpdate) }));
    const TwilioClass = vi.fn().mockImplementation(function (this: unknown) {
        return { incomingPhoneNumbers: incomingPhoneNumbers(inboundList, inboundUpdate) };
    });
    return { default: twilioFn, Twilio: TwilioClass };
});

const params = {
    project_id: "proj_1",
    phone_number: "+15551234567",
    account_sid: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    auth_token: "authtoken",
    label: "Main line",
};

beforeEach(() => {
    projectAuthCheck.mockReset();
    projectAuthCheck.mockResolvedValue(undefined);
    twilioConfigsCollection.find.mockReset();
    twilioConfigsCollection.findOne.mockReset();
    twilioConfigsCollection.insertOne.mockReset();
    twilioConfigsCollection.updateOne.mockReset();
    topLevelList.mockReset();
    inboundList.mockReset();
    inboundUpdate.mockReset();
    process.env.VOICE_API_URL = "https://voice.example.com";
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
});

async function loadActions() {
    return await import("./twilio.actions");
}

/** Wires every mock needed for a full save-to-Mongo round trip to succeed. */
function wireSuccessfulSave() {
    topLevelList.mockResolvedValue([{ phoneNumber: params.phone_number }]);
    twilioConfigsCollection.find.mockReturnValue(cursor([]));
    twilioConfigsCollection.findOne
        .mockResolvedValueOnce(null) // no existing config for this project
        .mockResolvedValueOnce({ ...params, _id: "cfg_1", createdAt: new Date("2024-01-01T00:00:00.000Z"), status: "active" }); // re-fetch after insert
    inboundList.mockResolvedValue([{ sid: "PN1", voiceUrl: null, statusCallback: null, phoneNumber: params.phone_number }]);
    inboundUpdate.mockResolvedValue({ phoneNumber: params.phone_number, voiceUrl: "https://voice.example.com/api/twilio/inbound_call" });
    twilioConfigsCollection.insertOne.mockResolvedValue({ insertedId: "cfg_1" });
}

describe("configureTwilioNumber", () => {
    it("calls projectAuthCheck(project_id) before doing anything else", async () => {
        wireSuccessfulSave();
        const { configureTwilioNumber } = await loadActions();

        await configureTwilioNumber(params as never);

        expect(projectAuthCheck).toHaveBeenCalledWith(params.project_id);
    });

    it("an authCheck failure throws RAW — it is not caught into {success:false}", async () => {
        projectAuthCheck.mockRejectedValue(new Error("not a project member"));
        const { configureTwilioNumber } = await loadActions();

        // Contrast with the business-failure case below: this rejects with
        // the raw Error, not the {success:false, error} shape.
        await expect(configureTwilioNumber(params as never)).rejects.toThrow("not a project member");
        expect(topLevelList).not.toHaveBeenCalled();
    });

    it("a phone number absent from the Twilio account becomes {success:false, error:'Phone number not found in this account'}", async () => {
        topLevelList.mockResolvedValue([{ phoneNumber: "+19995551234" }]); // does not match params.phone_number
        const { configureTwilioNumber } = await loadActions();

        const result = await configureTwilioNumber(params as never);

        expect(result).toEqual({ success: false, error: "Phone number not found in this account" });
        expect(twilioConfigsCollection.insertOne).not.toHaveBeenCalled();
    });

    it("a Twilio API error during verification is caught and surfaced as {success:false, error:<message>}", async () => {
        topLevelList.mockRejectedValue(new Error("Twilio auth failed"));
        const { configureTwilioNumber } = await loadActions();

        await expect(configureTwilioNumber(params as never)).resolves.toEqual({ success: false, error: "Twilio auth failed" });
    });

    it("success: verifies the number, saves to Mongo, and returns {success:true}", async () => {
        wireSuccessfulSave();
        const { configureTwilioNumber } = await loadActions();

        await expect(configureTwilioNumber(params as never)).resolves.toEqual({ success: true });
        expect(twilioConfigsCollection.insertOne).toHaveBeenCalledTimes(1);
        const saved = twilioConfigsCollection.insertOne.mock.calls[0][0];
        expect(saved).toMatchObject({
            phone_number: params.phone_number,
            account_sid: params.account_sid,
            auth_token: params.auth_token,
            project_id: params.project_id,
            status: "active",
        });
    });
});

describe("getTwilioConfigs", () => {
    it("calls projectAuthCheck first, then queries by projectId + status:'active', newest first, limited to 1", async () => {
        const doc = { _id: { toString: () => "cfg_1" }, project_id: "proj_1", status: "active", createdAt: new Date("2024-01-01T00:00:00.000Z"), phone_number: params.phone_number, account_sid: params.account_sid, auth_token: params.auth_token, label: "L" };
        twilioConfigsCollection.find.mockReturnValue(cursor([doc]));
        const { getTwilioConfigs } = await loadActions();

        const result = await getTwilioConfigs("proj_1");

        expect(projectAuthCheck).toHaveBeenCalledWith("proj_1");
        expect(twilioConfigsCollection.find).toHaveBeenCalledWith({ project_id: "proj_1", status: "active" });
        expect(result).toEqual([{ ...doc, _id: "cfg_1", createdAt: "2024-01-01T00:00:00.000Z" }]);
    });

    it("propagates a projectAuthCheck failure without querying Mongo", async () => {
        projectAuthCheck.mockRejectedValue(new Error("not a project member"));
        const { getTwilioConfigs } = await loadActions();

        await expect(getTwilioConfigs("proj_1")).rejects.toThrow("not a project member");
        expect(twilioConfigsCollection.find).not.toHaveBeenCalled();
    });
});

describe("deleteTwilioConfig — soft delete", () => {
    it("calls projectAuthCheck first, then sets status:'deleted' by _id + project_id (does not remove the document)", async () => {
        twilioConfigsCollection.updateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
        const { deleteTwilioConfig } = await loadActions();
        const configId = "507f1f77bcf86cd799439011";

        await deleteTwilioConfig("proj_1", configId);

        expect(projectAuthCheck).toHaveBeenCalledWith("proj_1");
        const [filter, update] = twilioConfigsCollection.updateOne.mock.calls[0];
        expect(filter).toMatchObject({ project_id: "proj_1" });
        expect(filter._id.toString()).toBe(configId);
        expect(update).toEqual({ $set: { status: "deleted" } });
    });

    it("propagates a projectAuthCheck failure without touching Mongo", async () => {
        projectAuthCheck.mockRejectedValue(new Error("not a project member"));
        const { deleteTwilioConfig } = await loadActions();

        await expect(deleteTwilioConfig("proj_1", "507f1f77bcf86cd799439011")).rejects.toThrow("not a project member");
        expect(twilioConfigsCollection.updateOne).not.toHaveBeenCalled();
    });
});

// Was: "TENANT/AUTH FINDING: no auth check, writes secrets to Mongo for any
// project_id". That pinned a real vulnerability — this is a browser-reachable
// 'use server' RPC that persisted Twilio account_sid/auth_token for whatever
// project_id the caller supplied, with no authorization whatsoever, unlike its
// three siblings. Gated 2026-08-03; the pin is deliberately inverted.
describe("mockConfigureTwilioNumber — authorization", () => {
    it("authorizes the target project before writing anything", async () => {
        vi.useFakeTimers();
        wireSuccessfulSave();
        const { mockConfigureTwilioNumber } = await loadActions();

        const promise = mockConfigureTwilioNumber(params as never);
        await vi.advanceTimersByTimeAsync(1000);
        const result = await promise;
        vi.useRealTimers();

        expect(result).toEqual({ success: true });
        expect(projectAuthCheck).toHaveBeenCalledWith(params.project_id);
        expect(twilioConfigsCollection.insertOne).toHaveBeenCalledTimes(1);
        const saved = twilioConfigsCollection.insertOne.mock.calls[0][0];
        expect(saved).toMatchObject({ account_sid: params.account_sid, auth_token: params.auth_token, project_id: params.project_id });
    });

    it("writes nothing when authorization is refused", async () => {
        // The guard has to run BEFORE the Mongo write, not merely be present —
        // credentials must not land for a project the caller cannot touch.
        wireSuccessfulSave();
        projectAuthCheck.mockRejectedValueOnce(new Error("not authorized"));
        const { mockConfigureTwilioNumber } = await loadActions();

        await expect(mockConfigureTwilioNumber(params as never)).rejects.toThrow(/not authorized/);
        expect(twilioConfigsCollection.insertOne).not.toHaveBeenCalled();
    });
});
