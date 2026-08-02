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
