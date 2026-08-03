import { z } from "zod";
import fs from "fs";
import path from "path";
import { WorkDir } from "../config/config.js";
import {
    ZAuthConfig,
    ZConnectedAccount,
    ZCreateAuthConfigRequest,
    ZCreateAuthConfigResponse,
    ZCreateConnectedAccountRequest,
    ZCreateConnectedAccountResponse,
    ZDeleteOperationResponse,
    ZErrorResponse,
    ZExecuteActionRequest,
    ZExecuteActionResponse,
    ZListResponse,
    ZSearchResultTool,
    ZToolkit,
    type NormalizedToolResult,
} from "./types.js";

const COMPOSIO_BASE_URL = 'https://backend.composio.dev/api/v3';
const CONFIG_FILE = path.join(WorkDir, 'config', 'composio.json');

// Composio is always reached directly with the user's own API key.
async function getBaseUrl(): Promise<string> {
    return COMPOSIO_BASE_URL;
}

async function getAuthHeaders(): Promise<Record<string, string>> {
    const apiKey = getApiKey();
    if (!apiKey) {
        throw new Error('Composio API key not configured');
    }
    return { 'x-api-key': apiKey };
}

/**
 * Configuration schema for Composio
 */
const ZComposioConfig = z.object({
    apiKey: z.string().optional(),
});

type ComposioConfig = z.infer<typeof ZComposioConfig>;

/**
 * Load Composio configuration
 */
function loadConfig(): ComposioConfig {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const data = fs.readFileSync(CONFIG_FILE, 'utf-8');
            return ZComposioConfig.parse(JSON.parse(data));
        }
    } catch (error) {
        console.error('[Composio] Failed to load config:', error);
    }
    return {};
}

/**
 * Save Composio configuration
 */
function saveConfig(config: ComposioConfig): void {
    const dir = path.dirname(CONFIG_FILE);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

/**
 * Get the Composio API key
 */
export function getApiKey(): string | null {
    const config = loadConfig();
    return config.apiKey || process.env.COMPOSIO_API_KEY || null;
}

/**
 * Set the Composio API key
 */
export function setApiKey(apiKey: string): void {
    const config = loadConfig();
    config.apiKey = apiKey;
    saveConfig(config);
}

/**
 * Check if Composio is configured.
 *
 * Presence only — deliberately not a network call, because this gates skill
 * visibility and prompt composition on every turn. Validity is checked once,
 * when the key is entered, by `validateApiKey`.
 */
export async function isConfigured(): Promise<boolean> {
    return !!getApiKey();
}

/**
 * Ask Composio whether a key actually works.
 *
 * Saving an unvalidated key is what turns a typo into "the tools don't load":
 * `isConfigured` reports true, the skill loads, the agent believes it can
 * reach Composio, and every call fails with a 401 the user never sees. The
 * server's own message is returned so the reason is legible at the point of
 * entry rather than buried in a log.
 */
/**
 * Composio ships two unrelated surfaces, each with its own key format:
 *
 *   ak_  Platform (developer) — backend.composio.dev/api/v3, `x-api-key`
 *   ck_  Connect ("For You")  — connect.composio.dev/mcp,   `x-consumer-api-key`
 *
 * We are a Platform client, so a `ck_` key is not a bad key — it is a key for
 * a different product, and it can never work here no matter how many times it
 * is regenerated. The API just says "Invalid API key", which sends people off
 * rotating a perfectly good credential. Name the actual mismatch instead.
 *
 * Ref: github.com/ComposioHQ/composio/issues/3485 (maintainer, 2026-07-21).
 */
export function explainKeyFormat(apiKey: string): string | null {
    const key = apiKey.trim();
    if (key.startsWith('ck_')) {
        return 'This is a Composio Connect ("For You") consumer key. Dhow uses the Composio Platform API, which needs a project key beginning "ak_" — get one at platform.composio.dev → Settings → Project Settings → API Keys.';
    }
    if (key.startsWith('ak_')) return null;
    return 'Composio project API keys begin with "ak_". Copy one from platform.composio.dev → Settings → Project Settings → API Keys.';
}

export async function validateApiKey(apiKey: string): Promise<{ ok: boolean; error?: string }> {
    const key = apiKey.trim();
    if (!key) return { ok: false, error: 'Enter an API key.' };
    const formatProblem = explainKeyFormat(key);
    if (formatProblem) return { ok: false, error: formatProblem };
    try {
        const res = await fetch(`${await getBaseUrl()}/toolkits?limit=1`, {
            headers: { 'x-api-key': key },
            signal: AbortSignal.timeout(15_000),
        });
        if (res.ok) return { ok: true };

        let detail = `${res.status}`;
        try {
            const body = await res.json() as { error?: { message?: string; suggested_fix?: string } };
            const message = body?.error?.message;
            const fix = body?.error?.suggested_fix;
            if (message) detail = fix ? `${message} ${fix}` : message;
        } catch {
            // Non-JSON error body; the status alone will have to do.
        }
        if (res.status === 401) {
            detail += ' Check the key is from platform.composio.dev → Settings → Project Settings → API Keys, and has not been revoked.';
        }
        return { ok: false, error: detail };
    } catch (err) {
        return {
            ok: false,
            error: err instanceof Error ? err.message : 'Could not reach Composio.',
        };
    }
}

/**
 * Make an API call to Composio
 */
/**
 * Turn an error body into something the user can act on.
 *
 * Composio nests the reason as `error.message` on an object. The previous
 * extraction only handled `error` as a *string*, so the detail was always
 * dropped and every failure surfaced as a bare "401 Unauthorized" — which is
 * how an invalid key ended up presenting as "Failed to load toolkits".
 */
export function describeApiError(status: number, statusText: string, rawText: string): string {
    let detail = '';
    try {
        const body = JSON.parse(rawText);
        const err = body?.error;
        if (typeof err === 'string') {
            detail = err;
        } else if (err && typeof err === 'object') {
            const message = typeof err.message === 'string' ? err.message : '';
            const fix = typeof err.suggested_fix === 'string' ? err.suggested_fix : '';
            detail = [message, fix].filter(Boolean).join(' ');
        } else if (typeof body?.message === 'string') {
            detail = body.message;
        }
    } catch {
        // Body isn't JSON; the status line is all we have.
    }
    // 401 is the overwhelmingly common case and has one fix, so name it.
    if (!detail && status === 401) {
        detail = 'Composio rejected the API key. Re-enter it in Settings → Connections.';
    }
    return `Composio API error: ${status} ${statusText}${detail ? `: ${detail}` : ''}`;
}

export async function composioApiCall<T extends z.ZodTypeAny>(
    schema: T,
    path: string,
    params: Record<string, string> = {},
    options: RequestInit = {},
): Promise<z.infer<T>> {
    const authHeaders = await getAuthHeaders();
    const baseURL = await getBaseUrl();
    const url = new URL(`${baseURL}${path}`);

    console.log(`[Composio] ${options.method || 'GET'} ${url}`);
    const startTime = Date.now();

    try {
        Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));

        const response = await fetch(url, {
            ...options,
            headers: {
                ...options.headers,
                ...authHeaders,
                ...(options.method === 'POST' ? { "Content-Type": "application/json" } : {}),
            },
        });

        const duration = Date.now() - startTime;
        console.log(`[Composio] Response in ${duration}ms`);

        const contentType = response.headers.get('content-type') || '';
        const rawText = await response.text();

        if (!response.ok || !contentType.includes('application/json')) {
            console.error(`[Composio] Error response:`, {
                status: response.status,
                statusText: response.statusText,
                contentType,
                preview: rawText.slice(0, 200),
            });
        }

        if (!response.ok) {
            throw new Error(describeApiError(response.status, response.statusText, rawText));
        }

        if (!contentType.includes('application/json')) {
            throw new Error('Expected JSON response');
        }

        let data: unknown;
        try {
            data = JSON.parse(rawText);
        } catch (e) {
            const message = e instanceof Error ? e.message : 'Unknown error';
            throw new Error(`Failed to parse response: ${message}`);
        }

        if (typeof data === 'object' && data !== null && 'error' in data && data.error !== null && typeof data.error === 'object') {
            const parsedError = ZErrorResponse.parse(data);
            throw new Error(`Composio error (${parsedError.error.error_code}): ${parsedError.error.message}`);
        }

        return schema.parse(data);
    } catch (error) {
        console.error(`[Composio] Error:`, error);
        throw error;
    }
}

/**
 * List available toolkits
 */
export async function listToolkits(cursor: string | null = null): Promise<z.infer<ReturnType<typeof ZListResponse<typeof ZToolkit>>>> {
    const params: Record<string, string> = {
        sort_by: "usage",
    };
    if (cursor) {
        params.cursor = cursor;
    }
    return composioApiCall(ZListResponse(ZToolkit), "/toolkits", params);
}

/**
 * Get a specific toolkit
 */
export async function getToolkit(toolkitSlug: string): Promise<z.infer<typeof ZToolkit>> {
    return composioApiCall(ZToolkit, `/toolkits/${toolkitSlug}`);
}

/**
 * List auth configs for a toolkit
 */
export async function listAuthConfigs(
    toolkitSlug: string,
    cursor: string | null = null,
    managedOnly: boolean = false
): Promise<z.infer<ReturnType<typeof ZListResponse<typeof ZAuthConfig>>>> {
    const params: Record<string, string> = {
        toolkit_slug: toolkitSlug,
    };
    if (cursor) {
        params.cursor = cursor;
    }
    if (managedOnly) {
        params.is_composio_managed = "true";
    }
    return composioApiCall(ZListResponse(ZAuthConfig), "/auth_configs", params);
}

/**
 * Create an auth config
 */
export async function createAuthConfig(
    request: z.infer<typeof ZCreateAuthConfigRequest>
): Promise<z.infer<typeof ZCreateAuthConfigResponse>> {
    return composioApiCall(ZCreateAuthConfigResponse, "/auth_configs", {}, {
        method: 'POST',
        body: JSON.stringify(request),
    });
}

/**
 * Create a connected account
 */
export async function createConnectedAccount(
    request: z.infer<typeof ZCreateConnectedAccountRequest>
): Promise<z.infer<typeof ZCreateConnectedAccountResponse>> {
    return composioApiCall(ZCreateConnectedAccountResponse, "/connected_accounts", {}, {
        method: 'POST',
        body: JSON.stringify(request),
    });
}

/**
 * Get a connected account
 */
export async function getConnectedAccount(connectedAccountId: string): Promise<z.infer<typeof ZConnectedAccount>> {
    return composioApiCall(ZConnectedAccount, `/connected_accounts/${connectedAccountId}`);
}

/**
 * Delete a connected account
 */
export async function deleteConnectedAccount(connectedAccountId: string): Promise<z.infer<typeof ZDeleteOperationResponse>> {
    return composioApiCall(ZDeleteOperationResponse, `/connected_accounts/${connectedAccountId}`, {}, {
        method: 'DELETE',
    });
}

/**
 * Search for tools across all toolkits (or optionally filtered by specific toolkit slugs).
 * Returns tools with full input_parameters so the agent knows what params to pass.
 *
 * Uses a limit of 50 (not 15) to avoid the curated-filter-after-limit problem where
 * in-scope results at position 16+ would be discarded if earlier results are out-of-scope.
 */
export async function searchTools(
    searchQuery: string,
    toolkitSlugs?: string[],
): Promise<{ items: NormalizedToolResult[] }> {
    const params: Record<string, string> = {
        query: searchQuery,
        limit: '50',
    };
    if (toolkitSlugs && toolkitSlugs.length === 1) {
        params.toolkit_slug = toolkitSlugs[0];
    }

    const result = await composioApiCall(ZListResponse(ZSearchResultTool), "/tools", params);

    const items: NormalizedToolResult[] = result.items.map((item) => ({
        slug: item.slug,
        name: item.name,
        description: item.description,
        toolkitSlug: item.toolkit.slug,
        inputParameters: {
            type: 'object' as const,
            properties: item.input_parameters?.properties ?? {},
            required: item.input_parameters?.required,
        },
    }));

    return { items };
}

/**
 * Execute a tool action
 */
export async function executeAction(
    actionSlug: string,
    request: z.infer<typeof ZExecuteActionRequest>
): Promise<z.infer<typeof ZExecuteActionResponse>> {
    return composioApiCall(ZExecuteActionResponse, `/tools/execute/${actionSlug}`, {}, {
        method: 'POST',
        body: JSON.stringify(request),
    });
}
