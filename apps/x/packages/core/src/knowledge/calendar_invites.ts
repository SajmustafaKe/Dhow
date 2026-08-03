import fs from 'fs';
import path from 'path';
import ICAL from 'ical.js';
import { PrefixLogger } from '@x/shared';
import {
    CALENDAR_SYNC_DIR,
    inviteEventId,
    isInviteCalendarFile,
    isReservedCalendarFile,
} from './calendar_files.js';

const log = new PrefixLogger('Invites');

/**
 * Calendar events recovered from `text/calendar` parts in email.
 *
 * An IMAP account has no calendar API — there is nothing to query. But the
 * invitation itself is a complete record of the meeting, in a structured
 * format, and it is already arriving in the mailbox we sync. Reading it costs
 * no new protocol, no new credential, and no configuration.
 *
 * The output is the same Google Calendar shape everything else writes, so the
 * sixteen consumers stay provider-blind.
 *
 * What this cannot see: meetings created directly in a web calendar that were
 * never mailed to anyone. That gap is what CalDAV would close, at the cost of
 * a second set of credentials per account.
 */

/** RFC 5546 methods we act on. Anything else is informational. */
export type InviteMethod = 'REQUEST' | 'CANCEL' | 'REPLY' | 'PUBLISH' | 'COUNTER' | 'REFRESH' | 'ADD' | 'DECLINECOUNTER';

export interface ParsedInvite {
    /** The iCalendar UID — stable across updates, and the dedupe key. */
    uid: string;
    method: InviteMethod;
    /** Bumped by the organizer on each revision; older arrivals are stale. */
    sequence: number;
    event: Record<string, unknown>;
}

const PARTSTAT_TO_GOOGLE: Record<string, string> = {
    'NEEDS-ACTION': 'needsAction',
    ACCEPTED: 'accepted',
    DECLINED: 'declined',
    TENTATIVE: 'tentative',
    DELEGATED: 'needsAction',
};

function mailtoAddress(value: string | null | undefined): string | undefined {
    if (!value) return undefined;
    return value.replace(/^mailto:/i, '').trim() || undefined;
}

/**
 * An ICAL.Time as the Google shape.
 *
 * ical.js resolves TZID against the VTIMEZONE carried in the same file, so a
 * floating local time becomes a real instant. Hand-rolled parsers get this
 * wrong, which is the main reason this module has a dependency at all.
 */
function toGoogleTime(time: ICAL.Time | null): Record<string, string> | undefined {
    if (!time) return undefined;
    if (time.isDate) return { date: time.toString().slice(0, 10) };
    return {
        dateTime: time.toJSDate().toISOString(),
        timeZone: time.zone?.tzid || 'UTC',
    };
}

/** The first video link in the event, wherever the organizer hid it. */
function findConferenceLink(event: ICAL.Event, raw: ICAL.Component): string | undefined {
    const explicit = raw.getFirstPropertyValue('x-google-conference');
    if (typeof explicit === 'string' && explicit.startsWith('http')) return explicit;

    const haystack = [event.location, event.description].filter(Boolean).join('\n');
    const match = haystack.match(
        /https:\/\/(?:[\w-]+\.)?(?:zoom\.us|teams\.microsoft\.com|meet\.google\.com|whereby\.com|webex\.com)\/\S+/i,
    );
    return match?.[0]?.replace(/[)>,.]+$/, '');
}

/**
 * One VEVENT as a Google Calendar event.
 *
 * `selfEmails` are the addresses of the mailbox that received this invite, so
 * the user's own attendee row can be flagged — the mic detector reads it to
 * skip meetings that were declined.
 */
export function parseInvite(icsText: string, selfEmails: string[] = []): ParsedInvite | null {
    let comp: ICAL.Component;
    try {
        comp = new ICAL.Component(ICAL.parse(icsText));
    } catch (err) {
        // Malformed calendar parts are common enough in real mail that this
        // must never abort the surrounding mail sync.
        log.log(`Unparseable calendar part: ${err instanceof Error ? err.message : String(err)}`);
        return null;
    }

    const vevent = comp.getFirstSubcomponent('vevent');
    if (!vevent) return null;

    const event = new ICAL.Event(vevent);
    const uid = event.uid;
    if (!uid) return null;

    const start = toGoogleTime(event.startDate);
    // No start means nothing downstream can place it; every consumer sorts by it.
    if (!start) return null;

    const methodRaw = comp.getFirstPropertyValue('method');
    const method = (typeof methodRaw === 'string' ? methodRaw.toUpperCase() : 'PUBLISH') as InviteMethod;
    const sequenceRaw = vevent.getFirstPropertyValue('sequence');
    const sequence = typeof sequenceRaw === 'number' ? sequenceRaw : Number(sequenceRaw ?? 0) || 0;

    const selfLower = new Set(selfEmails.map((e) => e.toLowerCase()));
    const attendees = vevent.getAllProperties('attendee').map((prop) => {
        const email = mailtoAddress(prop.getFirstValue() as string);
        const entry: Record<string, unknown> = {
            email: email ?? '',
            responseStatus: PARTSTAT_TO_GOOGLE[String(prop.getParameter('partstat') ?? '').toUpperCase()] ?? 'needsAction',
        };
        const cn = prop.getParameter('cn');
        if (typeof cn === 'string') entry.displayName = cn;
        if (String(prop.getParameter('role') ?? '').toUpperCase() === 'OPT-PARTICIPANT') entry.optional = true;
        if (email && selfLower.has(email.toLowerCase())) entry.self = true;
        return entry;
    }).filter((a) => a.email);

    const organizerProp = vevent.getFirstProperty('organizer');
    const organizerEmail = mailtoAddress(organizerProp?.getFirstValue() as string | undefined);

    const cancelled = method === 'CANCEL' || String(vevent.getFirstPropertyValue('status') ?? '').toUpperCase() === 'CANCELLED';

    const normalized: Record<string, unknown> = {
        id: inviteEventId(uid),
        iCalUID: uid,
        summary: event.summary || '(no title)',
        start,
        end: toGoogleTime(event.endDate) ?? start,
        status: cancelled ? 'cancelled' : 'confirmed',
        sequence,
        source: { provider: 'invite', method },
    };

    if (event.description) normalized.description = event.description;
    if (event.location) normalized.location = event.location;
    if (attendees.length > 0) normalized.attendees = attendees;
    if (organizerEmail) {
        const organizer: Record<string, unknown> = { email: organizerEmail };
        const cn = organizerProp?.getParameter('cn');
        if (typeof cn === 'string') organizer.displayName = cn;
        if (selfLower.has(organizerEmail.toLowerCase())) organizer.self = true;
        normalized.organizer = organizer;
    }

    const link = findConferenceLink(event, vevent);
    if (link) {
        normalized.hangoutLink = link;
        normalized.conferenceData = { entryPoints: [{ entryPointType: 'video', uri: link }] };
    }

    // A recurring invite is stored as its master. Occurrences are not expanded
    // here: consumers would need every instance, and getting recurrence right
    // (EXDATE, RECURRENCE-ID overrides, DST) is a larger job than this module.
    // Stated rather than half-done — a wrong occurrence is worse than none.
    if (event.isRecurring()) {
        normalized.recurrence = vevent.getAllProperties('rrule').map((p) => `RRULE:${p.getFirstValue()?.toString()}`);
    }

    return { uid, method, sequence, event: normalized };
}

/**
 * Does a calendar API already describe this meeting?
 *
 * Google and Graph both expose the iCalendar UID, so the same meeting is
 * recognisable across sources. The API copy wins: it keeps up with later
 * edits, whereas an invitation is a snapshot of the moment it was sent.
 */
export function findExistingByUid(uid: string): string | null {
    if (!fs.existsSync(CALENDAR_SYNC_DIR)) return null;
    for (const filename of fs.readdirSync(CALENDAR_SYNC_DIR)) {
        if (isReservedCalendarFile(filename) || !filename.endsWith('.json')) continue;
        if (isInviteCalendarFile(filename)) continue;
        try {
            const parsed = JSON.parse(fs.readFileSync(path.join(CALENDAR_SYNC_DIR, filename), 'utf-8'));
            if (parsed?.iCalUID === uid) return filename;
        } catch {
            // A partially written file is not a match.
        }
    }
    return null;
}

/**
 * Persist an invitation, unless something better already covers it.
 *
 * Returns what happened so the caller can log honestly rather than claim a
 * write that never occurred.
 */
export function storeInvite(invite: ParsedInvite): 'written' | 'unchanged' | 'superseded' | 'stale' {
    fs.mkdirSync(CALENDAR_SYNC_DIR, { recursive: true });

    if (findExistingByUid(invite.uid)) return 'superseded';

    const filePath = path.join(CALENDAR_SYNC_DIR, `${invite.event.id as string}.json`);
    if (fs.existsSync(filePath)) {
        try {
            const existing = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            const existingSeq = typeof existing?.sequence === 'number' ? existing.sequence : -1;
            // Mail arrives out of order. An older revision overwriting a newer
            // one would silently restore a time the organizer already changed.
            if (existingSeq > invite.sequence) return 'stale';
            if (JSON.stringify(existing) === JSON.stringify(invite.event)) return 'unchanged';
        } catch {
            // Unreadable: treat as absent and rewrite.
        }
    }

    fs.writeFileSync(filePath, JSON.stringify(invite.event, null, 2));
    return 'written';
}

/**
 * Handle every calendar part on one message.
 *
 * A REPLY carries someone else's RSVP to a meeting we may not hold, and
 * applying it would fabricate an event from a single attendee's viewpoint —
 * so replies are counted and dropped.
 */
export function ingestCalendarParts(
    parts: { content: Buffer | string }[],
    selfEmails: string[] = [],
): { written: number; skipped: number } {
    let written = 0;
    let skipped = 0;

    for (const part of parts) {
        const text = typeof part.content === 'string' ? part.content : part.content.toString('utf-8');
        const invite = parseInvite(text, selfEmails);
        if (!invite) { skipped++; continue; }
        if (invite.method === 'REPLY' || invite.method === 'COUNTER' || invite.method === 'REFRESH') {
            skipped++;
            continue;
        }
        if (storeInvite(invite) === 'written') written++;
        else skipped++;
    }

    return { written, skipped };
}

/** `text/calendar` parts, whatever the sender called the file. */
export function calendarParts<T extends { contentType?: string; filename?: string; content?: Buffer | string }>(
    attachments: T[] | undefined,
): T[] {
    return (attachments ?? []).filter((a) => {
        if (!a.content) return false;
        const ct = (a.contentType ?? '').toLowerCase();
        if (ct.startsWith('text/calendar') || ct === 'application/ics') return true;
        return (a.filename ?? '').toLowerCase().endsWith('.ics');
    });
}
