import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Key validation.
 *
 * The bug this defends: an unvalidated key still satisfies `isConfigured()`,
 * so the integration reports healthy, the skill loads, the agent believes it
 * can reach Composio, and every call returns 401 the user never sees. The
 * symptom is "the tools don't load", arbitrarily far from the cause.
 */

const TIMEOUT = 30_000;
let tmpDir: string;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dhow-composio-test-"));
  process.env.DHOW_WORKDIR = tmpDir;
  delete process.env.COMPOSIO_API_KEY;
  vi.resetModules();
  vi.doMock("../knowledge/version_history.js", () => ({
    commitAll: vi.fn(async () => undefined),
    initRepo: vi.fn(async () => undefined),
  }));
  vi.doMock("../knowledge/deprecate_today_note.js", () => ({
    deprecateTodayNote: vi.fn(async () => undefined),
  }));
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(async () => {
  delete process.env.DHOW_WORKDIR;
  vi.unstubAllGlobals();
  vi.resetModules();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const ok = () => ({ ok: true, status: 200, json: async () => ({ items: [] }) });

/** Composio's real 401 shape, as observed from the live API. */
const invalidKey = () => ({
  ok: false,
  status: 401,
  json: async () => ({
    error: {
      message: "Invalid API key: ck_**BW5f",
      code: 801,
      slug: "APIKey_InvalidAPIKey",
      suggested_fix: "Please check you are using a valid key.",
    },
  }),
});

describe("composio key validation", { timeout: TIMEOUT }, () => {
  it("accepts a key the server recognises", async () => {
    fetchMock.mockResolvedValue(ok());
    const { validateApiKey } = await import("./client.js");

    expect(await validateApiKey("ak_valid")).toEqual({ ok: true });
    // Sent as the header Composio expects, not a bearer token.
    expect(fetchMock.mock.calls[0][1].headers["x-api-key"]).toBe("ak_valid");
  });

  it("surfaces the server's own reason for rejecting a key", async () => {
    fetchMock.mockResolvedValue(invalidKey());
    const { validateApiKey } = await import("./client.js");

    const result = await validateApiKey("ak_bad");

    expect(result.ok).toBe(false);
    // The message must be actionable, not "request failed".
    expect(result.error).toContain("Invalid API key");
    expect(result.error).toContain("valid key");
  });

  it("reports a network failure rather than throwing", async () => {
    fetchMock.mockRejectedValue(new Error("getaddrinfo ENOTFOUND"));
    const { validateApiKey } = await import("./client.js");

    const result = await validateApiKey("ak_whatever");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("ENOTFOUND");
  });

  it("rejects an empty key without a round trip", async () => {
    const { validateApiKey } = await import("./client.js");

    expect((await validateApiKey("   ")).ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("copes with a non-JSON error body", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => { throw new Error("not json"); },
    });
    const { validateApiKey } = await import("./client.js");

    const result = await validateApiKey("ak_x");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("502");
  });

  // isConfigured stays presence-only on purpose: it runs on every turn to
  // gate skill visibility, and a network call there would be a per-turn cost.
  it("keeps isConfigured cheap and presence-only", async () => {
    const { setApiKey, isConfigured } = await import("./client.js");

    expect(await isConfigured()).toBe(false);
    setApiKey("ck_anything");
    expect(await isConfigured()).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("api error messages", { timeout: TIMEOUT }, () => {
  it("extracts Composio's nested error.message and suggested fix", async () => {
    const { describeApiError } = await import("./client.js");

    // The exact body the live API returns for a bad key.
    const body = JSON.stringify({
      error: {
        message: "Invalid API key: ck_**BW5f",
        code: 801,
        slug: "APIKey_InvalidAPIKey",
        status: 401,
        suggested_fix: "Please check you are using a valid key.",
      },
    });

    const msg = describeApiError(401, "Unauthorized", body);

    // Nested under an object, which the previous string-only check dropped.
    expect(msg).toContain("Invalid API key");
    expect(msg).toContain("Please check you are using a valid key.");
  });

  it("still handles error as a plain string", async () => {
    const { describeApiError } = await import("./client.js");
    expect(describeApiError(400, "Bad Request", JSON.stringify({ error: "bad slug" })))
      .toContain("bad slug");
  });

  it("names the fix for a 401 with no parseable body", async () => {
    const { describeApiError } = await import("./client.js");
    const msg = describeApiError(401, "Unauthorized", "<html>nope</html>");
    // A bare status line leaves the user with nothing to do.
    expect(msg).toContain("Settings");
  });

  it("falls back to the status line for other unparseable errors", async () => {
    const { describeApiError } = await import("./client.js");
    const msg = describeApiError(503, "Service Unavailable", "");
    expect(msg).toContain("503");
    expect(msg).toContain("Service Unavailable");
  });
});

/**
 * The bug behind "I got a real key and it still says invalid": a Connect
 * consumer key is valid — for a product this client does not talk to.
 */
describe("key surface mismatch", { timeout: TIMEOUT }, () => {
  it("names Connect as the wrong surface for a ck_ key", async () => {
    const { explainKeyFormat } = await import("./client.js");
    const msg = explainKeyFormat("ck_JwhateverBW5f");

    expect(msg).toContain("Connect");
    expect(msg).toContain("ak_");
    // Must say where to go, not just what is wrong.
    expect(msg).toContain("platform.composio.dev");
  });

  it("passes an ak_ platform key through to the network check", async () => {
    const { explainKeyFormat } = await import("./client.js");
    expect(explainKeyFormat("ak_realplatformkey")).toBeNull();
  });

  it("rejects a ck_ key without a pointless round trip", async () => {
    const { validateApiKey } = await import("./client.js");

    const result = await validateApiKey("ck_JwhateverBW5f");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("ak_");
    // No request: regenerating a Connect key can never change this answer.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("points at the dashboard when a well-formed key is refused", async () => {
    fetchMock.mockResolvedValue(invalidKey());
    const { validateApiKey } = await import("./client.js");

    const result = await validateApiKey("ak_revoked");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Invalid API key");
    expect(result.error).toContain("revoked");
  });
});
