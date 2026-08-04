import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Characterization tests for custom-mcp-server.actions.ts, ahead of the port
 * into apps/dhowx.
 *
 * `addServer` pre-validates the server URL for UX before the controller
 * (which validates again) — `validateUrl` swallows the *specific* reason a
 * URL is rejected (bad syntax vs. a disallowed protocol) and always rethrows
 * the same generic 'Invalid URL', which is pinned below.
 *
 * `fetchTools` is the interesting auth case: it calls `authCheck()` (a
 * session is required) but then connects to an arbitrary caller-supplied
 * `serverUrl` with no allowlist or ownership check — the auth check proves
 * *someone* is logged in, not that they're allowed to make this server fetch
 * an arbitrary URL. Not a DB write, but worth naming in the report as an
 * SSRF-shaped surface.
 */

type Controller = { execute: ReturnType<typeof vi.fn> };
const controllers: Record<string, Controller> = {};

vi.mock("@/di/container", () => ({
    container: {
        resolve: vi.fn((key: string) => {
            controllers[key] ??= { execute: vi.fn() };
            return controllers[key];
        }),
    },
}));

const authCheck = vi.fn();
vi.mock("./auth.actions", () => ({ authCheck }));

const listTools = vi.fn();
const getMcpClient = vi.fn();
vi.mock("../lib/mcp", () => ({ getMcpClient }));

const user = { id: "u1", supabaseId: "s1", createdAt: "2024-01-01T00:00:00.000Z" };

beforeEach(() => {
    authCheck.mockReset();
    authCheck.mockResolvedValue(user);
    getMcpClient.mockReset();
    listTools.mockReset();
    getMcpClient.mockResolvedValue({ listTools });
});

async function loadActions() {
    return await import("./custom-mcp-server.actions");
}

describe("addServer", () => {
    const server = { serverUrl: "https://example.com/mcp" } as never;

    it("authenticates, validates the URL, then forwards {caller, userId, projectId, name, server}", async () => {
        const { addServer } = await loadActions();
        controllers["addCustomMcpServerController"].execute.mockResolvedValue(undefined);

        await addServer("proj_1", "My Server", server);

        expect(authCheck).toHaveBeenCalledTimes(1);
        expect(controllers["addCustomMcpServerController"].execute).toHaveBeenCalledWith({
            caller: "user",
            userId: user.id,
            projectId: "proj_1",
            name: "My Server",
            server,
        });
    });

    it("rejects a non-http(s) protocol with the generic 'Invalid URL' — not a protocol-specific message", async () => {
        const { addServer } = await loadActions();

        await expect(addServer("proj_1", "N", { serverUrl: "ftp://example.com" } as never)).rejects.toThrow("Invalid URL");
        expect(controllers["addCustomMcpServerController"].execute).not.toHaveBeenCalled();
    });

    it("rejects a syntactically invalid URL with the same generic 'Invalid URL' message", async () => {
        const { addServer } = await loadActions();

        await expect(addServer("proj_1", "N", { serverUrl: "not a url" } as never)).rejects.toThrow("Invalid URL");
        expect(controllers["addCustomMcpServerController"].execute).not.toHaveBeenCalled();
    });

    it("URL validation happens before the controller call, but after authCheck", async () => {
        authCheck.mockRejectedValue(new Error("User not authenticated"));
        const { addServer } = await loadActions();

        // Even with a bad URL, the auth error is what surfaces first.
        await expect(addServer("proj_1", "N", { serverUrl: "not a url" } as never)).rejects.toThrow("User not authenticated");
    });
});

describe("removeServer", () => {
    it("authenticates first, then forwards {caller, userId, projectId, name}", async () => {
        const { removeServer } = await loadActions();
        controllers["removeCustomMcpServerController"].execute.mockResolvedValue(undefined);

        await removeServer("proj_1", "My Server");

        expect(controllers["removeCustomMcpServerController"].execute).toHaveBeenCalledWith({
            caller: "user",
            userId: user.id,
            projectId: "proj_1",
            name: "My Server",
        });
    });

    it("propagates an authCheck failure without calling the controller", async () => {
        authCheck.mockRejectedValue(new Error("User not authenticated"));
        const { removeServer } = await loadActions();

        await expect(removeServer("proj_1", "My Server")).rejects.toThrow("User not authenticated");
        expect(controllers["removeCustomMcpServerController"].execute).not.toHaveBeenCalled();
    });
});

describe("fetchTools — auth requires a session, but does not scope or allowlist the target URL", () => {
    it("authenticates, then connects to whatever serverUrl the caller supplied", async () => {
        listTools.mockResolvedValue({
            tools: [{ name: "search", description: "Search things", inputSchema: { properties: { q: { type: "string" } }, required: ["q"] } }],
        });
        const { fetchTools } = await loadActions();

        const result = await fetchTools("https://attacker.example/mcp", "evil");

        expect(authCheck).toHaveBeenCalledTimes(1);
        expect(getMcpClient).toHaveBeenCalledWith("https://attacker.example/mcp", "evil");
        expect(result).toEqual([
            {
                name: "search",
                description: "Search things",
                parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"], additionalProperties: true },
                isMcp: true,
                mcpServerName: "evil",
                mcpServerURL: "https://attacker.example/mcp",
            },
        ]);
    });

    it("defaults description/properties/required when the MCP tool omits them", async () => {
        listTools.mockResolvedValue({ tools: [{ name: "bare" }] });
        const { fetchTools } = await loadActions();

        const [tool] = await fetchTools("https://example.com/mcp", "srv");

        expect(tool.description).toBe("");
        expect(tool.parameters).toEqual({ type: "object", properties: {}, required: [], additionalProperties: true });
    });

    it("propagates an authCheck failure before ever connecting", async () => {
        authCheck.mockRejectedValue(new Error("User not authenticated"));
        const { fetchTools } = await loadActions();

        await expect(fetchTools("https://example.com/mcp", "srv")).rejects.toThrow("User not authenticated");
        expect(getMcpClient).not.toHaveBeenCalled();
    });
});
