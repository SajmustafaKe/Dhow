import { ProviderV4 } from '@ai-sdk/provider';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { DHOW_GATEWAY_BASE_URL } from '../config/env.js';
import { getDhowAccessToken } from '../auth/dhow-auth.js';
import { getCurrentUseCase } from '../analytics/use_case.js';

// "Dhow account" model provider (flavor "dhow"): runs model calls against the
// hosted gateway, authorized by the signed-in Dhow session (auth/dhow-auth.ts)
// instead of an API key. Like the "codex" flavor it has no models.json entry —
// resolveProviderConfig returns a bare { flavor: "dhow" } and auth is injected
// per request here.
//
// The gateway is OpenAI-compatible, so unlike codex there is no wire
// normalization: the only per-request work is attaching the bearer.

type ProviderSummary = {
    id: string;
    name: string;
    models: Array<{
        id: string;
        name?: string;
        reasoning?: boolean;
    }>;
};

/**
 * Attach the account bearer to every gateway call. Throws
 * DhowAuthRequiredError when signed out — callers surface "Sign in with Dhow"
 * rather than letting the gateway answer 401.
 *
 * Also forwards the current use-case as request headers. Token counts alone
 * say how much was spent but not on what; these say which surface spent it —
 * meeting notes, email drafting, a named background agent — so usage can be
 * attributed and shown back to the user per feature. Rowboat's gateway did
 * the same (historical packages/core/src/models/gateway.ts, the
 * `x-rowboat-*` headers); analytics/use_case.ts is the AsyncLocalStorage that
 * still carries the context.
 */
const dhowFetch: typeof fetch = async (input, init) => {
    const token = await getDhowAccessToken();
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${token}`);
    const ctx = getCurrentUseCase();
    if (ctx?.useCase) headers.set('x-dhow-use-case', ctx.useCase);
    if (ctx?.subUseCase) headers.set('x-dhow-sub-use-case', ctx.subUseCase);
    if (ctx?.agentName) headers.set('x-dhow-agent-name', ctx.agentName);
    return fetch(input, { ...init, headers });
};

/**
 * AI SDK provider for the dhow flavor. The apiKey is a placeholder that never
 * reaches the wire — dhowFetch overwrites the Authorization header with the
 * live session token, which may have been refreshed since the provider was
 * constructed.
 */
export function getDhowProvider(): ProviderV4 {
    return createOpenAICompatible({
        name: 'dhow',
        apiKey: 'dhow-account',
        baseURL: DHOW_GATEWAY_BASE_URL,
        fetch: dhowFetch,
    }) as unknown as ProviderV4;
}

/**
 * Models the signed-in account is entitled to, shaped like listCodexModels for
 * the models:list merge. The gateway decides eligibility per plan, so there is
 * no local fallback list: an empty result means "your plan grants none", which
 * is a real answer and must not be papered over with hardcoded ids the gateway
 * would then reject.
 */
export async function listDhowModels(): Promise<{ providers: ProviderSummary[] }> {
    const res = await dhowFetch(`${DHOW_GATEWAY_BASE_URL.replace(/\/+$/, '')}/models`);
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Failed to list Dhow models (${res.status}): ${body.slice(0, 200)}`);
    }
    const body = await res.json() as {
        data?: Array<{ id?: string; name?: string; reasoning?: boolean }>;
    };
    const models = (body.data ?? [])
        .filter((m): m is { id: string; name?: string; reasoning?: boolean } =>
            typeof m.id === 'string' && m.id.length > 0)
        .map((m) => ({
            id: m.id,
            ...(m.name ? { name: m.name } : {}),
            ...(m.reasoning === undefined ? {} : { reasoning: m.reasoning }),
        }));
    return {
        providers: [{
            id: 'dhow',
            name: 'Dhow',
            models,
        }],
    };
}
