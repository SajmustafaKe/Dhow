import { describe, it, expect, beforeEach, vi } from "vitest";
import { PrefixLogger } from "@/app/lib/utils";
import { UsageTracker } from "@/app/lib/billing";
import { createTools } from "@/src/application/lib/agents-runtime/agent-tools";

/**
 * Characterization tests for tool dispatch, ahead of the port into apps/dhowx.
 *
 * `createTools` decides which implementation an agent's tool actually gets, from
 * five mutually-non-exclusive boolean flags on the config. It is an if/else-if
 * chain, so the ORDER is the contract: a config with both `mockTool` and `isMcp`
 * set resolves to a mock, and nothing in the type system says so.
 *
 * The other half is the tool surface the model sees — name, description and
 * JSON-Schema parameters. Those are prompt-adjacent: `additionalProperties:
 * true` and `strict: false` mean the model can send fields the schema never
 * declared and the call still runs. Tightening either during a port silently
 * starts rejecting calls that work today.
 *
 * Only construction is exercised here. The `invoke*` functions behind these
 * tools do network IO (webhooks, MCP, Composio, Gemini) and are out of scope —
 * they need fixtures, not unit pins.
 */

const tracker = () => new UsageTracker();
const logger = () => new PrefixLogger("test");

const toolConfig = (over: Record<string, unknown> = {}) =>
    ({
        name: "lookup_invoice",
        description: "Look up an invoice by id",
        parameters: {
            type: "object" as const,
            properties: { invoiceId: { type: "string" } },
        },
        ...over,
    }) as never;

// The Tool object returned by @openai/agents; only its public surface is read.
const asTool = (t: unknown) => t as { name: string; description: string; parameters: Record<string, unknown> };

describe("createTools dispatch precedence", () => {
    beforeEach(() => {
        vi.spyOn(console, "log").mockImplementation(() => {});
    });

    const build = (config: Record<string, unknown>) =>
        createTools(logger(), tracker(), "proj_1", { tools: [] }, {
            lookup_invoice: toolConfig(config),
        });

    it("creates a tool under its config key", () => {
        const tools = build({ mockTool: true });
        expect(Object.keys(tools)).toEqual(["lookup_invoice"]);
    });

    it("routes a fully unflagged tool to mock, not webhook", () => {
        // The 'placeholder tool' fallback.
        const tool = asTool(build({}).lookup_invoice);
        expect(tool.name).toBe("lookup_invoice");
        // A mock tool is constructed with the config's own description; the
        // webhook factory is not reached.
        expect(tool.description).toBe("Look up an invoice by id");
    });

    it("logs the type it actually builds", () => {
        // Regression: the log ternary used to fall through to 'webhook' for an
        // unflagged tool while the chain below built a mock, so the log named a
        // tool type that was never created. Cheap to get wrong again during the
        // port, and misleading exactly when someone is reading these logs to
        // debug it.
        const lines: string[] = [];
        const original = console.log;
        console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
        try {
            build({});
        } finally {
            console.log = original;
        }

        const planned = lines.find((l) => l.includes("creating tool"));
        const built = lines.find((l) => l.includes("created"));
        expect(planned).toContain("type: mock");
        expect(built).toContain("created mock tool");
    });

    // Discriminating which factory ran is not obvious: createMockTool and
    // createMcpTool build structurally identical Tool objects (same name,
    // description, strict, parameters) and differ only inside the `execute`
    // closure, which ESM will not let a test intercept for a same-module call.
    //
    // Two things are observable. createComposioTool THROWS when composioData is
    // absent, so reaching it is detectable. And the factory logs its own name.
    // Both are used below — an assertion on `.name` alone passes no matter which
    // branch ran, which is exactly the gap mutation testing exposed here.
    const factoryFromLog = (config: Record<string, unknown>) => {
        const lines: string[] = [];
        const original = console.log;
        console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
        try {
            build(config);
        } finally {
            console.log = original;
        }
        return lines.find((l) => l.includes("✓ created")) ?? "";
    };

    it("mockTool wins over every other flag", () => {
        // Every flag set at once. isComposio is among them and composioData is
        // absent, so if precedence ever let the composio branch run first this
        // would throw rather than returning a tool.
        const allFlags = {
            mockTool: true,
            isMcp: true,
            isComposio: true,
            isGeminiImage: true,
            isWebhook: true,
        };

        expect(() => build(allFlags)).not.toThrow();
        expect(factoryFromLog(allFlags)).toContain("created mock tool");
    });

    it("resolves each flag to its own factory when it is the only one set", () => {
        // Pins the whole chain, not just its first branch.
        expect(factoryFromLog({ mockTool: true })).toContain("created mock tool");
        expect(factoryFromLog({ isMcp: true })).toContain("created mcp tool");
        expect(factoryFromLog({ isGeminiImage: true })).toContain("created gemini image tool");
        expect(factoryFromLog({ isWebhook: true })).toContain("created webhook tool");
    });

    it("isMcp outranks isComposio, isGeminiImage and isWebhook", () => {
        expect(
            factoryFromLog({ isMcp: true, isComposio: true, isGeminiImage: true, isWebhook: true }),
        ).toContain("created mcp tool");
    });

    it("throws when a composio tool reaches its factory without composioData", () => {
        // The discriminator relied on above — asserted directly so it cannot
        // rot silently and quietly weaken the precedence tests.
        expect(() => build({ isComposio: true })).toThrow(/composio data not found/i);
    });

    it("builds a distinct tool for each declared config", () => {
        const tools = createTools(logger(), tracker(), "proj_1", { tools: [] }, {
            a: toolConfig({ name: "a", mockTool: true }),
            b: toolConfig({ name: "b", isWebhook: true }),
            c: toolConfig({ name: "c" }),
        });

        expect(Object.keys(tools).sort()).toEqual(["a", "b", "c"]);
        expect(asTool(tools.a).name).toBe("a");
        expect(asTool(tools.b).name).toBe("b");
        expect(asTool(tools.c).name).toBe("c");
    });

    it("returns an empty map for an empty config, without throwing", () => {
        expect(createTools(logger(), tracker(), "proj_1", { tools: [] }, {})).toEqual({});
    });

    it("ignores the workflow.tools argument entirely", () => {
        // `workflow` is threaded through the signature but never read; only
        // `toolConfig` drives creation. Pinned so a port does not start
        // honouring it and change which tools exist.
        const fromEmptyWorkflow = build({ mockTool: true });
        const fromPopulatedWorkflow = createTools(
            logger(),
            tracker(),
            "proj_1",
            { tools: [toolConfig({ name: "ignored_tool" })] },
            { lookup_invoice: toolConfig({ mockTool: true }) },
        );

        expect(Object.keys(fromPopulatedWorkflow)).toEqual(Object.keys(fromEmptyWorkflow));
        expect(Object.keys(fromPopulatedWorkflow)).not.toContain("ignored_tool");
    });
});

describe("the tool surface a model sees", () => {
    beforeEach(() => {
        vi.spyOn(console, "log").mockImplementation(() => {});
    });

    const buildOne = (config: Record<string, unknown>) =>
        asTool(
            createTools(logger(), tracker(), "proj_1", { tools: [] }, {
                lookup_invoice: toolConfig(config),
            }).lookup_invoice,
        );

    it("passes the config name and description through unchanged", () => {
        const tool = buildOne({ mockTool: true });
        expect(tool.name).toBe("lookup_invoice");
        expect(tool.description).toBe("Look up an invoice by id");
    });

    it("declares the config's own properties", () => {
        const tool = buildOne({ mockTool: true });
        expect(tool.parameters).toMatchObject({
            type: "object",
            properties: { invoiceId: { type: "string" } },
        });
    });

    it("defaults absent `required` to an empty array, not undefined", () => {
        // An undefined `required` would make the JSON Schema invalid for some
        // providers; the factory coerces it.
        expect(buildOne({ mockTool: true }).parameters.required).toEqual([]);
    });

    it("preserves an explicit `required` list", () => {
        const tool = buildOne({
            mockTool: true,
            parameters: {
                type: "object",
                properties: { invoiceId: { type: "string" } },
                required: ["invoiceId"],
            },
        });
        expect(tool.parameters.required).toEqual(["invoiceId"]);
    });

    it("forces additionalProperties true, overriding the config", () => {
        // Deliberately permissive: models routinely send extra fields, and a
        // strict schema would reject the whole call. The config's own value is
        // discarded — set it to false and it is still true.
        expect(buildOne({ mockTool: true }).parameters.additionalProperties).toBe(true);

        const strictConfig = buildOne({
            mockTool: true,
            parameters: {
                type: "object",
                properties: { invoiceId: { type: "string" } },
                additionalProperties: false,
            },
        });
        expect(strictConfig.parameters.additionalProperties).toBe(true);
    });
});
