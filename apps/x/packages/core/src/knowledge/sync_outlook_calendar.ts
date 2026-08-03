import fs from 'fs';
import path from 'path';
import { NodeHtmlMarkdown } from 'node-html-markdown';
import { PrefixLogger } from '@x/shared';
import container from '../di/container.js';
import type { IOAuthRepo } from '../auth/repo.js';
import { GraphClientFactory, graphRequest } from './graph-client-factory.js';
import {
    CALENDAR_SYNC_DIR,
    isOutlookCalendarFile,
    isReservedCalendarFile,
    outlookEventId,
} from './calendar_files.js';

const log = new PrefixLogger('OutlookCal');
const SYNC_INTERVAL_MS = 60 * 1000;
const LOOKBACK_DAYS = 7;
const LOOKAHEAD_DAYS = 14;
const MAX_PAGES = 10;
const nhm = new NodeHtmlMarkdown();

/**
 * Outlook calendar sync.
 *
 * Writes the *Google* event shape, not a Microsoft one. Sixteen call sites —
 * meeting prep, the live-note agent, the mic detector, skills, the workspace
 * watcher — already read `{eventId}.json` files in the Google Calendar v3
 * shape. Introducing a second shape would mean touching all of them and
 * leaving two ways to describe a meeting; normalising at the edge, exactly as
 * `mail_thread.ts` does for mail, leaves every consumer provider-blind.
 *
 * `calendarView` rather than `events`: it expands recurring series into
 * individual occurrences, which is what Google's `singleEvents: true` gives
 * and what every consumer assumes.
 */

export interface GraphDateTime {
    dateTime?: string;
    timeZone?: string;
}

export interface GraphAttendee {
    emailAddress?: { name?: string; address?: string };
    type?: string;
    status?: { response?: string };
}

export interface GraphEvent {
    id?: string;
    subject?: string;
    bodyPreview?: string;
    body?: { contentType?: string; content?: string };
    start?: GraphDateTime;
    end?: GraphDateTime;
    isAllDay?: boolean;
    isCancelled?: boolean;
    location?: { displayName?: string };
    attendees?: GraphAttendee[];
    organizer?: { emailAddress?: { name?: string; address?: string } };
    onlineMeeting?: { joinUrl?: string };
    onlineMeetingUrl?: string;
    webLink?: string;
    /** Graph's spelling of the iCalendar UID — the cross-source dedupe key. */
    iCalUId?: string;
    lastModifiedDateTime?: string;
    seriesMasterId?: string;
    showAs?: string;
}

interface EventPage {
    value?: GraphEvent[];
    '@odata.nextLink'?: string;
}

/**
 * Graph response values, mapped onto the four Google uses.
 *
 * The mic detector skips events the user declined, so `declined` has to
 * survive this translation intact — getting it wrong would start recording
 * meetings the user already said no to.
 */
const RESPONSE_STATUS: Record<string, string> = {
    none: 'needsAction',
    notResponded: 'needsAction',
    organizer: 'accepted',
    accepted: 'accepted',
    tentativelyAccepted: 'tentative',
    declined: 'declined',
};

/**
 * Graph reports local wall time with a separate zone and no offset
 * ("2026-08-05T09:00:00.0000000"). Consumers pass this string to `new Date()`,
 * which reads an offsetless string as *local* time — correct only by accident.
 * Requesting UTC (see PREFER_UTC) and appending `Z` makes it unambiguous.
 */
function toIsoUtc(value?: string): string | undefined {
    if (!value) return undefined;
    if (/[Zz]$|[+-]\d{2}:?\d{2}$/.test(value)) return value;
    // Graph pads to 7 fractional digits; JS accepts at most 3.
    const trimmed = value.replace(/(\.\d{3})\d+$/, '$1');
    return `${trimmed}Z`;
}

/** An all-day event is a date in Google's shape, not a midnight timestamp. */
function toGoogleTime(slot: GraphDateTime | undefined, isAllDay: boolean): Record<string, string> | undefined {
    const iso = toIsoUtc(slot?.dateTime);
    if (!iso) return undefined;
    if (isAllDay) return { date: iso.slice(0, 10) };
    return { dateTime: iso, timeZone: slot?.timeZone || 'UTC' };
}

function plainText(event: GraphEvent): string | undefined {
    const body = event.body;
    if (body?.content) {
        return body.contentType?.toLowerCase() === 'html'
            ? nhm.translate(body.content).trim()
            : body.content.trim();
    }
    return event.bodyPreview?.trim() || undefined;
}

/**
 * One Graph event as a Google Calendar event.
 *
 * `selfEmail` marks which attendee is the user — Graph has no equivalent of
 * Google's `self` flag, and the mic detector needs it to find the user's own
 * response.
 */
export function toGoogleEvent(
    event: GraphEvent,
    accountId: string,
    selfEmail?: string,
): Record<string, unknown> | null {
    if (!event.id) return null;

    const isAllDay = event.isAllDay === true;
    const start = toGoogleTime(event.start, isAllDay);
    const end = toGoogleTime(event.end, isAllDay);
    // An event with no start is unplaceable; every consumer sorts or filters
    // by it, so storing one would only produce NaN dates downstream.
    if (!start) return null;

    const selfLower = selfEmail?.toLowerCase();
    const attendees = (event.attendees ?? [])
        .map((a) => {
            const email = a.emailAddress?.address;
            if (!email) return null;
            const entry: Record<string, unknown> = {
                email,
                responseStatus: RESPONSE_STATUS[a.status?.response ?? ''] ?? 'needsAction',
            };
            if (a.emailAddress?.name) entry.displayName = a.emailAddress.name;
            if (a.type === 'optional') entry.optional = true;
            if (selfLower && email.toLowerCase() === selfLower) entry.self = true;
            return entry;
        })
        .filter((a): a is Record<string, unknown> => a !== null);

    const joinUrl = event.onlineMeeting?.joinUrl || event.onlineMeetingUrl;
    const description = plainText(event);
    const organizerEmail = event.organizer?.emailAddress?.address;

    const normalized: Record<string, unknown> = {
        id: outlookEventId(accountId, event.id),
        summary: event.subject || '(no title)',
        start,
        end: end ?? start,
        status: event.isCancelled ? 'cancelled' : 'confirmed',
        // Kept so a consumer can tell where an event came from without
        // parsing the id, and so a future writer knows what it may modify.
        source: { provider: 'microsoft', accountId, graphId: event.id },
    };

    if (description) normalized.description = description;
    if (event.location?.displayName) normalized.location = event.location.displayName;
    if (attendees.length > 0) normalized.attendees = attendees;
    if (organizerEmail) {
        const organizer: Record<string, unknown> = { email: organizerEmail };
        const name = event.organizer?.emailAddress?.name;
        if (name) organizer.displayName = name;
        if (selfLower && organizerEmail.toLowerCase() === selfLower) organizer.self = true;
        normalized.organizer = organizer;
    }
    if (joinUrl) {
        // hangoutLink is what the meeting detector and prep skill look for;
        // conferenceData carries the same link in the richer shape Google uses.
        normalized.hangoutLink = joinUrl;
        normalized.conferenceData = {
            entryPoints: [{ entryPointType: 'video', uri: joinUrl }],
            conferenceSolution: { name: 'Microsoft Teams' },
        };
    }
    if (event.webLink) normalized.htmlLink = event.webLink;
    // Lets invite parsing recognise a meeting Graph already covers, and stand
    // down rather than writing a second, staler copy of it.
    if (event.iCalUId) normalized.iCalUID = event.iCalUId;
    if (event.lastModifiedDateTime) normalized.updated = event.lastModifiedDateTime;
    if (event.seriesMasterId) normalized.recurringEventId = outlookEventId(accountId, event.seriesMasterId);

    return normalized;
}

function saveEvent(normalized: Record<string, unknown>): boolean {
    const filePath = path.join(CALENDAR_SYNC_DIR, `${normalized.id as string}.json`);
    const content = JSON.stringify(normalized, null, 2);
    if (fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf-8') === content) {
        return false;
    }
    fs.writeFileSync(filePath, content);
    return true;
}

/**
 * Remove Outlook events that left the window, touching nothing else.
 *
 * Scoped to files this provider owns. Sweeping by "not in my current set"
 * without that scope is what would delete the Google half of the directory.
 */
export function cleanUpOutlookEvents(currentIds: Set<string>): string[] {
    if (!fs.existsSync(CALENDAR_SYNC_DIR)) return [];
    const deleted: string[] = [];
    for (const filename of fs.readdirSync(CALENDAR_SYNC_DIR)) {
        if (isReservedCalendarFile(filename)) continue;
        if (!isOutlookCalendarFile(filename)) continue;
        if (!filename.endsWith('.json')) continue;
        if (currentIds.has(filename.slice(0, -'.json'.length))) continue;
        try {
            fs.unlinkSync(path.join(CALENDAR_SYNC_DIR, filename));
            deleted.push(filename);
        } catch (err) {
            log.log(`Could not remove ${filename}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    return deleted;
}

const SELECT = [
    'id', 'subject', 'bodyPreview', 'body', 'start', 'end', 'isAllDay',
    'isCancelled', 'location', 'attendees', 'organizer', 'onlineMeeting',
    'webLink', 'iCalUId', 'lastModifiedDateTime', 'seriesMasterId', 'showAs',
].join(',');

/** Ask Graph for UTC so `toIsoUtc` is appending a truthful `Z`. */
const PREFER_UTC = 'outlook.timezone="UTC"';

async function accountEmail(accountId: string): Promise<string | undefined> {
    try {
        const repo = container.resolve<IOAuthRepo>('oauthRepo');
        const account = await repo.readAccount('microsoft', accountId);
        return account.email ?? undefined;
    } catch {
        // Only costs the `self` flag on attendees.
        return undefined;
    }
}

async function syncAccount(accountId: string): Promise<{ changed: number; ids: Set<string> }> {
    const now = Date.now();
    const startWindow = new Date(now - LOOKBACK_DAYS * 86_400_000).toISOString();
    const endWindow = new Date(now + LOOKAHEAD_DAYS * 86_400_000).toISOString();

    const selfEmail = await accountEmail(accountId);
    let url = `/me/calendarView?startDateTime=${startWindow}&endDateTime=${endWindow}`
        + `&$select=${SELECT}&$orderby=start/dateTime&$top=100`;

    const events: GraphEvent[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
        const res = await graphRequest<EventPage>({
            url,
            accountId,
            headers: { Prefer: PREFER_UTC },
        });
        events.push(...(res.value ?? []));
        const next = res['@odata.nextLink'];
        if (!next) break;
        url = next;
    }

    let changed = 0;
    const currentIds = new Set<string>();
    for (const event of events) {
        const normalized = toGoogleEvent(event, accountId, selfEmail);
        if (!normalized) continue;
        currentIds.add(normalized.id as string);
        if (saveEvent(normalized)) changed++;
    }

    return { changed, ids: currentIds };
}

let wakeResolve: (() => void) | null = null;

export function triggerSync(): void {
    if (wakeResolve) {
        wakeResolve();
        wakeResolve = null;
    }
}

export async function performSync(): Promise<void> {
    const accountIds = await GraphClientFactory.listAccountIds();
    if (accountIds.length === 0) return;

    fs.mkdirSync(CALENDAR_SYNC_DIR, { recursive: true });

    // Accumulated across accounts, then swept once: cleaning per account
    // would delete the other accounts' events on every pass.
    const seen = new Set<string>();
    let changed = 0;
    let failures = 0;

    for (const accountId of accountIds) {
        try {
            const result = await syncAccount(accountId);
            changed += result.changed;
            for (const id of result.ids) seen.add(id);
        } catch (err) {
            // One expired grant must not blank out the other mailboxes'
            // events, so a failure here suppresses the sweep entirely.
            failures++;
            log.log(`Sync failed for ${accountId}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    if (failures === 0) {
        const deleted = cleanUpOutlookEvents(seen);
        if (deleted.length > 0) log.log(`Removed ${deleted.length} out-of-window event(s)`);
    }
    if (changed > 0) log.log(`${changed} event(s) added or updated`);
}

export function init(): void {
    void (async () => {
        for (;;) {
            try {
                await performSync();
            } catch (err) {
                log.log(`Loop error: ${err instanceof Error ? err.message : String(err)}`);
            }
            await new Promise<void>((resolve) => {
                wakeResolve = resolve;
                setTimeout(resolve, SYNC_INTERVAL_MS).unref?.();
            });
        }
    })();
}
