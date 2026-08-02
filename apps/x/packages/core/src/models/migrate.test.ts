import { describe, expect, it } from 'vitest';
import { migrateModelsConfig } from './migrate.js';

/**
 * The migration contract: evaluate the v1 resolution rules (including the
 * curated signed-in defaults that lived only in code) one last time and
 * write their answers explicitly, so v2's simple "override else assistant"
 * rules produce identical effective models. Overrides are written ONLY
 * where the old effective model differs from inherit-from-assistant.
 */

describe('migrateModelsConfig', () => {
    it('returns null for a config that is already v2', () => {
        expect(migrateModelsConfig({ version: 2, providers: {} })).toBeNull();
    });

    it('signed-out BYOK: adopts the top-level pair as assistant, writes no task overrides', () => {
        const v1 = {
            provider: { flavor: 'openai', apiKey: 'sk-a' },
            model: 'gpt-5.4',
            providers: { openai: { apiKey: 'sk-a', model: 'gpt-5.4', models: ['gpt-5.4'] } },
        };
        expect(migrateModelsConfig(v1)).toEqual({
            version: 2,
            providers: { openai: { flavor: 'openai', apiKey: 'sk-a' } },
            assistantModel: { provider: 'openai', model: 'gpt-5.4' },
        });
    });

    it('explicit v1 overrides survive: legacy strings pair with the top-level flavor, refs pass through', () => {
        const v1 = {
            provider: { flavor: 'openai', apiKey: 'sk-a' },
            model: 'gpt-5.4',
            providers: { openai: { apiKey: 'sk-a' } },
            knowledgeGraphModel: 'gpt-5.4-mini', // legacy string form
            meetingNotesModel: { provider: 'ollama', model: 'qwen3' }, // ref form
        };
        const v2 = migrateModelsConfig(v1);
        expect(v2?.taskModels).toEqual({
            knowledgeGraph: { provider: 'openai', model: 'gpt-5.4-mini' },
            meetingNotes: { provider: 'ollama', model: 'qwen3' },
        });
    });

    it('a v1 live-note override propagates to backgroundTask (v1 bg tasks mirrored live-note)', () => {
        const v1 = {
            provider: { flavor: 'openai', apiKey: 'sk-a' },
            model: 'gpt-5.4',
            liveNoteAgentModel: { provider: 'ollama', model: 'qwen3' },
        };
        expect(migrateModelsConfig(v1)?.taskModels).toEqual({
            liveNoteAgent: { provider: 'ollama', model: 'qwen3' },
            backgroundTask: { provider: 'ollama', model: 'qwen3' },
        });
    });

    it('an override equal to the assistant is dropped (inherit produces the same model)', () => {
        const v1 = {
            provider: { flavor: 'openai', apiKey: 'sk-a' },
            model: 'gpt-5.4',
            knowledgeGraphModel: 'gpt-5.4',
        };
        expect(migrateModelsConfig(v1)?.taskModels).toBeUndefined();
    });

    it('a legacy "rowboat" defaultSelection is dropped — that hosted provider is gone', () => {
        const v1 = {
            provider: { flavor: 'openai', apiKey: 'sk-a' },
            model: 'gpt-5.4',
            defaultSelection: { provider: 'rowboat', model: 'google/gemini-3.5-flash' },
        };
        expect(migrateModelsConfig(v1)?.assistantModel)
            .toEqual({ provider: 'openai', model: 'gpt-5.4' });
    });

    it('providers without credentials are dropped; connection prefs survive', () => {
        const v1 = {
            provider: { flavor: 'openai', apiKey: 'sk-a' },
            model: 'gpt-5.4',
            providers: {
                openai: { apiKey: 'sk-a', models: ['gpt-5.4'] },
                anthropic: { model: 'claude-opus-4-8' }, // no key: never connected
                ollama: { baseURL: 'http://localhost:11434', contextLength: 32768, reasoningEffort: 'low' },
            },
        };
        expect(migrateModelsConfig(v1)?.providers).toEqual({
            openai: { flavor: 'openai', apiKey: 'sk-a' },
            ollama: { flavor: 'ollama', baseURL: 'http://localhost:11434', contextLength: 32768, reasoningEffort: 'low' },
        });
    });

    it('degrades gracefully on garbage input: empty v2 config', () => {
        expect(migrateModelsConfig('not an object')).toEqual({ version: 2, providers: {} });
        expect(migrateModelsConfig({})).toEqual({ version: 2, providers: {} });
    });

    it('deferBackgroundTasks is carried over', () => {
        const v1 = { provider: { flavor: 'openai', apiKey: 'sk-a' }, model: 'gpt-5.4', deferBackgroundTasks: true };
        expect(migrateModelsConfig(v1)?.deferBackgroundTasks).toBe(true);
    });
});
