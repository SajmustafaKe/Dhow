import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Credential mode is what decides whether a user ever sees a cloud console.
 *
 * Unset build vars must leave every provider in bring-your-own mode, and a
 * shipped registration must actually reach the config — a silent fallback to
 * BYOK after credentials were configured would look like "connect is broken"
 * with nothing in the logs.
 */

const TIMEOUT = 30_000;

beforeEach(() => {
  vi.resetModules();
  delete process.env.DHOW_GOOGLE_CLIENT_ID;
  delete process.env.DHOW_GOOGLE_CLIENT_SECRET;
  delete process.env.DHOW_MICROSOFT_CLIENT_ID;
});

afterEach(() => {
  delete process.env.DHOW_GOOGLE_CLIENT_ID;
  delete process.env.DHOW_GOOGLE_CLIENT_SECRET;
  delete process.env.DHOW_MICROSOFT_CLIENT_ID;
  vi.resetModules();
});

describe("provider credentials", { timeout: TIMEOUT }, () => {
  it("leaves google in bring-your-own mode when nothing is shipped", async () => {
    const { getProviderConfig } = await import("./providers.js");
    const google = await getProviderConfig("google");

    expect(google.client.mode).toBe("static");
    // Undefined is the signal oauth-handler reads to fall back to the user's
    // own stored clientId.
    expect(google.client.mode === "static" && google.client.clientId).toBeUndefined();
  });

  it("carries a shipped google registration through to the config", async () => {
    process.env.DHOW_GOOGLE_CLIENT_ID = "123.apps.googleusercontent.com";
    process.env.DHOW_GOOGLE_CLIENT_SECRET = "GOCSPX-shipped";

    const { getProviderConfig } = await import("./providers.js");
    const google = await getProviderConfig("google");

    expect(google.client.mode === "static" && google.client.clientId)
      .toBe("123.apps.googleusercontent.com");
    expect(google.client.mode === "static" && google.client.clientSecret)
      .toBe("GOCSPX-shipped");
  });

  it("ships microsoft without a secret", async () => {
    process.env.DHOW_MICROSOFT_CLIENT_ID = "00000000-0000-0000-0000-000000000000";

    const { getProviderConfig } = await import("./providers.js");
    const ms = await getProviderConfig("microsoft");

    expect(ms.client.mode === "static" && ms.client.clientId)
      .toBe("00000000-0000-0000-0000-000000000000");
    // Entra desktop registrations are public clients: requiring a secret here
    // would block the common case.
    expect(ms.client.mode === "static" && ms.client.clientSecret).toBeUndefined();
  });

  it("keeps fireflies on dynamic registration, which needs no credentials", async () => {
    const { getProviderConfig } = await import("./providers.js");
    const ff = await getProviderConfig("fireflies-ai");

    expect(ff.client.mode).toBe("dcr");
  });

  it("still asks google for offline-capable mail scopes", async () => {
    const { getProviderConfig } = await import("./providers.js");
    const google = await getProviderConfig("google");

    // gmail.modify is a *restricted* scope: shipping one registration for it
    // is what triggers Google verification and the CASA assessment.
    expect(google.scopes).toContain("https://www.googleapis.com/auth/gmail.modify");
  });

  it("rejects an unknown provider by name", async () => {
    const { getProviderConfig } = await import("./providers.js");
    await expect(getProviderConfig("nope")).rejects.toThrow(/Unknown OAuth provider/);
  });
});
