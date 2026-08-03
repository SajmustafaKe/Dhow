import path from 'path';
import { WorkDir } from '../config/config.js';

/**
 * Both calendar providers write into one directory, because sixteen call
 * sites already read events from there and a per-provider layout would mean
 * teaching every one of them about providers.
 *
 * Sharing a directory needs an ownership rule. Each sync deletes files that
 * fell out of its window, and without a way to tell whose file is whose, a
 * Google sweep would delete every Outlook event on its next pass — and then
 * Outlook would recreate them, forever. The prefix below is that rule.
 *
 * Google keeps the bare `{eventId}.json` it has always written, so nothing
 * that predates Outlook support needs migrating.
 */
export const CALENDAR_SYNC_DIR = path.join(WorkDir, 'calendar_sync');

/** Marks a file — and the event id inside it — as belonging to Outlook. */
export const OUTLOOK_EVENT_PREFIX = 'ms-';

/** Files no sync owns, and which neither may delete. */
const RESERVED_FILES = new Set(['sync_state.json', 'composio_state.json']);

export function isReservedCalendarFile(filename: string): boolean {
    return RESERVED_FILES.has(filename);
}

export function isOutlookCalendarFile(filename: string): boolean {
    return filename.startsWith(OUTLOOK_EVENT_PREFIX);
}

/**
 * A globally unique id for an Outlook event.
 *
 * Graph ids are unique within a mailbox but say nothing about which mailbox,
 * so two connected accounts could collide. The account is folded in, and the
 * result is used as both the filename stem and the event's `id` field so the
 * two never drift apart.
 *
 * `-` is the separator on purpose: cleanup elsewhere splits attachment names
 * on `_doc_`, and a `_` here could be mistaken for part of that delimiter.
 */
export function outlookEventId(accountId: string, graphEventId: string): string {
    // Graph ids are base64url-ish and may carry characters a filesystem or a
    // path traversal check would object to.
    const safeGraphId = graphEventId.replace(/[^A-Za-z0-9_-]/g, '');
    const safeAccount = accountId.replace(/[^A-Za-z0-9]/g, '').slice(0, 12);
    return `${OUTLOOK_EVENT_PREFIX}${safeAccount}-${safeGraphId}`;
}
