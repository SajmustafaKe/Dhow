import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The cipher's contract is mostly about what it does when the keychain is
 * *not* there — that is where a naive implementation either throws and blocks
 * the user, or silently hands back ciphertext that gets used as a password.
 */

let mod: typeof import("./secret-cipher.js");

beforeEach(async () => {
  vi.resetModules();
  mod = await import("./secret-cipher.js");
});

afterEach(() => {
  vi.resetModules();
});

/** Reversible stand-in for Electron's safeStorage. */
const workingCipher = {
  isAvailable: () => true,
  encrypt: (plain: string) => Buffer.from(plain, "utf8").toString("base64"),
  decrypt: (enc: string) => Buffer.from(enc, "base64").toString("utf8"),
};

describe("secret cipher", () => {
  it("round-trips a secret when the keychain works", () => {
    mod.setSecretCipher(workingCipher);

    const stored = mod.protectSecret("hunter2");

    expect(stored).not.toBe("hunter2");
    expect(mod.isProtected(stored)).toBe(true);
    expect(mod.revealSecret(stored)).toBe("hunter2");
  });

  // Refusing to save because a Linux box lacks libsecret would be worse than
  // storing it the way every previous version already did.
  it("stores plaintext rather than failing when no keychain is available", () => {
    mod.setSecretCipher({ isAvailable: () => false, encrypt: () => "x", decrypt: () => "x" });

    const stored = mod.protectSecret("hunter2");

    expect(stored).toBe("hunter2");
    expect(mod.isProtected(stored)).toBe(false);
    expect(mod.revealSecret(stored)).toBe("hunter2");
  });

  it("reads back credentials written before encryption existed", () => {
    mod.setSecretCipher(workingCipher);
    // No marker: an upgrade must not lock anyone out of their own account.
    expect(mod.revealSecret("legacy-plaintext")).toBe("legacy-plaintext");
  });

  // The dangerous case: returning the ciphertext here would see it used as a
  // password, producing an auth failure that looks like a wrong password.
  it("returns null when ciphertext cannot be opened, never the ciphertext", () => {
    mod.setSecretCipher(workingCipher);
    const stored = mod.protectSecret("hunter2")!;

    mod.setSecretCipher({
      isAvailable: () => true,
      encrypt: () => "x",
      decrypt: () => { throw new Error("keychain rejected"); },
    });

    expect(mod.revealSecret(stored)).toBeNull();
  });

  it("returns null when the keychain disappears entirely", () => {
    mod.setSecretCipher(workingCipher);
    const stored = mod.protectSecret("hunter2")!;

    mod.setSecretCipher({ isAvailable: () => false, encrypt: () => "x", decrypt: () => "x" });

    expect(mod.revealSecret(stored)).toBeNull();
  });

  it("passes empty values through untouched", () => {
    mod.setSecretCipher(workingCipher);
    expect(mod.protectSecret("")).toBe("");
    expect(mod.protectSecret(null)).toBeNull();
    expect(mod.revealSecret(null)).toBeNull();
    expect(mod.revealSecret("")).toBeNull();
  });
});
