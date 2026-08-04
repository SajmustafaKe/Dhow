import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * Characterization tests for `app/api/generated-images/[id]` (GET), ahead of
 * the port into apps/dhowx.
 *
 * Pins the parts of this route that are easy to get subtly wrong in a
 * rewrite: the id-to-S3-key sharding formula (`id.slice(-2).padStart(2,'0')`
 * — a 1-character id still produces a valid two-char shard), the FIXED,
 * ORDERED extension probe list (`.png`, `.jpg`, `.webp`) that stops at the
 * first HEAD success (later extensions are never probed), and that a
 * GetObjectCommand failure AFTER a successful HeadObjectCommand still
 * collapses to a generic 404 (the two failure modes are indistinguishable
 * to the caller).
 */

const { sendMock, HeadObjectCommandMock, GetObjectCommandMock, s3ClientConfigs } = vi.hoisted(() => {
    class HeadObjectCommandMock {
        input: { Bucket: string; Key: string };
        constructor(input: { Bucket: string; Key: string }) {
            this.input = input;
        }
    }
    class GetObjectCommandMock {
        input: { Bucket: string; Key: string };
        constructor(input: { Bucket: string; Key: string }) {
            this.input = input;
        }
    }
    return {
        sendMock: vi.fn(),
        HeadObjectCommandMock,
        GetObjectCommandMock,
        s3ClientConfigs: [] as unknown[],
    };
});

vi.mock("@aws-sdk/client-s3", () => ({
    S3Client: class {
        constructor(config: unknown) {
            s3ClientConfigs.push(config);
        }
        send(cmd: unknown) {
            return sendMock(cmd);
        }
    },
    HeadObjectCommand: HeadObjectCommandMock,
    GetObjectCommand: GetObjectCommandMock,
}));

const { GET } = await import("./[id]/route");

const req = () => new NextRequest("http://localhost/api/generated-images/x");
const webBody = (text: string) => ({
    transformToWebStream: () =>
        new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode(text));
                controller.close();
            },
        }),
});

beforeEach(() => {
    s3ClientConfigs.length = 0;
    process.env.RAG_UPLOADS_S3_BUCKET = "test-bucket";
    delete process.env.RAG_UPLOADS_S3_REGION;
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
});

describe("generated-images/[id] (GET)", () => {
    it("400s when id resolves to an empty string, before touching S3 config", async () => {
        const res = await GET(req(), { params: Promise.resolve({ id: "" }) });
        expect(res.status).toBe(400);
        expect(s3ClientConfigs).toHaveLength(0);
    });

    it("500s when RAG_UPLOADS_S3_BUCKET is unset, before constructing an S3Client", async () => {
        delete process.env.RAG_UPLOADS_S3_BUCKET;
        const res = await GET(req(), { params: Promise.resolve({ id: "abc" }) });
        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ error: "S3 bucket not configured" });
        expect(s3ClientConfigs).toHaveLength(0);
    });

    it("passes undefined credentials to S3Client when AWS keys are unset (falls back to default provider chain)", async () => {
        sendMock.mockRejectedValue(new Error("not found"));
        await GET(req(), { params: Promise.resolve({ id: "abc" }) });
        expect(s3ClientConfigs).toEqual([{ region: "us-east-1", credentials: undefined }]);
    });

    it("passes explicit credentials to S3Client when both AWS keys are set", async () => {
        process.env.AWS_ACCESS_KEY_ID = "AKIA_TEST";
        process.env.AWS_SECRET_ACCESS_KEY = "secret";
        sendMock.mockRejectedValue(new Error("not found"));
        await GET(req(), { params: Promise.resolve({ id: "abc" }) });
        expect(s3ClientConfigs).toEqual([
            { region: "us-east-1", credentials: { accessKeyId: "AKIA_TEST", secretAccessKey: "secret" } },
        ]);
    });

    it("shards a 1-character id by left-padding with '0', not throwing on the short slice", async () => {
        sendMock.mockRejectedValue(new Error("not found"));
        await GET(req(), { params: Promise.resolve({ id: "a" }) });
        const headKeys = sendMock.mock.calls
            .map((c) => c[0])
            .filter((c) => c instanceof HeadObjectCommandMock)
            .map((c: InstanceType<typeof HeadObjectCommandMock>) => c.input.Key);
        expect(headKeys).toEqual(["generated_images/0/a/a.png", "generated_images/0/a/a.jpg", "generated_images/0/a/a.webp"]);
    });

    it("404s and probes all three extensions, in order, when none exist", async () => {
        sendMock.mockRejectedValue(new Error("NotFound"));
        const res = await GET(req(), { params: Promise.resolve({ id: "deadbeef" }) });
        expect(res.status).toBe(404);
        const headKeys = sendMock.mock.calls
            .filter((c) => c[0] instanceof HeadObjectCommandMock)
            .map((c) => (c[0] as InstanceType<typeof HeadObjectCommandMock>).input.Key);
        expect(headKeys).toEqual([
            "generated_images/e/f/deadbeef.png",
            "generated_images/e/f/deadbeef.jpg",
            "generated_images/e/f/deadbeef.webp",
        ]);
    });

    it("stops probing at the first extension that HEADs successfully — .webp is never tried when .jpg exists", async () => {
        sendMock.mockImplementation((cmd) => {
            if (cmd instanceof HeadObjectCommandMock) {
                if (cmd.input.Key.endsWith(".jpg")) return Promise.resolve({});
                return Promise.reject(new Error("NotFound"));
            }
            return Promise.resolve({ ContentType: "image/jpeg", Body: webBody("jpg-bytes") });
        });
        const res = await GET(req(), { params: Promise.resolve({ id: "deadbeef" }) });
        expect(res.status).toBe(200);
        const headKeys = sendMock.mock.calls
            .filter((c) => c[0] instanceof HeadObjectCommandMock)
            .map((c) => (c[0] as InstanceType<typeof HeadObjectCommandMock>).input.Key);
        expect(headKeys).toEqual(["generated_images/e/f/deadbeef.png", "generated_images/e/f/deadbeef.jpg"]);
        const getCall = sendMock.mock.calls.find((c) => c[0] instanceof GetObjectCommandMock);
        expect((getCall![0] as InstanceType<typeof GetObjectCommandMock>).input.Key).toBe(
            "generated_images/e/f/deadbeef.jpg",
        );
    });

    it("200s with the S3 object's ContentType and an inline Content-Disposition of `${id}${ext}`", async () => {
        sendMock.mockImplementation((cmd) => {
            if (cmd instanceof HeadObjectCommandMock) return Promise.resolve({});
            return Promise.resolve({ ContentType: "image/png", Body: webBody("png-bytes") });
        });
        const res = await GET(req(), { params: Promise.resolve({ id: "deadbeef" }) });
        expect(res.status).toBe(200);
        expect(res.headers.get("Content-Type")).toBe("image/png");
        expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
        expect(res.headers.get("Content-Disposition")).toBe('inline; filename="deadbeef.png"');
        expect(await res.text()).toBe("png-bytes");
    });

    it("404s (not 500) when HEAD succeeds but the follow-up GetObjectCommand rejects", async () => {
        sendMock.mockImplementation((cmd) => {
            if (cmd instanceof HeadObjectCommandMock) return Promise.resolve({});
            return Promise.reject(new Error("get failed after head succeeded"));
        });
        const res = await GET(req(), { params: Promise.resolve({ id: "deadbeef" }) });
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: "Not found" });
    });
});
