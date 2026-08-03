/**
 * OS-keychain encryption for secrets at rest.
 *
 * `packages/core` stays Electron-free, so the actual cipher (Electron's
 * `safeStorage` — Keychain on macOS, DPAPI on Windows, libsecret on Linux) is
 * injected by the main process at startup.
 *
 * This is the canonical implementation. `apps/github-auth.ts` and
 * `auth/chatgpt-auth.ts` each predate it and carry their own copy of the same
 * interface; new code should use this one rather than adding a fourth.
 *
 * Why it matters more for mail than for OAuth tokens: an IMAP app password is
 * long-lived and directly usable by anyone who reads the file, whereas an
 * OAuth refresh token is scoped to an app registration and revocable from the
 * provider's console.
 */

export interface SecretCipher {
    isAvailable(): boolean;
    /** Returns base64. */
    encrypt(plain: string): string;
    decrypt(encrypted: string): string;
}

/**
 * Marks a stored value as ciphertext. Values without it are plaintext — either
 * written before encryption was available, or written on a machine with no
 * working keychain — and are read back as-is so no one is locked out of their
 * own credentials by an upgrade.
 */
const ENCRYPTED_PREFIX = 'enc:v1:';

let cipher: SecretCipher | null = null;

export function setSecretCipher(c: SecretCipher): void {
    cipher = c;
}

export function isEncryptionAvailable(): boolean {
    return cipher?.isAvailable() === true;
}

/**
 * Encrypt when a keychain is available, otherwise return the plaintext.
 *
 * Deliberately does not throw: refusing to save a credential because a Linux
 * box has no libsecret would be worse than storing it the way every previous
 * version already did. Callers that need the distinction ask
 * `isEncryptionAvailable()`.
 */
export function protectSecret(plain: string | null | undefined): string | null {
    if (plain == null || plain === '') return plain ?? null;
    if (!cipher?.isAvailable()) return plain;
    try {
        return ENCRYPTED_PREFIX + cipher.encrypt(plain);
    } catch {
        return plain;
    }
}

/**
 * Reverse of `protectSecret`. Returns null when a value is encrypted but the
 * keychain cannot open it — a wrong answer here would be silently used as a
 * password, so the caller must be able to tell "no credential" from "the
 * literal ciphertext".
 */
export function revealSecret(stored: string | null | undefined): string | null {
    if (stored == null || stored === '') return null;
    if (!stored.startsWith(ENCRYPTED_PREFIX)) return stored;
    const payload = stored.slice(ENCRYPTED_PREFIX.length);
    if (!cipher?.isAvailable()) return null;
    try {
        return cipher.decrypt(payload);
    } catch {
        return null;
    }
}

/** Whether a stored value is ciphertext, without attempting to open it. */
export function isProtected(stored: string | null | undefined): boolean {
    return typeof stored === 'string' && stored.startsWith(ENCRYPTED_PREFIX);
}
