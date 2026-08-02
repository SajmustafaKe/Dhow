import { describe, expect, it } from 'vitest';
import { selectInitialModel } from './initial-selection.js';

describe('selectInitialModel', () => {
    it('picks the first model the provider listed', () => {
        expect(selectInitialModel(['gpt-4.1', 'gpt-5.4', 'gpt-5.4-mini'])).toBe('gpt-4.1');
    });

    it('preserves the provider list order rather than sorting', () => {
        expect(selectInitialModel(['qwen3', 'llama3'])).toBe('qwen3');
    });

    it('returns null when the provider listed nothing', () => {
        expect(selectInitialModel([])).toBeNull();
    });
});
