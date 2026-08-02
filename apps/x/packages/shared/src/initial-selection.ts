/**
 * Initial model selection for a provider being connected for the first time.
 *
 * One rule: take the first model the provider returned. With no list at all,
 * return null — the caller offers retry or manual entry.
 *
 * This runs ONLY when a provider is first connected and has no saved
 * selection. It must never run over an existing choice: after initial setup
 * the saved model configuration is the source of truth, and a change in the
 * order the provider lists its models must not silently replace what the
 * user picked.
 */
export function selectInitialModel(availableModelIds: string[]): string | null {
    return availableModelIds[0] ?? null;
}
