import fs from 'fs/promises';
import path from 'path';
import z from 'zod';
import { WorkDir } from '../config/config.js';
import { isProtected, protectSecret, revealSecret } from './secret-cipher.js';

/**
 * IMAP credentials, kept separate from `oauth.json` on purpose.
 *
 * `ProviderConnectionSchema` is OAuth-shaped — an app registration plus
 * revocable tokens. IMAP has neither: its credential is a static
 * host/port/username/password tuple belonging to one *mailbox*, not one app.
 * Storing it under `clientId`/`clientSecret` would be a schema lie that every
 * later reader of that file would have to decode.
 *
 * The password is encrypted at rest via the OS keychain. That matters more
 * here than for OAuth: an app password is long-lived and directly usable by
 * anyone who reads the file, with no console to revoke a single grant from.
 */

const ImapAccountSchema = z.object({
    id: z.string(),
    host: z.string(),
    port: z.number(),
    secure: z.boolean().default(true),
    username: z.string(),
    /** Ciphertext when a keychain is available, plaintext otherwise. */
    password: z.string(),
    /** Display label — usually the address, which is often the username. */
    email: z.string().nullable().default(null),
    error: z.string().nullable().default(null),
    addedAt: z.number().optional(),
});
export type ImapAccountRecord = z.infer<typeof ImapAccountSchema>;

const ImapConfigSchema = z.object({
    version: z.number().default(1),
    accounts: z.record(z.string(), ImapAccountSchema).default({}),
});

/** What callers work with: password always plaintext, or null if unreadable. */
export interface ImapAccount {
    id: string;
    host: string;
    port: number;
    secure: boolean;
    username: string;
    password: string | null;
    email: string | null;
    error: string | null;
}

export interface IImapRepo {
    list(): Promise<ImapAccount[]>;
    read(id: string): Promise<ImapAccount | null>;
    upsert(account: Omit<ImapAccount, 'password'> & { password?: string | null }): Promise<void>;
    delete(id: string): Promise<void>;
    setError(id: string, error: string | null): Promise<void>;
}

export class FSImapRepo implements IImapRepo {
    private readonly configPath = path.join(WorkDir, 'config', 'imap.json');

    private async readConfig(): Promise<z.infer<typeof ImapConfigSchema>> {
        try {
            const parsed = ImapConfigSchema.safeParse(
                JSON.parse(await fs.readFile(this.configPath, 'utf8')),
            );
            if (parsed.success) return parsed.data;
        } catch {
            // Missing or corrupt: start clean rather than guessing.
        }
        return { version: 1, accounts: {} };
    }

    private async writeConfig(config: z.infer<typeof ImapConfigSchema>): Promise<void> {
        await fs.mkdir(path.dirname(this.configPath), { recursive: true });
        await fs.writeFile(this.configPath, JSON.stringify(config, null, 2));
        // Best effort: on POSIX, keep the file owner-only even when the
        // password inside is already ciphertext.
        try {
            await fs.chmod(this.configPath, 0o600);
        } catch {
            // Windows and some filesystems do not support this.
        }
    }

    private toAccount(record: ImapAccountRecord): ImapAccount {
        return {
            id: record.id,
            host: record.host,
            port: record.port,
            secure: record.secure,
            username: record.username,
            password: revealSecret(record.password),
            email: record.email,
            error: record.error,
        };
    }

    async list(): Promise<ImapAccount[]> {
        const config = await this.readConfig();
        return Object.values(config.accounts).map((r) => this.toAccount(r));
    }

    async read(id: string): Promise<ImapAccount | null> {
        const config = await this.readConfig();
        const record = config.accounts[id];
        return record ? this.toAccount(record) : null;
    }

    async upsert(account: Omit<ImapAccount, 'password'> & { password?: string | null }): Promise<void> {
        const config = await this.readConfig();
        const prior = config.accounts[account.id];
        // A blank password on update means "leave it alone" — the settings
        // form does not echo the stored secret back, so an empty field is
        // absence of an edit, not an instruction to erase.
        const password = account.password
            ? protectSecret(account.password) ?? account.password
            : prior?.password ?? '';

        config.accounts[account.id] = ImapAccountSchema.parse({
            id: account.id,
            host: account.host,
            port: account.port,
            secure: account.secure,
            username: account.username,
            password,
            email: account.email,
            error: account.error,
            addedAt: prior?.addedAt ?? Date.now(),
        });
        await this.writeConfig(config);
    }

    async delete(id: string): Promise<void> {
        const config = await this.readConfig();
        delete config.accounts[id];
        await this.writeConfig(config);
    }

    async setError(id: string, error: string | null): Promise<void> {
        const config = await this.readConfig();
        const record = config.accounts[id];
        if (!record) return;
        config.accounts[id] = { ...record, error };
        await this.writeConfig(config);
    }
}

/** True when a stored password is ciphertext the current keychain cannot open. */
export async function hasUnreadableSecret(repo: IImapRepo, id: string): Promise<boolean> {
    const account = await repo.read(id);
    return account !== null && account.password === null;
}

export { isProtected };
