/**
 * Canonical API endpoints for the hosted providers Dhow ships presets for.
 *
 * These are all OpenAI-compatible except `ollama-cloud`, which speaks the
 * native Ollama API with a bearer token. The value here is only a DEFAULT:
 * it prefills the endpoint field when connecting and acts as the fallback
 * when a saved provider entry has no baseURL. Several of these vendors run
 * separate mainland-China and international hosts, so the field stays
 * editable rather than being hardcoded at the call site.
 */
export const PROVIDER_DEFAULT_BASE_URLS = {
    deepseek: "https://api.deepseek.com/v1",
    // Moonshot also serves api.moonshot.cn for mainland accounts.
    moonshot: "https://api.moonshot.ai/v1",
    // Z.ai is the international host; open.bigmodel.cn serves mainland accounts.
    zhipu: "https://api.z.ai/api/paas/v4",
    // DashScope international; dashscope.aliyuncs.com serves mainland accounts.
    dashscope: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    "ollama-cloud": "https://ollama.com",
} as const;

export type PresetProviderFlavor = keyof typeof PROVIDER_DEFAULT_BASE_URLS;

/** Flavors that are plain OpenAI-compatible chat endpoints. */
export const OPENAI_COMPATIBLE_FLAVORS = [
    "deepseek",
    "moonshot",
    "zhipu",
    "dashscope",
] as const satisfies readonly PresetProviderFlavor[];

export function isOpenAICompatibleFlavor(flavor: string): boolean {
    return (OPENAI_COMPATIBLE_FLAVORS as readonly string[]).includes(flavor);
}

export function defaultBaseUrlFor(flavor: string): string | undefined {
    return PROVIDER_DEFAULT_BASE_URLS[flavor as PresetProviderFlavor];
}

/**
 * Vendors that operate a second, account-incompatible host for mainland China.
 * A key issued on one console is rejected by the other with a plain 401, which
 * is indistinguishable from a genuinely bad key — so when a connect fails we
 * point at the alternate rather than leaving the user to guess.
 */
export const REGIONAL_ALTERNATES: Partial<Record<PresetProviderFlavor, {
    /** The console that issues keys for the alternate host. */
    console: string;
    baseURL: string;
    label: string;
}>> = {
    moonshot: {
        console: "platform.moonshot.cn",
        baseURL: "https://api.moonshot.cn/v1",
        label: "mainland China",
    },
    zhipu: {
        console: "open.bigmodel.cn",
        baseURL: "https://open.bigmodel.cn/api/paas/v4",
        label: "mainland China",
    },
    dashscope: {
        console: "bailian.console.aliyun.com",
        baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        label: "mainland China",
    },
};

/**
 * Extra guidance to append to a failed connect. Returns undefined when the
 * failure is not an auth error or the flavor has no regional twin — a wrong
 * key should still read as a wrong key.
 */
export function connectFailureHint(flavor: string, message: string, currentBaseUrl?: string): string | undefined {
    const alt = REGIONAL_ALTERNATES[flavor as PresetProviderFlavor];
    if (!alt) return undefined;
    if (!/\b401\b|invalid[_ ]authentication|unauthorized|api key/i.test(message)) return undefined;
    // Already pointed at the alternate — the key really is wrong.
    if (currentBaseUrl && currentBaseUrl.replace(/\/+$/, "") === alt.baseURL) return undefined;
    return `If this key came from ${alt.console} (${alt.label}), change the endpoint to ${alt.baseURL} — keys are not shared between the two platforms.`;
}
