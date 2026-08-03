import { describe, expect, it } from "vitest";
import { buildCredentialOverride } from "./credentials.js";

/**
 * The bug: the connect handler required BOTH a client ID and a secret before
 * it would build an override. Microsoft "Mobile and desktop" registrations
 * issue no secret, so a correct client ID was thrown away and the user was
 * told "microsoft client ID not configured" one keystroke after supplying it.
 */
describe("buildCredentialOverride", () => {
  it("accepts a client ID with no secret — the desktop public-client case", () => {
    expect(buildCredentialOverride("27f5fd00-3555-4ca9-9557-62b36d17f9d2", ""))
      .toEqual({ clientId: "27f5fd00-3555-4ca9-9557-62b36d17f9d2", clientSecret: undefined });
  });

  it("accepts a client ID when the secret is absent entirely", () => {
    expect(buildCredentialOverride("some-client-id"))
      .toEqual({ clientId: "some-client-id", clientSecret: undefined });
  });

  it("keeps a secret when one is genuinely supplied", () => {
    expect(buildCredentialOverride("google-id", "GOCSPX-secret"))
      .toEqual({ clientId: "google-id", clientSecret: "GOCSPX-secret" });
  });

  it("trims pasted whitespace on both halves", () => {
    expect(buildCredentialOverride("  id  ", "  secret  "))
      .toEqual({ clientId: "id", clientSecret: "secret" });
  });

  it("treats a whitespace-only secret as no secret", () => {
    // Otherwise the token request sends an empty client_secret, which servers
    // reject differently from omitting it.
    expect(buildCredentialOverride("id", "   "))
      .toEqual({ clientId: "id", clientSecret: undefined });
  });

  it("returns nothing without a client ID, so the stored credential is used", () => {
    expect(buildCredentialOverride(undefined, "orphan-secret")).toBeUndefined();
    expect(buildCredentialOverride("", "orphan-secret")).toBeUndefined();
    expect(buildCredentialOverride("   ")).toBeUndefined();
  });
});
