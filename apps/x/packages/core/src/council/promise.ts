/**
 * Broken-promise detection for dispatched assignments.
 *
 * The failure this catches is already documented one file over, in run.ts's
 * system prompt:
 *
 *     'Produce the actual output — the draft, the analysis, the list — not a
 *      description of how you would approach it.'
 *     // Without this the model narrates an approach instead of producing the
 *     // thing, and the principal has to ask twice.
 *
 * Prompting reduces that; it does not eliminate it. This is the check for
 * what gets through — a member who answers "I'll now review the contract and
 * report back" and returns nothing else. The board currently shows that as a
 * delivered result, indistinguishable from real work, and the principal only
 * finds out by reading it.
 *
 * Ported from CoaleTech Agent's plugins/csuite/promise_detector.py (itself
 * from OMC's core/vessel.py::detect_unfulfilled_promises). The phrase list is
 * theirs. The gate is not, and the gate is the part that matters.
 *
 * THE GATE. Upstream fires only on "a node that finished with a result and
 * dispatched no children afterward — a promise followed by real dispatched
 * work is a plan being carried out, not a broken one." Dhow has no such
 * signal: runAssignment (run.ts:62) is a single generateText call with no
 * tools, so an assignment can never dispatch children and that test would be
 * vacuously true for every result. Ported literally, the regex alone would
 * flag any deliverable containing an ordinary discourse marker like
 * "Next, I'll outline the three options:" — and then list the three options.
 *
 * The translation of "dispatched no children" into a single-shot text world
 * is "produced nothing after the promise". A plan that gets carried out has
 * the work following it. A broken promise ends on the promise. So: find the
 * LAST promise phrase and look at what comes after it.
 */

/**
 * Future-action phrases, English and Chinese.
 *
 * Carried over verbatim from the upstream list minus its "I need to
 * dispatch_child" entry, which named an internal tool neither app has.
 *
 * Note how narrow the English side is: `I will (?:now |start |begin )`, not
 * a bare `I will`. "I will recommend option B" is a finding and must not
 * match; "I will now begin the review" is a promise and must.
 */
const PROMISE_PATTERNS = new RegExp(
    [
        // Chinese future-action phrases
        '我将|接下来|下一步|现在开始|马上开始|即将开始|准备开始',
        '我会(?:立即|马上|开始)',
        '下面我(?:来|将|要)',
        '分配给\\w+处理|派遣给\\w+负责',
        // English future-action phrases
        "I will (?:now |start |begin )|I'll (?:now |start |begin )",
        'Let me (?:start|begin|proceed)',
        "Next,? I'?(?:ll| will)",
        "I'?m going to (?:start|begin)",
        'Going to dispatch',
    ].join('|'),
    'gi',
);

/**
 * How much substantive text after the last promise counts as the promise
 * having been kept.
 *
 * Deliberately generous. A false negative costs nothing — the result is
 * saved and read exactly as it is today. A false positive puts a misleading
 * stall on the principal's board, which is worse than the bug being caught.
 * So the bar for "this member did no work" is that they produced almost
 * nothing after saying they would start.
 */
const SUBSTANTIVE_TAIL_CHARS = 160;

/**
 * True when `text` reads as a member promising future action rather than
 * handing back the work.
 *
 * Returns false for any text that continues substantively past its last
 * promise phrase, which is what a plan-then-execute answer looks like.
 */
export function isUnfulfilledPromise(text: string | null | undefined): boolean {
    if (!text) return false;

    // `matchAll` requires /g and iterates against an internal clone, so the
    // module-level regex's lastIndex is never read or advanced here. An
    // explicit reset would be dead code — proved by deleting one and watching
    // every test still pass. Swap this for an `exec` loop and that stops
    // being true; promise.test.ts's repeated-call case is the guard for it.
    let lastEnd = -1;
    for (const match of text.matchAll(PROMISE_PATTERNS)) {
        lastEnd = (match.index ?? 0) + match[0].length;
    }
    if (lastEnd < 0) return false;

    // Whitespace is not work. Neither is a trailing "...and report back."
    const tail = text.slice(lastEnd).trim();
    return tail.length < SUBSTANTIVE_TAIL_CHARS;
}

/**
 * The reason recorded on an assignment blocked for this.
 *
 * Names the member so the board reads as an account of what happened rather
 * than a system error, and says what to do about it — re-dispatching is the
 * fix, and it is not obvious that it would be.
 */
export function unfulfilledPromiseReason(memberTitle: string): string {
    return `${memberTitle} described what they would do instead of doing it. The reply is kept in the result below; re-dispatch to try again.`;
}
