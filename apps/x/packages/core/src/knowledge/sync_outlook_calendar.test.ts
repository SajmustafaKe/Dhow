import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Outlook events are stored in the Google Calendar shape, in the directory
 * the Google sync already owns. Two things therefore have to hold:
 *
 *  1. Normalisation is faithful — every field a consumer reads survives the
 *     translation, especially the ones that drive behaviour (a declined
 *     invite must stay declined, or the mic detector records a meeting the
 *     user refused).
 *  2. Neither sync deletes the other's files. Both sweep "events no longer in
 *     my window", and without an ownership rule they would delete each
 *     other's work on alternating passes, forever.
 */

const TIMEOUT = 30_000;
let tmpDir: string;
let syncDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dhow-outlook-cal-"));
  process.env.DHOW_WORKDIR = tmpDir;
  syncDir = path.join(tmpDir, "calendar_sync");
  fsSync.mkdirSync(syncDir, { recursive: true });
  vi.resetModules();
  vi.doMock("../knowledge/version_history.js", () => ({
    commitAll: vi.fn(async () => undefined),
    initRepo: vi.fn(async () => undefined),
  }));
});

afterEach(async () => {
  delete process.env.DHOW_WORKDIR;
  vi.resetModules();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** A Graph event as calendarView actually returns one, offsetless and all. */
const graphEvent = (over: Record<string, unknown> = {}) => ({
  id: "AAMkAGI2THVSAAA=",
  subject: "Design review",
  start: { dateTime: "2026-08-05T09:00:00.0000000", timeZone: "UTC" },
  end: { dateTime: "2026-08-05T10:00:00.0000000", timeZone: "UTC" },
  isAllDay: false,
  isCancelled: false,
  organizer: { emailAddress: { name: "Ada", address: "ada@example.com" } },
  ...over,
});

describe("normalising Graph events", { timeout: TIMEOUT }, () => {
  it("pins offsetless Graph times to UTC so Date() cannot read them as local", async () => {
    const { toGoogleEvent } = await import("./sync_outlook_calendar.js");
    const ev = toGoogleEvent(graphEvent(), "acct")!;

    const start = ev.start as { dateTime: string };
    expect(start.dateTime).toBe("2026-08-05T09:00:00.000Z");
    // The whole point: an unanchored string would shift by the host offset.
    expect(new Date(start.dateTime).getUTCHours()).toBe(9);
  });

  it("writes an all-day event as a date, matching Google's shape", async () => {
    const { toGoogleEvent } = await import("./sync_outlook_calendar.js");
    const ev = toGoogleEvent(graphEvent({
      isAllDay: true,
      start: { dateTime: "2026-08-05T00:00:00.0000000", timeZone: "UTC" },
      end: { dateTime: "2026-08-06T00:00:00.0000000", timeZone: "UTC" },
    }), "acct")!;

    expect(ev.start).toEqual({ date: "2026-08-05" });
    expect(ev.end).toEqual({ date: "2026-08-06" });
  });

  it("keeps a declined response declined", async () => {
    const { toGoogleEvent } = await import("./sync_outlook_calendar.js");
    const ev = toGoogleEvent(graphEvent({
      attendees: [{
        emailAddress: { address: "me@example.com" },
        status: { response: "declined" },
      }],
    }), "acct", "me@example.com")!;

    const attendees = ev.attendees as Array<Record<string, unknown>>;
    // The mic detector skips events where the self attendee declined; losing
    // either half of this would start recording refused meetings.
    expect(attendees[0].responseStatus).toBe("declined");
    expect(attendees[0].self).toBe(true);
  });

  it("maps every Graph response value onto a Google one", async () => {
    const { toGoogleEvent } = await import("./sync_outlook_calendar.js");
    const responses = ["none", "notResponded", "organizer", "accepted", "tentativelyAccepted", "declined"];
    const got = responses.map((response) => {
      const ev = toGoogleEvent(graphEvent({
        attendees: [{ emailAddress: { address: "a@b.c" }, status: { response } }],
      }), "acct")!;
      return (ev.attendees as Array<Record<string, unknown>>)[0].responseStatus;
    });

    expect(got).toEqual([
      "needsAction", "needsAction", "accepted", "accepted", "tentative", "declined",
    ]);
  });

  it("falls back to needsAction for a response Graph invents later", async () => {
    const { toGoogleEvent } = await import("./sync_outlook_calendar.js");
    const ev = toGoogleEvent(graphEvent({
      attendees: [{ emailAddress: { address: "a@b.c" }, status: { response: "somethingNew" } }],
    }), "acct")!;

    expect((ev.attendees as Array<Record<string, unknown>>)[0].responseStatus).toBe("needsAction");
  });

  it("exposes a Teams link where consumers look for a video call", async () => {
    const { toGoogleEvent } = await import("./sync_outlook_calendar.js");
    const join = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc";
    const ev = toGoogleEvent(graphEvent({ onlineMeeting: { joinUrl: join } }), "acct")!;

    expect(ev.hangoutLink).toBe(join);
    const conf = ev.conferenceData as { entryPoints: Array<{ uri: string }> };
    expect(conf.entryPoints[0].uri).toBe(join);
  });

  it("converts an HTML body to readable text", async () => {
    const { toGoogleEvent } = await import("./sync_outlook_calendar.js");
    const ev = toGoogleEvent(graphEvent({
      body: { contentType: "html", content: "<p>Agenda:</p><ul><li>Roadmap</li></ul>" },
    }), "acct")!;

    expect(ev.description).toContain("Agenda:");
    expect(ev.description).toContain("Roadmap");
    expect(ev.description).not.toContain("<li>");
  });

  it("marks a cancelled event cancelled", async () => {
    const { toGoogleEvent } = await import("./sync_outlook_calendar.js");
    expect(toGoogleEvent(graphEvent({ isCancelled: true }), "acct")!.status).toBe("cancelled");
    expect(toGoogleEvent(graphEvent(), "acct")!.status).toBe("confirmed");
  });

  it("drops an event with no start rather than storing a NaN date", async () => {
    const { toGoogleEvent } = await import("./sync_outlook_calendar.js");
    expect(toGoogleEvent(graphEvent({ start: undefined }), "acct")).toBeNull();
    expect(toGoogleEvent(graphEvent({ id: undefined }), "acct")).toBeNull();
  });

  it("namespaces ids per account so two mailboxes cannot collide", async () => {
    const { toGoogleEvent } = await import("./sync_outlook_calendar.js");
    const a = toGoogleEvent(graphEvent(), "accountOne")!.id as string;
    const b = toGoogleEvent(graphEvent(), "accountTwo")!.id as string;

    expect(a).not.toBe(b);
    expect(a.startsWith("ms-")).toBe(true);
    // Filename-safe: this string becomes a path.
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("records where the event came from", async () => {
    const { toGoogleEvent } = await import("./sync_outlook_calendar.js");
    const ev = toGoogleEvent(graphEvent(), "acct")!;
    expect(ev.source).toEqual({ provider: "microsoft", accountId: "acct", graphId: "AAMkAGI2THVSAAA=" });
  });
});

describe("shared directory ownership", { timeout: TIMEOUT }, () => {
  const write = (name: string) => fsSync.writeFileSync(path.join(syncDir, name), "{}");

  it("google's sweep leaves outlook events alone", async () => {
    const { cleanUpOldFiles } = await import("./sync_calendar.js");
    write("googleEventStale.json");
    write("ms-acct-outlookEvent.json");

    // Google's window contains neither file.
    cleanUpOldFiles(new Set<string>(), syncDir);

    expect(fsSync.existsSync(path.join(syncDir, "googleEventStale.json"))).toBe(false);
    expect(fsSync.existsSync(path.join(syncDir, "ms-acct-outlookEvent.json"))).toBe(true);
  });

  it("outlook's sweep leaves google events alone", async () => {
    const { cleanUpOutlookEvents } = await import("./sync_outlook_calendar.js");
    write("googleEvent.json");
    write("ms-acct-stale.json");

    cleanUpOutlookEvents(new Set<string>());

    expect(fsSync.existsSync(path.join(syncDir, "googleEvent.json"))).toBe(true);
    expect(fsSync.existsSync(path.join(syncDir, "ms-acct-stale.json"))).toBe(false);
  });

  it("outlook keeps events still inside its window", async () => {
    const { cleanUpOutlookEvents } = await import("./sync_outlook_calendar.js");
    write("ms-acct-keep.json");
    write("ms-acct-drop.json");

    const deleted = cleanUpOutlookEvents(new Set(["ms-acct-keep"]));

    expect(deleted).toEqual(["ms-acct-drop.json"]);
    expect(fsSync.existsSync(path.join(syncDir, "ms-acct-keep.json"))).toBe(true);
  });

  it("neither sweep touches shared state files", async () => {
    const { cleanUpOutlookEvents } = await import("./sync_outlook_calendar.js");
    const { cleanUpOldFiles } = await import("./sync_calendar.js");
    write("sync_state.json");
    write("composio_state.json");

    cleanUpOutlookEvents(new Set<string>());
    cleanUpOldFiles(new Set<string>(), syncDir);

    expect(fsSync.existsSync(path.join(syncDir, "sync_state.json"))).toBe(true);
    expect(fsSync.existsSync(path.join(syncDir, "composio_state.json"))).toBe(true);
  });
});
