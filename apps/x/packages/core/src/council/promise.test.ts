import { describe, expect, it } from 'vitest';
import { isUnfulfilledPromise, unfulfilledPromiseReason } from './promise.js';

/**
 * The detector's whole risk is false positives: a wrong flag puts a
 * misleading stall on the principal's board and hides real delivered work
 * behind a "blocked" badge. So the negative cases below carry more weight
 * than the positive ones, and several are deliberately adversarial —
 * deliverables that open with, or contain, the exact phrases the regex hunts.
 */

const LOREM =
    'The contract caps liability at twelve months of fees, which is below our '
    + 'usual floor of twenty-four. Clause 8.3 also gives them unilateral '
    + 'termination on thirty days notice while binding us to ninety. Recommend '
    + 'countering on both before signature; the rest is standard and fine.';

describe('isUnfulfilledPromise — flags a promise with nothing behind it', () => {
    it('catches the canonical failure: an intent to start and no work', () => {
        expect(isUnfulfilledPromise("I'll now begin reviewing the contract and report back.")).toBe(true);
    });

    it('catches "Let me start" with only a sign-off after it', () => {
        expect(isUnfulfilledPromise('Understood. Let me start on the analysis. Back shortly.')).toBe(true);
    });

    it('catches the Chinese phrasing the upstream list covers', () => {
        expect(isUnfulfilledPromise('好的，接下来我处理这个任务。')).toBe(true);
    });

    it('catches a promise buried under a restatement of the task', () => {
        expect(isUnfulfilledPromise(
            'You have asked me to assess vendor risk across the three shortlisted '
            + 'suppliers, weighing security posture and contract terms. '
            + "I will now start that assessment.",
        )).toBe(true);
    });
});

describe('isUnfulfilledPromise — does not flag real work', () => {
    it('passes a plain deliverable with no promise language at all', () => {
        expect(isUnfulfilledPromise(LOREM)).toBe(false);
    });

    it('passes a plan that is actually carried out in the same reply', () => {
        // The exact false positive a literal port of the upstream regex
        // produces: an ordinary discourse marker, followed by the goods.
        expect(isUnfulfilledPromise(`Next, I'll set out the three options.\n\n${LOREM}`)).toBe(false);
    });

    it('passes "I will recommend" — a finding, not a promise', () => {
        // Guards the narrowness of the pattern: bare `I will` must not match,
        // only `I will now|start|begin`.
        expect(isUnfulfilledPromise('I will recommend option B on the strength of the indemnity alone.')).toBe(false);
    });

    it('passes a long answer that opens by announcing itself', () => {
        expect(isUnfulfilledPromise(`Let me begin with the liability cap.\n\n${LOREM}`)).toBe(false);
    });

    it('scores the LAST promise, not the first', () => {
        // A reply that promises, delivers, then promises again with nothing
        // after it has still stopped short — the trailing promise is the one
        // that decides.
        expect(isUnfulfilledPromise(`Let me begin.\n\n${LOREM}\n\nNext, I'll start the pricing review.`)).toBe(true);
    });

    it('handles empty and nullish input', () => {
        expect(isUnfulfilledPromise('')).toBe(false);
        expect(isUnfulfilledPromise(null)).toBe(false);
        expect(isUnfulfilledPromise(undefined)).toBe(false);
    });
});

describe('isUnfulfilledPromise — repeated calls', () => {
    it('gives the same answer when called repeatedly', () => {
        // Honest about what this does and does not defend. The pattern is
        // module-level and /g, which LOOKS like a lastIndex trap, but
        // `matchAll` iterates a clone and never advances the original — so
        // today this cannot fail, and mutation-testing confirms it (deleting
        // an explicit reset left all tests green, which is how the reset was
        // found to be dead code and removed).
        //
        // It stays as a regression guard: rewrite the scan as an `exec` loop
        // over the shared regex and statefulness becomes real, at which point
        // this is the test that fails.
        const text = "I'll now begin the review.";
        expect([
            isUnfulfilledPromise(text),
            isUnfulfilledPromise(text),
            isUnfulfilledPromise(text),
        ]).toEqual([true, true, true]);
    });
});

describe('unfulfilledPromiseReason', () => {
    it('names the member and says what to do next', () => {
        const reason = unfulfilledPromiseReason('Chief Financial Officer');
        expect(reason).toContain('Chief Financial Officer');
        expect(reason).toContain('re-dispatch');
    });
});
