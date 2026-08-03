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

/**
 * Marks an event recovered from a `text/calendar` part in an email.
 *
 * This is the only calendar source an IMAP account has: there is no API to
 * ask, so the invitation itself is the record. It is also the weakest source
 * — it sees only meetings someone emailed about — so a real calendar API
 * always wins where both describe the same meeting (see `iCalUID` dedupe).
 */
export const INVITE_EVENT_PREFIX = 'ics-';

/** Files no sync owns, and which neither may delete. */
const RESERVED_FILES = new Set(['sync_state.json', 'composio_state.json']);

export function isReservedCalendarFile(filename: string): boolean {
    return RESERVED_FILES.has(filename);
}

export function isOutlookCalendarFile(filename: string): boolean {
    return filename.startsWith(OUTLOOK_EVENT_PREFIX);
}

export function isInviteCalendarFile(filename: string): boolean {
    return filename.startsWith(INVITE_EVENT_PREFIX);
}

/**
 * True for a file the Google sync must leave alone.
 *
 * Google owns the bare `{eventId}.json` names it has always written, so this
 * is expressed as "anything another provider claimed" rather than a list
 * Google has to keep in step.
 */
export function isForeignCalendarFile(filename: string): boolean {
    return isOutlookCalendarFile(filename) || isInviteCalendarFile(filename);
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
/**
 * A filesystem-safe id for an event parsed out of an invitation.
 *
 * Keyed on the iCalendar UID alone, deliberately: the same meeting mailed to
 * two of your accounts is one meeting, and both copies must resolve to one
 * file rather than racing to create two.
 */
export function inviteEventId(icalUid: string): string {
    const safe = icalUid.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 180);
    return `${INVITE_EVENT_PREFIX}${safe}`;
}

export function outlookEventId(accountId: string, graphEventId: string): string {
    // Graph ids are base64url-ish and may carry characters a filesystem or a
    // path traversal check would object to.
    const safeGraphId = graphEventId.replace(/[^A-Za-z0-9_-]/g, '');
    const safeAccount = accountId.replace(/[^A-Za-z0-9]/g, '').slice(0, 12);
    return `${OUTLOOK_EVENT_PREFIX}${safeAccount}-${safeGraphId}`;
}
