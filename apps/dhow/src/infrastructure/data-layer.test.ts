import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { ObjectId } from "mongodb";
import path from "path";
import fs from "fs";
import IoRedis from "ioredis";
import type { IProjectMembersRepository } from "@/src/application/repositories/project-members.repository.interface";
import type { IDataSourceDocsRepository } from "@/src/application/repositories/data-source-docs.repository.interface";
import type { ComposioConnectedAccount } from "@/src/entities/models/project";
import type { z } from "zod";

/**
 * Characterization tests for the MongoDB / Redis / S3 / local-disk data
 * layer, ahead of the port into apps/dhowx.
 *
 * Nothing here connects to a real database. `@/app/lib/mongodb` and
 * `@/app/lib/redis` are replaced with in-memory fakes that record every call
 * made against them; `ioredis`, `@aws-sdk/client-s3`,
 * `@aws-sdk/s3-request-presigner` and `fs` are mocked the same way. Every
 * repository method under test is exercised through its real class, only the
 * driver boundary is faked — so what's pinned is the actual filter/update
 * object each repository builds, not a hand-written approximation of it.
 *
 * The stack is MongoDB + Qdrant + Redis: there is no schema migration and no
 * SQL string-concatenation surface, so the injection risk that matters here
 * is different from a relational app — it's (a) unsanitised values reaching
 * `$regex`/dynamic `$set` field paths, and (b) documents fetched by `_id`
 * alone with tenant isolation enforced only by *convention* at the call
 * site, never by the query itself. Both show up below.
 *
 * Mongo filter/update shapes are inherently dynamic (arbitrary nested
 * operator objects), so they're typed as `Record<string, unknown>` here
 * rather than reproducing the driver's own generic `Filter<T>` machinery.
 */

// ---------------------------------------------------------------------------
// Mongo fakes
// ---------------------------------------------------------------------------

vi.mock("@/app/lib/mongodb", () => ({ db: { collection: vi.fn() } }));

// eslint-disable-next-line import/order
import { db } from "@/app/lib/mongodb";

type MongoQuery = Record<string, unknown>;
type MongoDoc = Record<string, unknown>;

interface FakeCursor {
    sort: Mock<(spec: Record<string, number>) => FakeCursor>;
    limit: Mock<(n: number) => FakeCursor>;
    skip: Mock<(n: number) => FakeCursor>;
    project: Mock<(spec: Record<string, number>) => FakeCursor>;
    toArray: Mock<() => Promise<MongoDoc[]>>;
}

interface FakeCollection {
    find: Mock<(filter: MongoQuery) => FakeCursor>;
    findOne: Mock<(filter: MongoQuery) => Promise<MongoDoc | null>>;
    findOneAndUpdate: Mock<(filter: MongoQuery, update: MongoQuery, options?: MongoQuery) => Promise<MongoDoc | null>>;
    insertOne: Mock<(doc: MongoDoc) => Promise<{ acknowledged: boolean; insertedId: ObjectId }>>;
    insertMany: Mock<(docs: MongoDoc[]) => Promise<{ acknowledged: boolean; insertedIds: Record<number, ObjectId> }>>;
    updateOne: Mock<(filter: MongoQuery, update: MongoQuery) => Promise<{ matchedCount: number; modifiedCount: number }>>;
    updateMany: Mock<(filter: MongoQuery, update: MongoQuery) => Promise<{ matchedCount: number; modifiedCount: number }>>;
    deleteOne: Mock<(filter: MongoQuery) => Promise<{ deletedCount: number }>>;
    deleteMany: Mock<(filter: MongoQuery) => Promise<{ deletedCount: number }>>;
    countDocuments: Mock<(filter: MongoQuery) => Promise<number>>;
    distinct: Mock<(field: string, filter?: MongoQuery) => Promise<unknown[]>>;
}

interface FakeCollectionEntry {
    collection: FakeCollection;
    cursor: FakeCursor;
}

function makeCursor(): FakeCursor {
    const cursor = {} as FakeCursor;
    cursor.sort = vi.fn(() => cursor);
    cursor.limit = vi.fn(() => cursor);
    cursor.skip = vi.fn(() => cursor);
    cursor.project = vi.fn(() => cursor);
    cursor.toArray = vi.fn(async () => []);
    return cursor;
}

function makeFakeCollection(): FakeCollectionEntry {
    const cursor = makeCursor();
    const collection: FakeCollection = {
        find: vi.fn(() => cursor),
        findOne: vi.fn(async () => null),
        findOneAndUpdate: vi.fn(async () => null),
        insertOne: vi.fn(async () => ({ acknowledged: true, insertedId: new ObjectId() })),
        insertMany: vi.fn(async () => ({ acknowledged: true, insertedIds: {} })),
        updateOne: vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
        updateMany: vi.fn(async () => ({ matchedCount: 0, modifiedCount: 0 })),
        deleteOne: vi.fn(async () => ({ deletedCount: 1 })),
        deleteMany: vi.fn(async () => ({ deletedCount: 0 })),
        countDocuments: vi.fn(async () => 0),
        distinct: vi.fn(async () => []),
    };
    return { collection, cursor };
}

const registry = new Map<string, FakeCollectionEntry>();

function collectionFor(name: string): FakeCollectionEntry {
    let entry = registry.get(name);
    if (!entry) {
        entry = makeFakeCollection();
        registry.set(name, entry);
    }
    return entry;
}

beforeEach(() => {
    registry.clear();
    vi.mocked(db.collection).mockImplementation(((name: string) => collectionFor(name).collection) as unknown as typeof db.collection);
});

// ---------------------------------------------------------------------------
// Redis fakes
// ---------------------------------------------------------------------------

vi.mock("@/app/lib/redis", () => ({
    redisClient: {
        get: vi.fn(),
        set: vi.fn(),
        del: vi.fn(async () => 0),
        incr: vi.fn(async () => 1),
        expire: vi.fn(),
        publish: vi.fn(),
    },
}));

// eslint-disable-next-line import/order
import { redisClient } from "@/app/lib/redis";

interface FakeRedisInstance {
    url: unknown;
    subscribe: Mock<(channel: string) => Promise<void>>;
    unsubscribe: Mock<(channel: string) => Promise<void>>;
    on(event: string, cb: (...args: unknown[]) => void): void;
    emit(event: string, ...args: unknown[]): void;
}
interface FakeRedisCtor {
    instances: FakeRedisInstance[];
}
// `ioredis`'s default export is mocked below with a plain class; the real
// `Redis` type doesn't describe `.instances`, so this one cast documents the
// shape of the test double instead of the real driver.
const FakeIoRedis = IoRedis as unknown as FakeRedisCtor;

vi.mock("ioredis", () => {
    class FakeRedis {
        static instances: FakeRedis[] = [];
        url: unknown;
        handlers = new Map<string, Array<(...args: unknown[]) => void>>();
        subscribe = vi.fn(async () => undefined);
        unsubscribe = vi.fn(async () => undefined);
        constructor(url: unknown) {
            this.url = url;
            FakeRedis.instances.push(this);
        }
        on(event: string, cb: (...args: unknown[]) => void) {
            if (!this.handlers.has(event)) this.handlers.set(event, []);
            this.handlers.get(event)!.push(cb);
        }
        emit(event: string, ...args: unknown[]) {
            for (const cb of this.handlers.get(event) ?? []) cb(...args);
        }
    }
    return { default: FakeRedis };
});

// ---------------------------------------------------------------------------
// AWS S3 + fs fakes
// ---------------------------------------------------------------------------

interface FakeS3ClientOpts {
    region: string;
    credentials: { accessKeyId: string; secretAccessKey: string };
}

vi.mock("@aws-sdk/client-s3", () => {
    class S3Client {
        opts: FakeS3ClientOpts;
        send = vi.fn();
        constructor(opts: FakeS3ClientOpts) {
            this.opts = opts;
        }
    }
    class GetObjectCommand {
        input: Record<string, unknown>;
        constructor(input: Record<string, unknown>) {
            this.input = input;
        }
    }
    class PutObjectCommand {
        input: Record<string, unknown>;
        constructor(input: Record<string, unknown>) {
            this.input = input;
        }
    }
    return { S3Client, GetObjectCommand, PutObjectCommand };
});

vi.mock("@aws-sdk/s3-request-presigner", () => ({
    getSignedUrl: vi.fn(
        async (_client: unknown, command: { input: unknown }, opts: { expiresIn: number }) =>
            `signed:${JSON.stringify(command.input)}:${opts.expiresIn}`,
    ),
}));

vi.mock("fs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("fs")>();
    const readFileSync = vi.fn(() => Buffer.from("file-bytes"));
    return { ...actual, readFileSync, default: { ...actual, readFileSync } };
});

// ---------------------------------------------------------------------------
// Repository / service imports (real classes, faked drivers)
// ---------------------------------------------------------------------------

import { MongoDBJobsRepository } from "@/src/infrastructure/repositories/mongodb.jobs.repository";
import { MongoDBDataSourcesRepository } from "@/src/infrastructure/repositories/mongodb.data-sources.repository";
import { MongoDBDataSourceDocsRepository } from "@/src/infrastructure/repositories/mongodb.data-source-docs.repository";
import { MongoDBAssistantTemplatesRepository } from "@/src/infrastructure/repositories/mongodb.assistant-templates.repository";
import { MongodbProjectsRepository } from "@/src/infrastructure/repositories/mongodb.projects.repository";
import { MongoDBProjectMembersRepository } from "@/src/infrastructure/repositories/mongodb.project-members.repository";
import { MongodbComposioTriggerDeploymentsRepository } from "@/src/infrastructure/repositories/mongodb.composio-trigger-deployments.repository";
import { MongoDBApiKeysRepository } from "@/src/infrastructure/repositories/mongodb.api-keys.repository";
import { MongoDBConversationsRepository } from "@/src/infrastructure/repositories/mongodb.conversations.repository";
import { MongoDBScheduledJobRulesRepository } from "@/src/infrastructure/repositories/mongodb.scheduled-job-rules.repository";
import { MongoDBRecurringJobRulesRepository } from "@/src/infrastructure/repositories/mongodb.recurring-job-rules.repository";
import { MongoDBUsersRepository } from "@/src/infrastructure/repositories/mongodb.users.repository";
import { RedisCacheService } from "@/src/infrastructure/services/redis.cache.service";
import { RedisPubSubService } from "@/src/infrastructure/services/redis.pub-sub.service";
import { S3UploadsStorageService } from "@/src/infrastructure/services/s3.uploads-storage.service";
import { LocalUploadsStorageService } from "@/src/infrastructure/services/local.uploads-storage.service";

// A stub satisfying only the members these tests actually exercise (neither
// dependency is called by the methods under test). Cast once, here, rather
// than implementing the full interface for an unused collaborator.
const unusedProjectMembersRepository = {} as unknown as IProjectMembersRepository;
const fakeDataSourceDocsRepository = (fetch: Mock<(id: string) => Promise<unknown>>) =>
    ({ fetch }) as unknown as IDataSourceDocsRepository;

// =============================================================================
// MongoDBJobsRepository
// =============================================================================

describe("MongoDBJobsRepository.list", () => {
    it("scopes the query to the given projectId", async () => {
        const repo = new MongoDBJobsRepository();
        await repo.list("proj_1");
        const { collection } = collectionFor("jobs");
        expect(collection.find.mock.calls[0][0]).toMatchObject({ projectId: "proj_1" });
    });

    it("BUG: createdBefore silently overwrites createdAfter instead of producing a closed range", async () => {
        // Both branches assign to `query.createdAt` directly (jobs.list, lines
        // ~229-235). The second `if` that matches replaces the first outright —
        // there is no `{ ...query.createdAt, $lte }` merge. A caller who passes
        // both createdAfter and createdBefore gets an unbounded-below query, not
        // the closed date range the two fields imply. Pinning this so a port
        // that "fixes" it (merges into {$gte,$lte}) does so deliberately.
        const repo = new MongoDBJobsRepository();
        await repo.list("proj_1", {
            createdAfter: "2024-01-01T00:00:00.000Z",
            createdBefore: "2024-06-01T00:00:00.000Z",
        });
        const { collection } = collectionFor("jobs");
        const query = collection.find.mock.calls[0][0];
        expect(query.createdAt).toEqual({ $lte: "2024-06-01T00:00:00.000Z" });
    });

    it("recurringJobRuleId filters on a dotted reason.* path", async () => {
        const repo = new MongoDBJobsRepository();
        await repo.list("proj_1", { recurringJobRuleId: "rule_1" });
        const { collection } = collectionFor("jobs");
        const query = collection.find.mock.calls[0][0];
        expect(query["reason.type"]).toBe("recurring_job_rule");
        expect(query["reason.ruleId"]).toBe("rule_1");
    });

    it("caps the requested page size at 50, fetching one extra row as a has-next-page probe", async () => {
        const repo = new MongoDBJobsRepository();
        await repo.list("proj_1", undefined, undefined, 500);
        const { cursor } = collectionFor("jobs");
        expect(cursor.limit).toHaveBeenCalledWith(51);
    });

    it("cursor pagination is strict-less-than on _id, sorted newest first", async () => {
        const repo = new MongoDBJobsRepository();
        const cursorId = new ObjectId();
        await repo.list("proj_1", undefined, cursorId.toString());
        const { collection, cursor } = collectionFor("jobs");
        const query = collection.find.mock.calls[0][0];
        expect(query._id).toEqual({ $lt: cursorId });
        expect(cursor.sort).toHaveBeenCalledWith({ _id: -1 });
    });
});

// =============================================================================
// MongoDBDataSourcesRepository
// =============================================================================

describe("MongoDBDataSourcesRepository.list", () => {
    it("defaults to excluding deleted sources via status:{$ne:'deleted'}", async () => {
        const repo = new MongoDBDataSourcesRepository();
        await repo.list("proj_1");
        const { collection } = collectionFor("sources");
        expect(collection.find.mock.calls[0][0]).toEqual({ projectId: "proj_1", status: { $ne: "deleted" } });
    });

    it("filters.deleted === true flips status to the exact literal 'deleted' (replaces the $ne, doesn't intersect it)", async () => {
        const repo = new MongoDBDataSourcesRepository();
        await repo.list("proj_1", { deleted: true });
        const { collection } = collectionFor("sources");
        expect(collection.find.mock.calls[0][0].status).toBe("deleted");
    });

    it("filters.deleted === false does NOT flip the default — only strict `true` matches", async () => {
        const repo = new MongoDBDataSourcesRepository();
        await repo.list("proj_1", { deleted: false });
        const { collection } = collectionFor("sources");
        expect(collection.find.mock.calls[0][0].status).toEqual({ $ne: "deleted" });
    });

    it("active filter applies for any real boolean, including `false` (typeof check, not truthiness)", async () => {
        const repo = new MongoDBDataSourcesRepository();
        await repo.list("proj_1", { active: false });
        const { collection } = collectionFor("sources");
        expect(collection.find.mock.calls[0][0].active).toBe(false);
    });
});

// =============================================================================
// MongoDBDataSourceDocsRepository
// =============================================================================

describe("MongoDBDataSourceDocsRepository.list", () => {
    it("defaults to excluding deleted docs for a source", async () => {
        const repo = new MongoDBDataSourceDocsRepository();
        await repo.list("src_1");
        const { collection } = collectionFor("source_docs");
        expect(collection.find.mock.calls[0][0]).toEqual({ sourceId: "src_1", status: { $ne: "deleted" } });
    });

    it("BUG: an explicit status filter REPLACES the default exclusion — ['deleted'] can be requested back in", async () => {
        // `query.status = { $in: filters.status }` (line 76) overwrites the
        // `{ $ne: 'deleted' }` set two lines earlier rather than intersecting
        // with it, so `list(sourceId, { status: ['deleted'] })` returns exactly
        // the docs the default is supposed to hide.
        const repo = new MongoDBDataSourceDocsRepository();
        await repo.list("src_1", { status: ["deleted"] });
        const { collection } = collectionFor("source_docs");
        expect(collection.find.mock.calls[0][0].status).toEqual({ $in: ["deleted"] });
    });
});

// =============================================================================
// MongoDBAssistantTemplatesRepository
// =============================================================================

describe("MongoDBAssistantTemplatesRepository", () => {
    it("queries 'assistant_templates' / 'assistant_template_likes' — NOT the indexed 'community_assistants' pair", async () => {
        // mongodb.community-assistants.indexes.ts defines COMMUNITY_ASSISTANTS_COLLECTION
        // = "community_assistants" and ensure-indexes.ts calls createIndexes()
        // against it, but this repository (the only thing that actually reads or
        // writes assistant templates — see app/actions/assistant-templates.actions.ts
        // and app/actions/project.actions.ts) hard-codes "assistant_templates" /
        // "assistant_template_likes". The two collection names never intersect:
        // ensureAllIndexes() ensures indexes on a collection nothing queries, and
        // the collection actually queried (with category/isPublic/featured/$or
        // regex filters, per the list() test below) has NO indexes beyond the
        // default _id — see the review notes for the missing-index writeup.
        new MongoDBAssistantTemplatesRepository();
        expect(db.collection).toHaveBeenCalledWith("assistant_templates");
        expect(db.collection).toHaveBeenCalledWith("assistant_template_likes");
        expect(db.collection).not.toHaveBeenCalledWith("community_assistants");
        expect(db.collection).not.toHaveBeenCalledWith("community_assistant_likes");
    });

    // Was two findings: "filters.search reaches $regex/RegExp verbatim,
    // unescaped" and "an unbalanced-paren search string crashes list() with an
    // uncaught SyntaxError". Both fixed 2026-08-03 by escaping the input; the
    // pins are deliberately inverted.
    it("escapes regex metacharacters in search before they reach $regex", async () => {
        // `search` is a substring match, so metacharacters carry no meaning for
        // the caller. Leaving them live made every query a caller-supplied regex
        // evaluated per-document by mongod — a ReDoS surface.
        const repo = new MongoDBAssistantTemplatesRepository();
        await repo.list({ search: "a.*b" });
        const { collection } = collectionFor("assistant_templates");
        const query = collection.find.mock.calls[0][0] as { $or: Array<Record<string, unknown>> };

        expect(query.$or[0]).toEqual({ name: { $regex: "a\\.\\*b", $options: "i" } });
        expect(query.$or[1]).toEqual({ description: { $regex: "a\\.\\*b", $options: "i" } });
        const tagsIn = (query.$or[2] as { tags: { $in: RegExp[] } }).tags.$in[0];
        expect(tagsIn).toBeInstanceOf(RegExp);
        expect(tagsIn.source).toBe("a\\.\\*b");
    });

    it("treats an unbalanced paren as literal text instead of crashing", async () => {
        // Previously threw SyntaxError straight out of list() — a caller-
        // triggerable 500 on the templates listing endpoint from ordinary text.
        const repo = new MongoDBAssistantTemplatesRepository();
        await expect(repo.list({ search: "a(b" })).resolves.toBeDefined();

        const { collection } = collectionFor("assistant_templates");
        const query = collection.find.mock.calls[0][0] as { $or: Array<Record<string, unknown>> };
        expect(query.$or[0]).toEqual({ name: { $regex: "a\\(b", $options: "i" } });
    });

    it("still matches the literal text a user typed", async () => {
        // Escaping must not break ordinary search: plain alphanumeric input is
        // passed through untouched.
        const repo = new MongoDBAssistantTemplatesRepository();
        await repo.list({ search: "customer support" });
        const { collection } = collectionFor("assistant_templates");
        const query = collection.find.mock.calls[0][0] as { $or: Array<Record<string, unknown>> };
        expect(query.$or[0]).toEqual({ name: { $regex: "customer support", $options: "i" } });
    });

    it("only sets category/featured/isPublic/authorId/source when explicitly provided", async () => {
        const repo = new MongoDBAssistantTemplatesRepository();
        await repo.list({ featured: false });
        const { collection } = collectionFor("assistant_templates");
        // `featured: false` must still be applied (undefined-check, not
        // truthiness) while every other unset filter is left off the query.
        expect(collection.find.mock.calls[0][0]).toEqual({ featured: false });
    });

    it("pagination is skip/limit (offset-based), not an _id cursor like every other repository here", async () => {
        const repo = new MongoDBAssistantTemplatesRepository();
        await repo.list({}, "40", 20);
        const { cursor } = collectionFor("assistant_templates");
        expect(cursor.skip).toHaveBeenCalledWith(40);
        expect(cursor.limit).toHaveBeenCalledWith(20);
    });
});

// =============================================================================
// MongodbProjectsRepository — dynamic $set field paths
// =============================================================================

describe("MongodbProjectsRepository dynamic key paths", () => {
    const repo = () => new MongodbProjectsRepository({ projectMembersRepository: unusedProjectMembersRepository });

    const account: z.infer<typeof ComposioConnectedAccount> = {
        id: "acc_1",
        authConfigId: "cfg_1",
        status: "ACTIVE",
        createdAt: "2024-01-01T00:00:00.000Z",
        lastUpdatedAt: "2024-01-01T00:00:00.000Z",
    };

    it("addComposioConnectedAccount builds the $set key by string-interpolating the toolkit slug", async () => {
        const { collection } = collectionFor("projects");
        collection.findOneAndUpdate.mockResolvedValueOnce({ _id: "proj_1", name: "p" });
        const r = repo();
        await r.addComposioConnectedAccount("proj_1", { toolkitSlug: "github", data: account });
        const [, update] = collection.findOneAndUpdate.mock.calls[0];
        expect(Object.keys(update.$set as Record<string, unknown>)).toContain("composioConnectedAccounts.github");
    });

    // Was: "FIELD-PATH RISK: a toolkitSlug containing a dot is not rejected".
    // Mongo treats dots in an update field path as nesting, so a slug of "a.b"
    // wrote to composioConnectedAccounts.a.b rather than a key literally named
    // "a.b" — a different document location than the caller named. Guarded
    // 2026-08-03 at all four interpolation sites; the pin is inverted.
    it("rejects a toolkitSlug containing a dot instead of deepening the $set path", async () => {
        const { collection } = collectionFor("projects");
        const r = repo();

        await expect(
            r.addComposioConnectedAccount("proj_1", { toolkitSlug: "a.b", data: account }),
        ).rejects.toThrow(/toolkitSlug/);
        // Nothing is written — the guard runs before the update is issued.
        expect(collection.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it("rejects a toolkitSlug beginning with $", async () => {
        const { collection } = collectionFor("projects");
        const r = repo();

        await expect(
            r.addComposioConnectedAccount("proj_1", { toolkitSlug: "$set", data: account }),
        ).rejects.toThrow(/toolkitSlug/);
        expect(collection.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it("rejects a dotted customMcpServers name on the same guard", async () => {
        const { collection } = collectionFor("projects");
        const r = repo();

        await expect(
            r.addCustomMcpServer("proj_1", { name: "a.b", data: { url: "https://x" } } as never),
        ).rejects.toThrow(/name/);
        expect(collection.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it("still accepts an ordinary slug", async () => {
        const { collection } = collectionFor("projects");
        collection.findOneAndUpdate.mockResolvedValueOnce({ _id: "proj_1", name: "p" });
        const r = repo();

        await r.addComposioConnectedAccount("proj_1", { toolkitSlug: "github", data: account });
        const [, update] = collection.findOneAndUpdate.mock.calls[0];
        expect(Object.keys(update.$set as Record<string, unknown>)).toContain(
            "composioConnectedAccounts.github",
        );
    });

    it("every mutation is scoped to the project by _id — no separate ownership check inside the repository", async () => {
        const { collection } = collectionFor("projects");
        collection.findOneAndUpdate.mockResolvedValueOnce({ _id: "proj_1", name: "p" });
        const r = repo();
        await r.updateName("proj_1", "New Name");
        const [filter] = collection.findOneAndUpdate.mock.calls[0];
        expect(filter).toEqual({ _id: "proj_1" });
    });
});

// =============================================================================
// MongoDBProjectMembersRepository
// =============================================================================

describe("MongoDBProjectMembersRepository.findByUserId", () => {
    it("filters strictly by userId with a $lt _id cursor — this method is NOT project-scoped (by design: it lists a user's projects)", async () => {
        const repo = new MongoDBProjectMembersRepository();
        const cursorId = new ObjectId();
        await repo.findByUserId("user_1", cursorId.toString());
        const { collection, cursor } = collectionFor("project_members");
        expect(collection.find.mock.calls[0][0]).toEqual({ userId: "user_1", _id: { $lt: cursorId } });
        expect(cursor.sort).toHaveBeenCalledWith({ _id: -1 });
    });

    it("exists() scopes strictly by BOTH projectId and userId (the actual membership check)", async () => {
        const repo = new MongoDBProjectMembersRepository();
        await repo.exists("proj_1", "user_1");
        const { collection } = collectionFor("project_members");
        expect(collection.findOne.mock.calls[0][0]).toEqual({ projectId: "proj_1", userId: "user_1" });
    });
});

// =============================================================================
// MongodbComposioTriggerDeploymentsRepository
// =============================================================================

describe("MongodbComposioTriggerDeploymentsRepository.listByProjectId", () => {
    it("INCONSISTENCY: paginates ascending with a $gt cursor — the opposite direction of every other list() in this app", async () => {
        // jobs, conversations, data-sources, project-members, scheduled/recurring
        // job rules all sort { _id: -1 } with a $lt cursor (newest page first).
        // This repository sorts { _id: 1 } with $gt (oldest page first). Neither
        // is wrong in isolation, but a port that normalizes pagination direction
        // across repositories will flip this endpoint's page order unless it's
        // deliberately special-cased.
        const repo = new MongodbComposioTriggerDeploymentsRepository();
        const cursorId = new ObjectId();
        await repo.listByProjectId("proj_1", cursorId.toString());
        const { collection, cursor } = collectionFor("composio_trigger_deployments");
        const query = collection.find.mock.calls[0][0];
        expect(query._id).toEqual({ $gt: cursorId });
        expect(cursor.sort).toHaveBeenCalledWith({ _id: 1 });
    });

    it("fetch(id) and fetchByComposioTriggerId(id) are NOT scoped by projectId at the query level", async () => {
        // Tenant isolation for these two lookups depends entirely on the calling
        // use-case re-deriving projectId from the returned document and
        // authorizing against it (verified by reading
        // delete-composio-trigger-deployment.use-case.ts and
        // fetch-composio-trigger-deployment.use-case.ts, both of which do this
        // correctly). The repository itself provides no such guarantee — see the
        // review notes.
        const repo = new MongodbComposioTriggerDeploymentsRepository();
        await repo.fetch(new ObjectId().toString());
        await repo.fetchByComposioTriggerId("trigger_1");
        const { collection } = collectionFor("composio_trigger_deployments");
        expect(collection.findOne.mock.calls[0][0]).toEqual({ _id: expect.any(ObjectId) });
        expect(collection.findOne.mock.calls[1][0]).toEqual({ triggerId: "trigger_1" });
    });
});

// =============================================================================
// MongoDBApiKeysRepository
// =============================================================================

describe("MongoDBApiKeysRepository", () => {
    it("checkAndConsumeKey scopes the lookup by both projectId and the raw key", async () => {
        const repo = new MongoDBApiKeysRepository();
        await repo.checkAndConsumeKey("proj_1", "sk_live_123");
        const { collection } = collectionFor("api_keys");
        expect(collection.findOneAndUpdate.mock.calls[0][0]).toEqual({ projectId: "proj_1", key: "sk_live_123" });
    });

    it("listAll and deleteAll both scope by projectId", async () => {
        const repo = new MongoDBApiKeysRepository();
        await repo.listAll("proj_1");
        await repo.deleteAll("proj_1");
        const { collection } = collectionFor("api_keys");
        expect(collection.find.mock.calls[0][0]).toEqual({ projectId: "proj_1" });
        expect(collection.deleteMany.mock.calls[0][0]).toEqual({ projectId: "proj_1" });
    });

    it("delete(projectId, id) requires BOTH to match — a key id from another project cannot be deleted", async () => {
        const repo = new MongoDBApiKeysRepository();
        const keyId = new ObjectId();
        await repo.delete("proj_1", keyId.toString());
        const { collection } = collectionFor("api_keys");
        expect(collection.deleteOne.mock.calls[0][0]).toEqual({ projectId: "proj_1", _id: keyId });
    });
});

// =============================================================================
// MongoDBConversationsRepository
// =============================================================================

describe("MongoDBConversationsRepository", () => {
    it("addTurn appends via $push and stamps updatedAt via a separate $set — no projectId re-check on write", async () => {
        const repo = new MongoDBConversationsRepository();
        await repo.addTurn(new ObjectId().toString(), { role: "user", content: "hi" } as never);
        const { collection } = collectionFor("conversations");
        const [filter, update] = collection.updateOne.mock.calls[0];
        expect(Object.keys(filter)).toEqual(["_id"]);
        expect(Object.keys(update).sort()).toEqual(["$push", "$set"]);
        expect(update.$push).toHaveProperty("turns");
    });

    it("list() projects a reduced field set, not the full document (turns/messages excluded from list views)", async () => {
        const repo = new MongoDBConversationsRepository();
        await repo.list("proj_1");
        const { cursor } = collectionFor("conversations");
        expect(cursor.project).toHaveBeenCalledWith({
            _id: 1,
            projectId: 1,
            createdAt: 1,
            updatedAt: 1,
            reason: 1,
        });
    });
});

// =============================================================================
// MongoDBScheduledJobRulesRepository
// =============================================================================

describe("MongoDBScheduledJobRulesRepository", () => {
    it("rounds nextRunAt DOWN to the last whole minute (seconds since epoch)", async () => {
        const { collection } = collectionFor("scheduled_job_rules");
        collection.insertOne.mockResolvedValueOnce({ acknowledged: true, insertedId: new ObjectId() });
        const repo = new MongoDBScheduledJobRulesRepository();
        // 12:00:45 UTC must round down to 12:00:00 UTC, not up and not to the
        // nearest second.
        const result = await repo.create({
            scheduledTime: "2024-01-01T12:00:45.000Z",
            projectId: "proj_1",
            input: {},
        } as never);
        expect(result.nextRunAt).toBe("2024-01-01T12:00:00.000Z");
    });

    it("poll() only claims rules whose nextRunAt fell within the last 3 minutes — stale rules are skipped, not caught up", async () => {
        const repo = new MongoDBScheduledJobRulesRepository();
        const before = Date.now();
        await repo.poll("worker_1");
        const { collection } = collectionFor("scheduled_job_rules");
        const [filter] = collection.findOneAndUpdate.mock.calls[0] as unknown as [{ nextRunAt: { $lte: number; $gte: number } }];
        const nowSec = Math.floor(before / 1000);
        expect(filter.nextRunAt.$lte).toBeGreaterThanOrEqual(nowSec);
        const windowSeconds = filter.nextRunAt.$lte - filter.nextRunAt.$gte;
        expect(windowSeconds).toBe(180); // exactly 3 minutes, hard-coded
    });
});

// =============================================================================
// MongoDBRecurringJobRulesRepository
// =============================================================================

describe("MongoDBRecurringJobRulesRepository", () => {
    it("create() recomputes nextRunAt from the cron expression rather than leaving the 0 placeholder", async () => {
        const { collection } = collectionFor("recurring_job_rules");
        collection.insertOne.mockResolvedValueOnce({ acknowledged: true, insertedId: new ObjectId() });
        collection.findOneAndUpdate.mockResolvedValueOnce({
            _id: new ObjectId(),
            projectId: "proj_1",
            cron: "0 0 * * *",
            nextRunAt: 0,
            disabled: false,
            workerId: null,
            lastWorkerId: null,
            createdAt: "now",
            input: {},
        });
        const repo = new MongoDBRecurringJobRulesRepository();
        await repo.create({ projectId: "proj_1", cron: "0 0 * * *", input: {} } as never);
        const [, update] = collection.findOneAndUpdate.mock.calls[0];
        const set = update.$set as { nextRunAt: number };
        expect(set.nextRunAt).toBeGreaterThan(0);
    });

    it("list() scopes strictly by projectId with a descending _id cursor", async () => {
        const repo = new MongoDBRecurringJobRulesRepository();
        const cursorId = new ObjectId();
        await repo.list("proj_1", cursorId.toString());
        const { collection, cursor } = collectionFor("recurring_job_rules");
        expect(collection.find.mock.calls[0][0]).toEqual({ projectId: "proj_1", _id: { $lt: cursorId } });
        expect(cursor.sort).toHaveBeenCalledWith({ _id: -1 });
    });
});

// =============================================================================
// MongoDBUsersRepository
// =============================================================================

describe("MongoDBUsersRepository.fetchByAuthId", () => {
    it("looks up by the external authId field, not by _id", async () => {
        const repo = new MongoDBUsersRepository();
        await repo.fetchByAuthId("supabase-uid-abc123");
        const { collection } = collectionFor("users");
        expect(collection.findOne).toHaveBeenCalledWith({ authId: "supabase-uid-abc123" });
    });
});

// =============================================================================
// RedisCacheService
// =============================================================================

describe("RedisCacheService", () => {
    it("passes ttl as an EX argument only when a ttl is given", async () => {
        const svc = new RedisCacheService();
        await svc.set("k1", "v1", 60);
        expect(redisClient.set).toHaveBeenCalledWith("k1", "v1", "EX", 60);
    });

    it("omits EX entirely when no ttl is given — the key persists forever", async () => {
        const svc = new RedisCacheService();
        await svc.set("k1", "v1");
        expect(redisClient.set).toHaveBeenCalledWith("k1", "v1");
    });

    it("delete() reports success only when a key was actually removed (del count > 0)", async () => {
        const svc = new RedisCacheService();
        vi.mocked(redisClient.del).mockResolvedValueOnce(0);
        expect(await svc.delete("missing")).toBe(false);
        vi.mocked(redisClient.del).mockResolvedValueOnce(1);
        expect(await svc.delete("present")).toBe(true);
    });
});

// =============================================================================
// RedisPubSubService
// =============================================================================

describe("RedisPubSubService", () => {
    beforeEach(() => {
        FakeIoRedis.instances.length = 0;
    });

    it("CONNECTION LIFECYCLE: opens its own dedicated subscriber connection at construction time", () => {
        new RedisPubSubService();
        expect(FakeIoRedis.instances).toHaveLength(1);
    });

    it("CONNECTION LIFECYCLE: every new instance opens another connection — no pooling/reuse across instances", () => {
        // The DI container (di/container.ts) registers this as .singleton(), so
        // in practice exactly one of these is built per process. But nothing in
        // the class itself enforces that: constructing it twice (e.g. from two
        // separate DI containers in a test, or a port that forgets .singleton())
        // opens two live Redis subscriber sockets.
        new RedisPubSubService();
        new RedisPubSubService();
        expect(FakeIoRedis.instances).toHaveLength(2);
    });

    it("publish() delegates to the SHARED redisClient, not the dedicated subscriber connection", async () => {
        const svc = new RedisPubSubService();
        await svc.publish("chan", "msg");
        expect(redisClient.publish).toHaveBeenCalledWith("chan", "msg");
        const sub = FakeIoRedis.instances[0];
        expect(sub.subscribe).not.toHaveBeenCalled();
    });

    it("subscribes to the Redis channel only when the FIRST local handler is added", async () => {
        const svc = new RedisPubSubService();
        const sub = FakeIoRedis.instances[0];
        await svc.subscribe("chan", vi.fn());
        await svc.subscribe("chan", vi.fn());
        expect(sub.subscribe).toHaveBeenCalledTimes(1);
        expect(sub.subscribe).toHaveBeenCalledWith("chan");
    });

    it("unsubscribes from Redis only once the LAST local handler is removed", async () => {
        const svc = new RedisPubSubService();
        const sub = FakeIoRedis.instances[0];
        const s1 = await svc.subscribe("chan", vi.fn());
        const s2 = await svc.subscribe("chan", vi.fn());
        await s1.unsubscribe();
        expect(sub.unsubscribe).not.toHaveBeenCalled();
        await s2.unsubscribe();
        expect(sub.unsubscribe).toHaveBeenCalledWith("chan");
    });

    it("fans an incoming Redis message out to every locally-registered handler on that channel", async () => {
        const svc = new RedisPubSubService();
        const sub = FakeIoRedis.instances[0];
        const h1 = vi.fn();
        const h2 = vi.fn();
        await svc.subscribe("chan", h1);
        await svc.subscribe("chan", h2);
        sub.emit("message", "chan", "payload");
        expect(h1).toHaveBeenCalledWith("payload");
        expect(h2).toHaveBeenCalledWith("payload");
    });
});

// =============================================================================
// RedisUsageQuotaPolicy — module-scope env constants, needs a fresh import
// =============================================================================

describe("RedisUsageQuotaPolicy", () => {
    beforeEach(() => {
        vi.resetModules();
    });

    async function loadWithLimit(env: Record<string, string | undefined>) {
        for (const [key, value] of Object.entries(env)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        const redisMod = await import("@/app/lib/redis");
        const { RedisUsageQuotaPolicy } = await import(
            "@/src/infrastructure/policies/redis.usage-quota.policy"
        );
        vi.clearAllMocks();
        return { redisClient: redisMod.redisClient, RedisUsageQuotaPolicy };
    }

    it("is a no-op when MAX_QUERIES_PER_MINUTE is unset (defaults to 0 = disabled)", async () => {
        const { redisClient: rc, RedisUsageQuotaPolicy } = await loadWithLimit({
            MAX_QUERIES_PER_MINUTE: undefined,
        });
        const policy = new RedisUsageQuotaPolicy();
        await policy.assertAndConsumeProjectAction("proj_1");
        expect(rc.incr).not.toHaveBeenCalled();
    });

    it("keys the rate limit by project AND a 60-second time bucket", async () => {
        const { redisClient: rc, RedisUsageQuotaPolicy } = await loadWithLimit({
            MAX_QUERIES_PER_MINUTE: "5",
        });
        vi.mocked(rc.incr).mockResolvedValueOnce(1);
        const policy = new RedisUsageQuotaPolicy();
        await policy.assertAndConsumeProjectAction("proj_1");
        const key = vi.mocked(rc.incr).mock.calls[0][0];
        expect(key).toMatch(/^rate_limit:proj_1:\d+$/);
    });

    it("allows exactly the limit through and rejects only once the count exceeds it (strict >, not >=)", async () => {
        const { redisClient: rc, RedisUsageQuotaPolicy } = await loadWithLimit({
            MAX_QUERIES_PER_MINUTE: "5",
        });
        const policy = new RedisUsageQuotaPolicy();

        vi.mocked(rc.incr).mockResolvedValueOnce(5);
        await expect(policy.assertAndConsumeProjectAction("proj_1")).resolves.toBeUndefined();

        vi.mocked(rc.incr).mockResolvedValueOnce(6);
        await expect(policy.assertAndConsumeProjectAction("proj_1")).rejects.toThrow(/Quota exceeded/);
    });

    it("sets a TTL only on the first request in a window (count === 1), not on every request", async () => {
        const { redisClient: rc, RedisUsageQuotaPolicy } = await loadWithLimit({
            MAX_QUERIES_PER_MINUTE: "5",
        });
        const policy = new RedisUsageQuotaPolicy();

        vi.mocked(rc.incr).mockResolvedValueOnce(1);
        await policy.assertAndConsumeProjectAction("proj_1");
        expect(rc.expire).toHaveBeenCalledTimes(1);

        vi.mocked(rc.incr).mockResolvedValueOnce(2);
        await policy.assertAndConsumeProjectAction("proj_1");
        expect(rc.expire).toHaveBeenCalledTimes(1); // still 1, not re-armed
    });
});

// =============================================================================
// S3UploadsStorageService
// =============================================================================

interface S3ServiceInternals {
    bucket: string;
    s3Client: { opts: FakeS3ClientOpts };
}

describe("S3UploadsStorageService", () => {
    const withEnv = (overrides: Record<string, string | undefined>, fn: () => void) => {
        const prev: Record<string, string | undefined> = {};
        for (const key of Object.keys(overrides)) prev[key] = process.env[key];
        for (const [key, value] of Object.entries(overrides)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        try {
            fn();
        } finally {
            for (const [key, value] of Object.entries(prev)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
        }
    };

    it("wires bucket/region/credentials from env, defaulting region to us-east-1 and everything else to ''", () => {
        withEnv(
            {
                UPLOADS_AWS_REGION: undefined,
                AWS_ACCESS_KEY_ID: undefined,
                AWS_SECRET_ACCESS_KEY: undefined,
                RAG_UPLOADS_S3_BUCKET: undefined,
            },
            () => {
                const svc = new S3UploadsStorageService({
                    dataSourceDocsRepository: fakeDataSourceDocsRepository(vi.fn()),
                }) as unknown as S3ServiceInternals;
                expect(svc.bucket).toBe("");
                expect(svc.s3Client.opts).toEqual({
                    region: "us-east-1",
                    credentials: { accessKeyId: "", secretAccessKey: "" },
                });
            },
        );
    });

    it("getUploadUrl signs a PutObjectCommand with a 600s (10 minute) expiry", async () => {
        const svc = new S3UploadsStorageService({ dataSourceDocsRepository: fakeDataSourceDocsRepository(vi.fn()) });
        const url = await svc.getUploadUrl("key1", "text/plain");
        expect(url).toContain(":600");
    });

    it("getDownloadUrl rejects a doc whose data isn't an S3 file instead of signing a bogus key", async () => {
        const fetch = vi.fn().mockResolvedValue({
            id: "doc1",
            data: { type: "file_local", path: "/api/uploads/doc1" },
        });
        const svc = new S3UploadsStorageService({ dataSourceDocsRepository: fakeDataSourceDocsRepository(fetch) });
        await expect(svc.getDownloadUrl("doc1")).rejects.toThrow(/not an S3 file/);
    });

    it("getDownloadUrl signs a GetObjectCommand for the stored s3Key with a 60s expiry", async () => {
        const fetch = vi.fn().mockResolvedValue({
            id: "doc1",
            data: { type: "file_s3", s3Key: "projects/p1/doc1" },
        });
        const svc = new S3UploadsStorageService({ dataSourceDocsRepository: fakeDataSourceDocsRepository(fetch) });
        const url = await svc.getDownloadUrl("doc1");
        expect(url).toContain("projects/p1/doc1");
        expect(url).toContain(":60");
    });
});

// =============================================================================
// LocalUploadsStorageService
// =============================================================================

describe("LocalUploadsStorageService", () => {
    it("derives the on-disk filename by splitting the stored path on the literal '/api/uploads/' prefix", async () => {
        const fetch = vi.fn().mockResolvedValue({
            id: "doc1",
            data: { type: "file_local", path: "/api/uploads/some/nested/name.pdf" },
        });
        const svc = new LocalUploadsStorageService({ dataSourceDocsRepository: fakeDataSourceDocsRepository(fetch) });
        await svc.getFileContents("doc1");
        const calledWith = vi.mocked(fs.readFileSync).mock.calls[0][0] as string;
        expect(calledWith).toBe(path.join("/uploads", "some/nested/name.pdf"));
    });

    // Was: "SECURITY: a stored path containing '..' segments is not rejected".
    // That pinned a real vulnerability — the `path` field on a file_local doc is
    // attacker-controlled end to end (AddDocsToDataSourceUseCase accepts
    // `docs: z.array(DocCreateSchema)` from any authenticated project caller,
    // DocCreateSchema's `data` is the raw DataSourceDoc union with only
    // `path: z.string()`, and MongoDBDataSourceDocsRepository.bulkCreate stores
    // it verbatim), so any authenticated user of any project could read
    // arbitrary host files. Fixed 2026-08-03; the pin is deliberately inverted
    // to assert containment instead.
    it("SECURITY: refuses a stored path that escapes UPLOADS_DIR", async () => {
        const fetch = vi.fn().mockResolvedValue({
            id: "doc1",
            data: { type: "file_local", path: "/api/uploads/../../etc/passwd" },
        });
        const svc = new LocalUploadsStorageService({ dataSourceDocsRepository: fakeDataSourceDocsRepository(fetch) });

        await expect(svc.getFileContents("doc1")).rejects.toThrow(/not found/i);
        expect(fs.readFileSync).not.toHaveBeenCalled();
    });

    it("SECURITY: refuses a sibling directory that merely shares the root's prefix", async () => {
        // A `startsWith` containment check would accept '/uploads-evil'.
        const fetch = vi.fn().mockResolvedValue({
            id: "doc1",
            data: { type: "file_local", path: "/api/uploads/../uploads-evil/secret" },
        });
        const svc = new LocalUploadsStorageService({ dataSourceDocsRepository: fakeDataSourceDocsRepository(fetch) });

        await expect(svc.getFileContents("doc1")).rejects.toThrow(/not found/i);
        expect(fs.readFileSync).not.toHaveBeenCalled();
    });

    it("SECURITY: refuses an absolute stored path", async () => {
        const fetch = vi.fn().mockResolvedValue({
            id: "doc1",
            data: { type: "file_local", path: "/api/uploads//etc/shadow" },
        });
        const svc = new LocalUploadsStorageService({ dataSourceDocsRepository: fakeDataSourceDocsRepository(fetch) });

        await expect(svc.getFileContents("doc1")).rejects.toThrow(/not found/i);
        expect(fs.readFileSync).not.toHaveBeenCalled();
    });

    it("rejects a stored path with no '/api/uploads/' segment instead of throwing a TypeError", async () => {
        // split()[1] is undefined here; path.join used to raise a raw TypeError.
        const fetch = vi.fn().mockResolvedValue({
            id: "doc1",
            data: { type: "file_local", path: "not-an-uploads-url" },
        });
        const svc = new LocalUploadsStorageService({ dataSourceDocsRepository: fakeDataSourceDocsRepository(fetch) });

        await expect(svc.getFileContents("doc1")).rejects.toThrow(/not a local file/i);
        expect(fs.readFileSync).not.toHaveBeenCalled();
    });

    it("rejects a doc whose data isn't a local file", async () => {
        const fetch = vi.fn().mockResolvedValue({ id: "doc1", data: { type: "file_s3", s3Key: "x" } });
        const svc = new LocalUploadsStorageService({ dataSourceDocsRepository: fakeDataSourceDocsRepository(fetch) });
        await expect(svc.getFileContents("doc1")).rejects.toThrow(/not a local file/);
    });
});
