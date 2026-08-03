import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Invitations are the only calendar an IMAP account has, so this parser is
 * the whole feature rather than a convenience on top of an API. The cases
 * that matter are the ones that corrupt state quietly: a stale revision
 * overwriting a newer one, and a second copy of a meeting the calendar API
 * already owns.
 */

const TIMEOUT = 30_000;
let tmpDir: string;
let syncDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dhow-invite-"));
  process.env.DHOW_WORKDIR = tmpDir;
  syncDir = path.join(tmpDir, "calendar_sync");
  fsSync.mkdirSync(syncDir, { recursive: true });
  vi.resetModules();
  // sync_calendar and sync_outlook_calendar pull in version history, which
  // would git-init the temp vault and race this file's own teardown.
  vi.doMock("./version_history.js", () => ({
    commitAll: vi.fn(async () => undefined),
    initRepo: vi.fn(async () => undefined),
  }));
  // Under resetModules this module's top-level constants land in a temporal
  // dead zone via a cycle in its import graph — a harness artefact, not a
  // product fault, and stubbed the same way elsewhere in this suite.
  vi.doMock("./deprecate_today_note.js", () => ({
    deprecateTodayNote: vi.fn(async () => undefined),
  }));
});

afterEach(async () => {
  delete process.env.DHOW_WORKDIR;
  vi.resetModules();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const ics = (lines: string[], method = "REQUEST") => [
  "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//EN", `METHOD:${method}`,
  "BEGIN:VEVENT", "UID:meeting-1@dhow.io", "DTSTAMP:20260802T100000Z",
  ...lines,
  "END:VEVENT", "END:VCALENDAR",
].join("\r\n");

const basic = (over: string[] = [], method = "REQUEST") => ics([
  "DTSTART:20260806T143000Z", "DTEND:20260806T153000Z",
  "SUMMARY:Quarterly planning", "SEQUENCE:0", ...over,
], method);

describe("parsing invitations", { timeout: TIMEOUT }, () => {
  it("reads the core fields of a request", async () => {
    const { parseInvite } = await import("./calendar_invites.js");
    const invite = parseInvite(basic([
      "LOCATION:Nairobi",
      "DESCRIPTION:Bring numbers",
      "ORGANIZER;CN=Ada:mailto:ada@example.com",
    ]))!;

    expect(invite.uid).toBe("meeting-1@dhow.io");
    expect(invite.method).toBe("REQUEST");
    expect(invite.event.summary).toBe("Quarterly planning");
    expect(invite.event.location).toBe("Nairobi");
    expect((invite.event.organizer as Record<string, unknown>).email).toBe("ada@example.com");
    expect((invite.event.start as { dateTime: string }).dateTime).toBe("2026-08-06T14:30:00.000Z");
  });

  it("resolves a TZID against the invitation's own VTIMEZONE", async () => {
    const { parseInvite } = await import("./calendar_invites.js");
    // 09:00 New York in August is EDT, UTC-4 -> 13:00Z. A parser that ignored
    // the zone would store 09:00Z and every downstream time would be wrong.
    const withTz = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "METHOD:REQUEST",
      "BEGIN:VTIMEZONE", "TZID:America/New_York",
      "BEGIN:DAYLIGHT", "TZOFFSETFROM:-0500", "TZOFFSETTO:-0400",
      "DTSTART:20070311T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU", "TZNAME:EDT", "END:DAYLIGHT",
      "BEGIN:STANDARD", "TZOFFSETFROM:-0400", "TZOFFSETTO:-0500",
      "DTSTART:20071104T020000", "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU", "TZNAME:EST", "END:STANDARD",
      "END:VTIMEZONE",
      "BEGIN:VEVENT", "UID:tz-1@dhow.io", "DTSTAMP:20260802T100000Z",
      "DTSTART;TZID=America/New_York:20260806T090000",
      "DTEND;TZID=America/New_York:20260806T100000",
      "SUMMARY:Standup", "END:VEVENT", "END:VCALENDAR",
    ].join("\r\n");

    const invite = parseInvite(withTz)!;
    expect((invite.event.start as { dateTime: string }).dateTime).toBe("2026-08-06T13:00:00.000Z");
  });

  it("keeps an all-day invite as a date", async () => {
    const { parseInvite } = await import("./calendar_invites.js");
    const invite = parseInvite(ics([
      "DTSTART;VALUE=DATE:20260806", "DTEND;VALUE=DATE:20260807", "SUMMARY:Company holiday",
    ]))!;

    expect(invite.event.start).toEqual({ date: "2026-08-06" });
  });

  it("preserves a declined response and flags the recipient", async () => {
    const { parseInvite } = await import("./calendar_invites.js");
    const invite = parseInvite(basic([
      "ATTENDEE;CN=Saj;PARTSTAT=DECLINED:mailto:contact@dhow.io",
      "ATTENDEE;PARTSTAT=ACCEPTED:mailto:ada@example.com",
    ]), ["contact@dhow.io"])!;

    const attendees = invite.event.attendees as Array<Record<string, unknown>>;
    const self = attendees.find((a) => a.self)!;
    // The mic detector skips declined events; losing this records a refused meeting.
    expect(self.email).toBe("contact@dhow.io");
    expect(self.responseStatus).toBe("declined");
    expect(attendees.find((a) => a.email === "ada@example.com")!.self).toBeUndefined();
  });

  it("marks a cancellation cancelled", async () => {
    const { parseInvite } = await import("./calendar_invites.js");
    expect(parseInvite(basic([], "CANCEL"))!.event.status).toBe("cancelled");
    expect(parseInvite(basic())!.event.status).toBe("confirmed");
  });

  it("finds a video link buried in the location or body", async () => {
    const { parseInvite } = await import("./calendar_invites.js");
    const zoom = parseInvite(basic(["LOCATION:https://us02web.zoom.us/j/123456789"]))!;
    expect(zoom.event.hangoutLink).toBe("https://us02web.zoom.us/j/123456789");

    const meet = parseInvite(basic(["DESCRIPTION:Join at https://meet.google.com/abc-defg-hij then dial in"]))!;
    expect(meet.event.hangoutLink).toBe("https://meet.google.com/abc-defg-hij");
  });

  it("returns null for junk instead of throwing", async () => {
    const { parseInvite } = await import("./calendar_invites.js");
    // A malformed part must never abort the mail sync around it.
    expect(parseInvite("not a calendar at all")).toBeNull();
    expect(parseInvite("BEGIN:VCALENDAR\r\nEND:VCALENDAR")).toBeNull();
    expect(parseInvite(ics(["SUMMARY:No start time"]))).toBeNull();
  });

  it("records the recurrence rule rather than guessing occurrences", async () => {
    const { parseInvite } = await import("./calendar_invites.js");
    const invite = parseInvite(basic(["RRULE:FREQ=WEEKLY;BYDAY=MO"]))!;
    expect((invite.event.recurrence as string[])[0]).toContain("FREQ=WEEKLY");
  });
});

describe("storing invitations", { timeout: TIMEOUT }, () => {
  it("writes a new invitation once and recognises a repeat", async () => {
    const { parseInvite, storeInvite } = await import("./calendar_invites.js");
    const invite = parseInvite(basic())!;

    expect(storeInvite(invite)).toBe("written");
    expect(storeInvite(invite)).toBe("unchanged");
    expect(fsSync.readdirSync(syncDir).filter((f) => f.startsWith("ics-"))).toHaveLength(1);
  });

  it("applies a newer revision and refuses an older one", async () => {
    const { parseInvite, storeInvite } = await import("./calendar_invites.js");
    const v0 = parseInvite(basic(["SUMMARY:Original time"]))!;
    const v1 = parseInvite(ics([
      "DTSTART:20260807T143000Z", "DTEND:20260807T153000Z", "SUMMARY:Moved a day", "SEQUENCE:1",
    ]))!;

    storeInvite(v0);
    expect(storeInvite(v1)).toBe("written");
    // Mail arrives out of order; replaying v0 must not restore the old time.
    expect(storeInvite(v0)).toBe("stale");

    const stored = JSON.parse(fsSync.readFileSync(path.join(syncDir, `${v1.event.id}.json`), "utf-8"));
    expect(stored.summary).toBe("Moved a day");
  });

  it("stands down when a calendar API already owns the meeting", async () => {
    const { parseInvite, storeInvite } = await import("./calendar_invites.js");
    // As Outlook writes it, carrying the same iCalendar UID.
    fsSync.writeFileSync(
      path.join(syncDir, "ms-acct-graphid.json"),
      JSON.stringify({ id: "ms-acct-graphid", iCalUID: "meeting-1@dhow.io", summary: "From Graph" }),
    );

    expect(storeInvite(parseInvite(basic())!)).toBe("superseded");
    expect(fsSync.readdirSync(syncDir).filter((f) => f.startsWith("ics-"))).toHaveLength(0);
  });

  it("still writes when the existing event is a different meeting", async () => {
    const { parseInvite, storeInvite } = await import("./calendar_invites.js");
    fsSync.writeFileSync(
      path.join(syncDir, "ms-acct-other.json"),
      JSON.stringify({ iCalUID: "some-other-meeting@example.com" }),
    );

    expect(storeInvite(parseInvite(basic())!)).toBe("written");
  });
});

describe("ingesting message parts", { timeout: TIMEOUT }, () => {
  it("selects calendar parts by type or extension", async () => {
    const { calendarParts } = await import("./calendar_invites.js");
    const picked = calendarParts([
      { contentType: "text/calendar; method=REQUEST", content: Buffer.from("x") },
      { contentType: "application/octet-stream", filename: "invite.ics", content: Buffer.from("x") },
      { contentType: "application/pdf", filename: "agenda.pdf", content: Buffer.from("x") },
      { contentType: "text/calendar", filename: "empty.ics" },
    ]);

    expect(picked).toHaveLength(2);
  });

  it("drops replies rather than inventing an event from one RSVP", async () => {
    const { ingestCalendarParts } = await import("./calendar_invites.js");
    const result = ingestCalendarParts([{ content: basic([], "REPLY") }]);

    // A REPLY describes one attendee's answer, not the meeting.
    expect(result.written).toBe(0);
    expect(fsSync.readdirSync(syncDir).filter((f) => f.startsWith("ics-"))).toHaveLength(0);
  });

  it("keeps going after a malformed part", async () => {
    const { ingestCalendarParts } = await import("./calendar_invites.js");
    const result = ingestCalendarParts([
      { content: "garbage" },
      { content: basic() },
    ]);

    expect(result.written).toBe(1);
    expect(result.skipped).toBe(1);
  });
});

describe("directory ownership", { timeout: TIMEOUT }, () => {
  it("google's sweep leaves invitation events alone", async () => {
    const { cleanUpOldFiles } = await import("./sync_calendar.js");
    fsSync.writeFileSync(path.join(syncDir, "ics-meeting1dhowio.json"), "{}");
    fsSync.writeFileSync(path.join(syncDir, "googleStale.json"), "{}");

    cleanUpOldFiles(new Set<string>(), syncDir);

    expect(fsSync.existsSync(path.join(syncDir, "ics-meeting1dhowio.json"))).toBe(true);
    expect(fsSync.existsSync(path.join(syncDir, "googleStale.json"))).toBe(false);
  });

  it("outlook's sweep leaves invitation events alone", async () => {
    const { cleanUpOutlookEvents } = await import("./sync_outlook_calendar.js");
    fsSync.writeFileSync(path.join(syncDir, "ics-meeting1dhowio.json"), "{}");

    cleanUpOutlookEvents(new Set<string>());

    expect(fsSync.existsSync(path.join(syncDir, "ics-meeting1dhowio.json"))).toBe(true);
  });
});
