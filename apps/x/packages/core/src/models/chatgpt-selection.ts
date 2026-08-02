import { FSModelConfigRepo, type IModelConfigRepo } from "./repo.js";
import { listCodexModels } from "./codex.js";
import { selectInitialModel } from "./initial-selection.js";

/**
 * Model-selection hooks for the ChatGPT-subscription (codex) sign-in
 * lifecycle. ChatGPT is a provider like any other: signing in connects it,
 * so it follows the same rules —
 *
 * - Connect with no saved assistant → pick an initial model (the first the
 *   subscription lists) and save it. A saved assistant is NEVER replaced.
 * - Disconnect → drop the selections that reference the provider (same
 *   dangling-ref cleanup as removing any provider).
 */

/**
 * The model config repo is constructed directly rather than resolved from the
 * DI container. chatgpt-auth reaches this module through a dynamic import
 * during sign-out, and pulling in the container there would both boot the
 * entire application graph and land its binding in a temporal dead zone.
 * FSModelConfigRepo holds no state — every method reads and writes
 * models.json — so a fresh instance is equivalent to the container singleton.
 */
function modelConfigRepo(): IModelConfigRepo {
    return new FSModelConfigRepo();
}

export async function applyCodexInitialSelection(): Promise<void> {
    try {
        const repo = modelConfigRepo();
        const cfg = await repo.getConfig().catch(() => null);
        if (cfg?.assistantModel) return; // saved choice — never replaced
        const catalog = await listCodexModels();
        const ids = catalog.providers[0]?.models.map((m) => m.id) ?? [];
        const model = selectInitialModel(ids);
        if (model) {
            await repo.updateConfig({ assistantModel: { provider: "codex", model } });
        }
    } catch (error) {
        // Best-effort: a failed initial selection must never break sign-in.
        // The picker copes with an unset assistant (shows the connect hint).
        console.warn("[models] Initial selection after ChatGPT sign-in failed:", error);
    }
}

export async function clearCodexSelections(): Promise<void> {
    try {
        const repo = modelConfigRepo();
        // "codex" has no providers-map entry; removeProvider still clears
        // the assistantModel / task overrides that reference it.
        await repo.removeProvider("codex");
    } catch (error) {
        console.warn("[models] Clearing codex selections after sign-out failed:", error);
    }
}
