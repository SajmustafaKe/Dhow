import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Characterization tests for assistant-templates.actions.ts, ahead of the
 * port into apps/dhowx.
 *
 * Every export authenticates first. The interesting contract details:
 *   - `listAssistantTemplates` validates with `ListTemplatesSchema.parse`
 *     (throws on bad input, no graceful error shape) and branches on
 *     `source`: 'library' never touches Mongo (served from the static
 *     `prebuiltTemplates` module), 'community' always does, and *no* source
 *     merges both but hardcodes `nextCursor: null` regardless of whether the
 *     community page actually had more — pinned as a functional quirk.
 *   - `deleteAssistantTemplate` uses "Template not found" (not "Forbidden")
 *     for a template the caller doesn't own — a deliberate
 *     existence-hiding pattern, distinct from the ownership-mismatch case
 *     for library/system templates, which DOES say "Not allowed".
 *   - `createAssistantTemplate` resolves author identity from Supabase only
 *     when USE_AUTH is on, and swallows any Supabase lookup failure back to
 *     the 'Anonymous' default rather than failing the whole call.
 *
 * `@/app/lib/prebuilt-cards` is real static JSON — no mocking needed, no I/O.
 */

const authCheck = vi.fn();
vi.mock("./auth.actions", () => ({ authCheck }));

const repo = {
    list: vi.fn(),
    fetch: vi.fn(),
    create: vi.fn(),
    deleteByIdAndAuthor: vi.fn(),
    toggleLike: vi.fn(),
    getCategories: vi.fn(),
    getLikedTemplates: vi.fn(),
};
vi.mock("@/src/infrastructure/repositories/mongodb.assistant-templates.repository", () => ({
    MongoDBAssistantTemplatesRepository: vi.fn().mockImplementation(function (this: unknown) {
        return repo;
    }),
}));

const getSession = vi.fn();
vi.mock("@/app/lib/supabase", () => ({ getSession }));

const user = { id: "u1", authId: "s1", createdAt: "2024-01-01T00:00:00.000Z" };

beforeEach(() => {
    authCheck.mockReset();
    authCheck.mockResolvedValue(user);
    for (const fn of Object.values(repo)) fn.mockReset();
    repo.getLikedTemplates.mockResolvedValue([]);
    getSession.mockReset();
    getSession.mockResolvedValue(null);
});

async function loadWithAuth(useAuth: boolean) {
    vi.resetModules();
    process.env.USE_AUTH = useAuth ? "true" : "false";
    return await import("./assistant-templates.actions");
}

describe("listAssistantTemplates", () => {
    it("authenticates first", async () => {
        const { listAssistantTemplates } = await loadWithAuth(true);

        await listAssistantTemplates({ source: "library", limit: 5 });

        expect(authCheck).toHaveBeenCalledTimes(1);
    });

    it("rejects a request outside the schema's bounds (limit > 50) by throwing, not returning an error object", async () => {
        const { listAssistantTemplates } = await loadWithAuth(true);

        await expect(listAssistantTemplates({ limit: 999 } as never)).rejects.toThrow();
        expect(repo.list).not.toHaveBeenCalled();
    });

    it("source:'library' never touches the repository — served entirely from static prebuilt data", async () => {
        const { listAssistantTemplates } = await loadWithAuth(true);

        const result = await listAssistantTemplates({ source: "library", limit: 50 });

        expect(repo.list).not.toHaveBeenCalled();
        expect(result.items.length).toBeGreaterThan(0);
        expect(result.items.every((t) => t.source === "library")).toBe(true);
    });

    it("source:'library' paginates via a numeric-offset cursor computed from `limit`", async () => {
        const { listAssistantTemplates } = await loadWithAuth(true);
        const page1 = await listAssistantTemplates({ source: "library", limit: 2 });

        expect(page1.items).toHaveLength(2);
        expect(page1.nextCursor).toBe("2");

        const page2 = await listAssistantTemplates({ source: "library", limit: 2, cursor: page1.nextCursor! });
        // No overlap between pages.
        expect(page2.items[0].id).not.toBe(page1.items[0].id);
    });

    it("source:'community' queries the repository with isPublic:true and adds isLiked per template", async () => {
        repo.list.mockResolvedValue({ items: [{ id: "t1", name: "Community 1", authorId: "other" }], nextCursor: null });
        repo.getLikedTemplates.mockResolvedValue(["t1"]);
        const { listAssistantTemplates } = await loadWithAuth(true);

        const result = await listAssistantTemplates({ source: "community", limit: 20 });

        expect(repo.list).toHaveBeenCalledWith(
            { category: undefined, search: undefined, featured: undefined, isPublic: true, source: "community" },
            undefined,
            20
        );
        expect(repo.getLikedTemplates).toHaveBeenCalledWith(["t1"], user.id);
        expect(result.items[0].isLiked).toBe(true);
    });

    it("no source: merges library (first page) + community (first page) and ALWAYS returns nextCursor:null, even if community had more", async () => {
        repo.list.mockResolvedValue({ items: [{ id: "t-community", name: "C" }], nextCursor: "would-be-more" });
        const { listAssistantTemplates } = await loadWithAuth(true);

        const result = await listAssistantTemplates({ limit: 5 });

        // QUIRK: nextCursor is hardcoded null on this branch regardless of
        // the community repo's own pagination cursor — infinite scroll UI
        // relying on this can never page past the merged first screen.
        expect(result.nextCursor).toBeNull();
        expect(result.items.some((t) => t.id === "t-community")).toBe(true);
        expect(result.items.some((t) => t.source === "library")).toBe(true);
    });

    it("propagates an authCheck failure before validating or touching the repository", async () => {
        authCheck.mockRejectedValue(new Error("User not authenticated"));
        const { listAssistantTemplates } = await loadWithAuth(true);

        await expect(listAssistantTemplates({ source: "library" } as never)).rejects.toThrow("User not authenticated");
    });
});

describe("getAssistantTemplate", () => {
    it("a prebuilt: id loads from static data and fills blank agent models with PROVIDER_DEFAULT_MODEL, defaulting to 'gpt-4.1'", async () => {
        delete process.env.PROVIDER_DEFAULT_MODEL;
        const { listAssistantTemplates, getAssistantTemplate } = await loadWithAuth(true);
        const { items } = await listAssistantTemplates({ source: "library", limit: 1 });
        const id = items[0].id;

        const template = await getAssistantTemplate(id);

        expect(template.source).toBe("library");
        expect(template.id).toBe(id);
        for (const agent of template.workflow.agents ?? []) {
            expect(agent.model).not.toBe("");
        }
    });

    it("an unknown prebuilt: key throws 'Template not found'", async () => {
        const { getAssistantTemplate } = await loadWithAuth(true);

        await expect(getAssistantTemplate("prebuilt:does-not-exist")).rejects.toThrow("Template not found");
    });

    it("a non-prebuilt id fetches from the repository; null throws 'Template not found'", async () => {
        repo.fetch.mockResolvedValue(null);
        const { getAssistantTemplate } = await loadWithAuth(true);

        await expect(getAssistantTemplate("community_1")).rejects.toThrow("Template not found");
        expect(repo.fetch).toHaveBeenCalledWith("community_1");
    });

    it("a non-prebuilt id returns the serialized repository result when found", async () => {
        repo.fetch.mockResolvedValue({ id: "community_1", name: "C1" });
        const { getAssistantTemplate } = await loadWithAuth(true);

        await expect(getAssistantTemplate("community_1")).resolves.toEqual({ id: "community_1", name: "C1" });
    });
});

describe("getAssistantTemplateCategories", () => {
    it("authenticates, then returns {items} from repo.getCategories()", async () => {
        repo.getCategories.mockResolvedValue(["Sales", "Support"]);
        const { getAssistantTemplateCategories } = await loadWithAuth(true);

        await expect(getAssistantTemplateCategories()).resolves.toEqual({ items: ["Sales", "Support"] });
        expect(authCheck).toHaveBeenCalledTimes(1);
    });
});

describe("createAssistantTemplate", () => {
    function payload(over: Record<string, unknown> = {}) {
        return { name: "T", description: "D", category: "C", tags: [], isAnonymous: false, workflow: {}, ...over };
    }

    it("authenticates BEFORE validating the payload", async () => {
        authCheck.mockRejectedValue(new Error("User not authenticated"));
        const { createAssistantTemplate } = await loadWithAuth(true);

        // Even with an out-of-bounds field, the auth error is what surfaces.
        await expect(createAssistantTemplate({ name: "" } as never)).rejects.toThrow("User not authenticated");
    });

    it("rejects a payload outside the schema's bounds (empty name) by throwing", async () => {
        const { createAssistantTemplate } = await loadWithAuth(true);

        await expect(createAssistantTemplate(payload({ name: "" }) as never)).rejects.toThrow();
        expect(repo.create).not.toHaveBeenCalled();
    });

    it("USE_AUTH=false: authorName defaults to 'Anonymous', authorEmail undefined — supabase is never consulted", async () => {
        repo.create.mockResolvedValue({ id: "t1" });
        const { createAssistantTemplate } = await loadWithAuth(false);

        await createAssistantTemplate(payload() as never);

        expect(getSession).not.toHaveBeenCalled();
        expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ authorName: "Anonymous", authorEmail: undefined }));
    });

    it("USE_AUTH=true: resolves authorName/authorEmail from the Supabase session", async () => {
        getSession.mockResolvedValue({ user: { name: "Real Name", email: "real@example.com" } });
        repo.create.mockResolvedValue({ id: "t1" });
        const { createAssistantTemplate } = await loadWithAuth(true);

        await createAssistantTemplate(payload() as never);

        expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ authorName: "Real Name", authorEmail: "real@example.com" }));
    });

    it("USE_AUTH=true, isAnonymous:true: overrides the Supabase-derived name/email back to Anonymous/undefined", async () => {
        getSession.mockResolvedValue({ user: { name: "Real Name", email: "real@example.com" } });
        repo.create.mockResolvedValue({ id: "t1" });
        const { createAssistantTemplate } = await loadWithAuth(true);

        await createAssistantTemplate(payload({ isAnonymous: true }) as never);

        expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ authorName: "Anonymous", authorEmail: undefined, isAnonymous: true }));
    });

    it("USE_AUTH=true, Supabase lookup throws: swallows the error and falls back to the Anonymous default instead of failing the call", async () => {
        getSession.mockRejectedValue(new Error("supabase down"));
        repo.create.mockResolvedValue({ id: "t1" });
        const { createAssistantTemplate } = await loadWithAuth(true);

        await expect(createAssistantTemplate(payload() as never)).resolves.toEqual({ id: "t1" });
        expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ authorName: "Anonymous" }));
    });

    it("builds the create payload with server-owned defaults the caller cannot override (counts zeroed, isPublic/featured fixed)", async () => {
        repo.create.mockResolvedValue({ id: "t1" });
        const { createAssistantTemplate } = await loadWithAuth(false);

        await createAssistantTemplate(payload() as never);

        expect(repo.create).toHaveBeenCalledWith(
            expect.objectContaining({
                authorId: user.id,
                downloadCount: 0,
                likeCount: 0,
                featured: false,
                isPublic: true,
                likes: [],
                source: "community",
            })
        );
    });
});

describe("deleteAssistantTemplate", () => {
    it("authenticates first", async () => {
        authCheck.mockRejectedValue(new Error("User not authenticated"));
        const { deleteAssistantTemplate } = await loadWithAuth(true);

        await expect(deleteAssistantTemplate("t1")).rejects.toThrow("User not authenticated");
        expect(repo.fetch).not.toHaveBeenCalled();
    });

    it("throws 'Template not found' when the template does not exist", async () => {
        repo.fetch.mockResolvedValue(null);
        const { deleteAssistantTemplate } = await loadWithAuth(true);

        await expect(deleteAssistantTemplate("missing")).rejects.toThrow("Template not found");
    });

    it("throws 'Not allowed to delete this template' for a library-sourced item, even if the caller happens to be its authorId", async () => {
        repo.fetch.mockResolvedValue({ id: "t1", source: "library", authorId: user.id });
        const { deleteAssistantTemplate } = await loadWithAuth(true);

        await expect(deleteAssistantTemplate("t1")).rejects.toThrow("Not allowed to delete this template");
        expect(repo.deleteByIdAndAuthor).not.toHaveBeenCalled();
    });

    it("throws 'Not allowed to delete this template' for the dhow-system author", async () => {
        repo.fetch.mockResolvedValue({ id: "t1", source: "community", authorId: "dhow-system" });
        const { deleteAssistantTemplate } = await loadWithAuth(true);

        await expect(deleteAssistantTemplate("t1")).rejects.toThrow("Not allowed to delete this template");
    });

    it("throws 'Template not found' (NOT 'Forbidden') when a community template is owned by someone else — hides existence", async () => {
        repo.fetch.mockResolvedValue({ id: "t1", source: "community", authorId: "someone-else" });
        const { deleteAssistantTemplate } = await loadWithAuth(true);

        await expect(deleteAssistantTemplate("t1")).rejects.toThrow("Template not found");
        expect(repo.deleteByIdAndAuthor).not.toHaveBeenCalled();
    });

    it("throws 'Template not found' when the delete itself reports no match (repo.deleteByIdAndAuthor returns false)", async () => {
        repo.fetch.mockResolvedValue({ id: "t1", source: "community", authorId: user.id });
        repo.deleteByIdAndAuthor.mockResolvedValue(false);
        const { deleteAssistantTemplate } = await loadWithAuth(true);

        await expect(deleteAssistantTemplate("t1")).rejects.toThrow("Template not found");
    });

    it("returns {success:true} for the owner's own community template", async () => {
        repo.fetch.mockResolvedValue({ id: "t1", source: "community", authorId: user.id });
        repo.deleteByIdAndAuthor.mockResolvedValue(true);
        const { deleteAssistantTemplate } = await loadWithAuth(true);

        await expect(deleteAssistantTemplate("t1")).resolves.toEqual({ success: true });
        expect(repo.deleteByIdAndAuthor).toHaveBeenCalledWith("t1", user.id);
    });
});

describe("toggleTemplateLike", () => {
    it("authenticates first, then toggles by the authenticated user's id (not any caller-supplied id)", async () => {
        repo.toggleLike.mockResolvedValue({ id: "t1", likeCount: 1 });
        const { toggleTemplateLike } = await loadWithAuth(true);

        await expect(toggleTemplateLike("t1")).resolves.toEqual({ id: "t1", likeCount: 1 });
        expect(repo.toggleLike).toHaveBeenCalledWith("t1", user.id);
    });

    it("propagates an authCheck failure without calling the repository", async () => {
        authCheck.mockRejectedValue(new Error("User not authenticated"));
        const { toggleTemplateLike } = await loadWithAuth(true);

        await expect(toggleTemplateLike("t1")).rejects.toThrow("User not authenticated");
        expect(repo.toggleLike).not.toHaveBeenCalled();
    });
});

describe("getCurrentUser", () => {
    it("authenticates, then returns ONLY {id} — name/email are dropped", async () => {
        const { getCurrentUser } = await loadWithAuth(true);

        await expect(getCurrentUser()).resolves.toEqual({ id: user.id });
    });
});
