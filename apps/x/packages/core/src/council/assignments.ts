import {
    AssignmentSchema,
    type Assignment,
    type AssignmentStatus,
} from './types.js';
import {
    deleteAssignment as removeAssignment,
    getAssignment,
    listAssignments,
    listMembers,
    newAssignmentId,
    saveAssignment,
} from './store.js';
import { isUnfulfilledPromise, unfulfilledPromiseReason } from './promise.js';

/**
 * Assignment lifecycle.
 *
 * Two restraints carried over deliberately:
 *
 * - **No cascading status.** Completing a child never completes its parent. A
 *   tree that closes itself out from underneath the principal is worse than
 *   one that makes them look.
 * - **Blocked, not deleted.** Stalled work keeps its place in the tree with a
 *   reason attached, because a board should show where things got stuck rather
 *   than quietly forgetting.
 */

/**
 * Hand the task to its assigned member and keep what comes back.
 *
 * Modelled on the CoaleTech agent's `dispatch`: a task is a labelled position
 * in a hierarchy, and the work itself is an ordinary model call — dispatch is
 * not a second, privileged execution path.
 *
 * Two restraints matter. The member's output lands in `result` and moves the
 * task to `in_progress`, never to `done`: returning work is not the same as
 * the principal accepting it. And a failed dispatch blocks with the reason
 * rather than silently leaving the task open, so the board shows the stall.
 */
export async function dispatchAssignment(id: string): Promise<Assignment> {
    const existing = getAssignment(id);
    if (!existing) throw new Error(`Assignment ${id} does not exist.`);
    if (!existing.assigneeId) throw new Error('Assign this to a council member before dispatching it.');

    const member = listMembers().find((m) => m.id === existing.assigneeId);
    if (!member) throw new Error(`Council member ${existing.assigneeId} no longer exists.`);

    const now = new Date().toISOString();
    saveAssignment(AssignmentSchema.parse({ ...existing, status: 'in_progress', dispatchedAt: now, updatedAt: now }));

    try {
        // Imported here rather than at module load: the model stack is heavy,
        // and listing or updating assignments must not pay for it.
        const { runAssignment } = await import('./run.js');
        const result = await runAssignment(member, existing);

        // A member who narrated an approach instead of doing the work has
        // stalled, and this file's own rule is that a stall keeps its place
        // in the tree with a reason attached rather than being quietly
        // forgotten. `result` is kept either way — the principal still needs
        // to read what came back to judge it.
        const promised = isUnfulfilledPromise(result);
        const done = AssignmentSchema.parse({
            ...existing,
            status: promised ? 'blocked' : 'in_progress',
            blockedReason: promised ? unfulfilledPromiseReason(member.title) : null,
            result,
            dispatchedAt: now,
            updatedAt: new Date().toISOString(),
        });
        saveAssignment(done);
        return done;
    } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        const blocked = AssignmentSchema.parse({
            ...existing,
            status: 'blocked',
            blockedReason: `Dispatch failed: ${reason}`,
            dispatchedAt: now,
            updatedAt: new Date().toISOString(),
        });
        saveAssignment(blocked);
        return blocked;
    }
}

export interface CreateAssignmentInput {
    title: string;
    detail?: string;
    assigneeId?: string | null;
    parentId?: string | null;
    sessionId?: string | null;
}

export function createAssignment(input: CreateAssignmentInput): Assignment {
    const title = input.title.trim();
    if (!title) throw new Error('An assignment needs a title.');

    if (input.parentId && !getAssignment(input.parentId)) {
        throw new Error(`Parent assignment ${input.parentId} does not exist.`);
    }

    const now = new Date().toISOString();
    const assignment = AssignmentSchema.parse({
        id: newAssignmentId(),
        title,
        detail: input.detail?.trim() ?? '',
        assigneeId: input.assigneeId ?? null,
        status: 'open',
        parentId: input.parentId ?? null,
        sessionId: input.sessionId ?? null,
        blockedReason: null,
        createdAt: now,
        updatedAt: now,
    });
    saveAssignment(assignment);
    return assignment;
}

export interface UpdateAssignmentInput {
    title?: string;
    detail?: string;
    assigneeId?: string | null;
    status?: AssignmentStatus;
    /** Required when moving to `blocked`; cleared automatically when leaving it. */
    blockedReason?: string | null;
}

export function updateAssignment(id: string, patch: UpdateAssignmentInput): Assignment {
    const existing = getAssignment(id);
    if (!existing) throw new Error(`Assignment ${id} does not exist.`);

    const status = patch.status ?? existing.status;
    // A blocked item with no reason is the thing this feature exists to
    // prevent: a board full of stalls nobody can explain later.
    if (status === 'blocked') {
        const reason = (patch.blockedReason ?? existing.blockedReason ?? '').trim();
        if (!reason) throw new Error('Blocking an assignment requires a reason.');
    }

    const next = AssignmentSchema.parse({
        ...existing,
        ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
        ...(patch.detail !== undefined ? { detail: patch.detail.trim() } : {}),
        ...(patch.assigneeId !== undefined ? { assigneeId: patch.assigneeId } : {}),
        status,
        blockedReason:
            status === 'blocked'
                ? (patch.blockedReason ?? existing.blockedReason ?? '').trim()
                : null,
        updatedAt: new Date().toISOString(),
    });
    saveAssignment(next);
    return next;
}

/**
 * Remove an assignment and everything beneath it.
 *
 * Deletion is for mistakes; abandoning real work should be `cancelled`, which
 * keeps the record. Orphaning children would leave rows the board can never
 * show, so the subtree goes together.
 */
export function deleteAssignmentTree(id: string): string[] {
    const all = listAssignments();
    const removed: string[] = [];
    const queue = [id];
    while (queue.length) {
        const current = queue.shift()!;
        removed.push(current);
        for (const child of all.filter((a) => a.parentId === current)) queue.push(child.id);
    }
    for (const target of removed) removeAssignment(target);
    return removed;
}

export interface AssignmentNode extends Assignment {
    children: AssignmentNode[];
}

/**
 * Assignments as a forest. Nodes whose parent is missing surface at the root
 * rather than disappearing — an unreachable item is worse than a misplaced one.
 */
export function assignmentTree(): AssignmentNode[] {
    const all = listAssignments();
    const byId = new Map<string, AssignmentNode>(all.map((a) => [a.id, { ...a, children: [] }]));
    const roots: AssignmentNode[] = [];
    for (const node of byId.values()) {
        const parent = node.parentId ? byId.get(node.parentId) : undefined;
        if (parent) parent.children.push(node);
        else roots.push(node);
    }
    return roots;
}

export { listAssignments, getAssignment };
