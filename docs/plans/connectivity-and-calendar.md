<!-- /autoplan restore point: /Users/mac/.gstack/projects/SajmustafaKe-Dhow/main-autoplan-restore-20260803-171719.md -->
# Plan: Account connectivity and calendar completeness

Status: draft, awaiting review
Owner: Saj
Branch: main
Written: 2026-08-02

## Problem

Dhow cannot connect an account without the user first becoming an OAuth
administrator. Google and Microsoft are bring-your-own-credentials: the user
creates a cloud project, enables APIs, configures a consent screen, adds
themselves as a test user, and pastes a client ID. `google-setup.md` is seven
numbered steps long and it is the *happy* path.

That friction is the largest barrier to anyone but the author using this app.

Evidence, restated after review: of four bugs this week, exactly one
(`0cf871e`, the Microsoft client-ID prompt) is BYOK-caused. Two are Composio
credential-paste (`0e77fb3`, `bcee8ca`) and one is sync scheduling (`a93e99f`)
that a shipped client ID would not have prevented. The barrier claim rests on
`google-setup.md` alone, which is sufficient. The two Composio bugs point
somewhere more useful — see item 0b.

Calendar coverage is uneven for the same reason. Google grants calendar in the
same consent as mail. Outlook now syncs its calendar. IMAP accounts have
invitation parsing, which sees only meetings someone emailed about.

## Goal

One click for Microsoft. Guided setup for Google until CASA is funded, stated
plainly rather than promised away. Calendar arrives with mail for every
provider, or its absence is stated rather than discovered.

The earlier wording ("no console, no client ID, no app password") was
contradicted by this plan's own Google recommendation. Fixed rather than kept.

## Non-goals

- Two-way calendar writes. Read-only across all providers.
- **Dhow stores no mail on our infrastructure.** Message content is sent to the
  configured model provider at the user's direction. The earlier phrasing — "no
  server sees user mail" — was false, and asserting it in a privacy policy
  would be a bad-faith Limited Use disclosure. This is why item 4 is hard.
- Migrating existing BYOK users. A user-supplied credential keeps overriding a
  shipped one, and item 2a must preserve a way to supply one.

## Current state

Shipped this session. Claims below were re-verified against disk during review;
two did not hold as originally written and are corrected here.

- Provider registry (`providers.ts:66-69`, `:88-90`) supports a shipped
  `clientId`/`clientSecret` per provider, unset by default, falling back to
  BYOK. Env seam at `env.ts:22-24`: `DHOW_GOOGLE_CLIENT_ID`,
  `DHOW_GOOGLE_CLIENT_SECRET`, `DHOW_MICROSOFT_CLIENT_ID`. **But the renderer
  has no channel for "a client ID is shipped" — see item 2a. The seam is
  currently unreachable from the UI.**
- A third provider, `fireflies-ai` (`providers.ts:104-117`), uses dynamic client
  registration and needs no credential at all. Any claim about "every provider"
  excludes it.
- `buildCredentialOverride` (`credentials.ts:11-14`) accepts a client ID with no
  secret — desktop registrations are public clients secured by PKCE.
- Outlook calendar sync (`sync_outlook_calendar.ts`) writing the Google event
  shape into the shared `calendar_sync/` directory.
- Invitation parsing (`calendar_invites.ts`) reading `text/calendar` parts out
  of IMAP mail, with SEQUENCE ordering, iCalUID dedupe, and REPLY/COUNTER/
  REFRESH rejection. **Incomplete as previously stated: only the first VEVENT is
  read (`:100`), and `EXDATE`/`RDATE`/`RECURRENCE-ID` are discarded at parse
  time (`:163-166`).**
- Directory ownership rules (`calendar_files.ts`) so three writers share one
  directory without deleting each other's events. **Ownership without retention
  is half the rule: nothing sweeps `ics-` files, so invite events accumulate
  without bound in a directory sixteen consumers full-scan.**

689 core + 111 renderer tests, 0 type errors — measured at `5f19b02`, stale from
the next commit. No live OAuth call has ever run against a real Microsoft or
Google registration.

## Work

### 0a. Decide the model-provider data flow — HARD BLOCKER

Promoted from a footnote during review. This gates the privacy policy text in
item 3, which gates item 4 entirely, and it decides whether the corrected
non-goal above is true.

Answer, in writing: which model providers ship enabled by default, and do those
have zero-retention and no-training terms for user content? If Dhow defaults to
a local model (Ollama is in the stack) with cloud providers strictly opt-in, the
privacy story is materially simpler and item 4 gets cheaper.

Acceptance: a written statement of the default provider set and its retention
terms, suitable for quoting verbatim in the privacy policy.

### 0b. Pick one Google connect path — HARD BLOCKER for item 4

There are **three** ways to connect Google in the tree today, not one:

| Path | Where | Status |
|---|---|---|
| Native BYOK | `useConnectors.ts:634-636` | live, documented in `google-setup.md` |
| Managed credentials (`mode: 'dhow'`) | `useConnectors.ts:628-632`, `repo.ts:34` | in the schema, branch live, provenance unknown |
| Composio Gmail + Google Calendar | `useConnectors.ts:490`, `:547` | live |

Item 4 cannot be decided against an incomplete option set. Each path has
different CASA exposure — under Composio, Composio is the OAuth client, not
Dhow — and different privacy-policy implications, since Composio's servers would
see mail, which collides with the non-goal above.

`dd9e066` ("remove the hosted RowBoat services") suggests this cleanup was
started and not finished. Two of the three are probably fork residue.

Acceptance: one path named as the product; the other two deleted or explicitly
parked in `TODOS.md` with the reason.

### 1. Verify the Microsoft path end to end — blocked on user

Connect `sajmustafa@hotmail.com` using client ID
`27f5fd00-3555-4ca9-9557-62b36d17f9d2`, secret blank. Confirm mail lands, then
that calendar events land.

Risks, in the order they are likely to fail:
- Redirect URI mismatch (`AADSTS50011`) if the Azure registration lacks
  `http://localhost:8080/oauth/callback` under Mobile and desktop.
- Account type set to organizations-only, which rejects a hotmail.com address.
- `openid-client` discovery against Entra's `common` issuer — a path only
  Google has ever exercised in this codebase.
- Graph ids longer than any tested fixture, used as filenames. Note the
  asymmetry: `inviteEventId` caps at 180 chars, `outlookEventId` caps nothing
  (`calendar_files.ts:71-86`).

Landing in the same window, because both are one-way doors or same-blast-radius:

- **Retain the recurrence envelope at parse time.** `calendar_invites.ts:163-166`
  discards `EXDATE`/`RDATE`/`RECURRENCE-ID` and `:100` reads only the first
  VEVENT. An `.ics` carrying a master plus `RECURRENCE-ID` overrides — the normal
  encoding for "this one occurrence moved" — silently loses everything after the
  first. This is wrong output in shipped code, and it is unrecoverable later
  without a full mail resync. Item 7 becomes a pure read-side change once this
  lands. ~2h.
- **Sweep `ics-` files.** Nothing deletes them today; the directory grows
  forever. One file, no new infra, and a precondition for items 6 and 7 not
  degrading. ~3h.
- **Name the reconnect reasons.** `google-client-factory.ts:177-180` writes raw
  `error.message` into the user-facing account error field. Replace with a small
  set of named causes. ~3h.
- **Delete `clearConfigCache` and `getCachedConfiguration`.** Both key the cache
  `issuer:clientId` while `discoverConfiguration` keys it
  `issuer:clientId:secret|none` (`oauth-client.ts:43` vs `:253`), so the clear is
  a no-op and the getter always misses. Both have zero callers. Dead code with a
  wrong contract in the module item 1 exercises for the first time.
- **Log the Graph page cap.** `MAX_PAGES = 10` at `$top=100` silently truncates
  above 1000 events in a 21-day window. The limit is a sane guard; the silence is
  the bug.
- **Import `CALENDAR_SYNC_DIR` rather than re-declaring it.** Four consumers
  hardcode the path (`meeting_prep_scheduler.ts:16`, `notify_calendar_meetings.ts:17`,
  `summarize_meeting.ts:9`, `detector.ts:49`) and `summarize_meeting.ts:41`
  hardcodes the reserved filenames instead of calling `isReservedCalendarFile`.
  Item 6 adds a fourth prefix these consumers must respect.

Acceptance: mail and calendar both visible for the account; `~/.dhow/oauth.json`
holds a refresh token; a restart resumes sync without re-consent; a recurring
invitation with a moved occurrence round-trips without loss.

### 2a. Make the shipped client ID reachable — the item that carries the Goal

**This was previously sized at zero code and it is the plan's critical defect.**
`handleConnect('microsoft')` opens the BYOK modal unconditionally
(`useConnectors.ts:639-644`), and `repo.ts:316-317` exposes only the *stored*
client ID, never the env one. Setting `DHOW_MICROSOFT_CLIENT_ID` alone changes
nothing a user sees.

Shape: compute the credential source in core (shipped / BYOK / managed), surface
it on `getClientFacingConfig`, and branch on it at both connect call sites —
`useConnectors.ts:622` and `use-onboarding-state.ts:419`. The precedent to mirror
already exists at `useConnectors.ts:628-632`, the `isSignedIntoDhow` branch.

Preserve an override path: the modal is currently the only way to supply a
personal registration, so hiding it must not remove that ability — move it behind
a settings-level "use my own registration".

Rollback requirement: unsetting the env var must degrade to the modal, or users
are stranded with no way to connect.

Acceptance: a clean install connects Outlook with no client ID prompt; unsetting
the env var restores the modal; a user-supplied ID still overrides a shipped one.

### 2b. Entra publisher verification — separable

Requires a Partner Center account and a publisher domain that is not
`*.onmicrosoft.com`, so this depends on item 3. Upgrades the consent screen from
"unverified" to a named publisher.

Split from 2a deliberately: for personal Outlook.com consent, publisher
verification is believed to be a trust badge rather than a gate `[INFERENCE —
Microsoft policy, unverified]`. If that inference is wrong, 2a and 2b merge and
the original plan was right. **Verify before scheduling.**

`Mail.ReadWrite` is blocked from end-user consent under Microsoft's default
policy, so work and school tenants need admin approval regardless — the
population 2b unlocks is separately blocked anyway.

Watch: from 31 Dec 2026, modifying sensitive properties on delivered messages
requires `Mail-Advanced.ReadWrite`. Our scopes are `Mail.ReadWrite` and
`Mail.Send` (`providers.ts:96-98`); confirm by grep over the Graph call sites
rather than carrying it as an open question.

Acceptance: consent screen shows a verified publisher.

### 3. dhow.io foundation — free, unblocks everything Google

Publish on dhow.io: a homepage describing what Dhow does, a privacy policy, and
terms of service. Verify the domain in Google Search Console under the account
that owns the Cloud project.

The privacy policy is the load-bearing artifact. It must disclose how Google
user data is accessed, used, stored and shared, and comply with Limited Use.
Getting it wrong is the most common cause of verification rejection, and it must
state the model-provider data flow truthfully (see item 4).

Acceptance: all three pages live; domain verified; Google brand verification
passes.

### 4. Decide the Gmail path — the only item with recurring cost

Reading message bodies requires `gmail.modify` or `gmail.readonly`. Both are
restricted scopes. `gmail.send` is merely sensitive but loses reading, which is
the product.

Publishing with a restricted scope requires an annual CASA Tier 2 assessment:
$540–$1,000/year self-serve through an approved lab, recertified every 12 months
from the Letter of Assessment date.

The blocker is not the money. CASA applies because restricted data is
transmitted through third-party servers — and Dhow sends message content to
Anthropic, OpenAI, Google or OpenRouter. Before submitting, we need:

- Zero-retention terms with whichever providers ship by default.
- Limited Use compliance: no use of Google user data for model training.
- A privacy policy that states this flow accurately.

Options — **incomplete until item 0b names which of the three existing Google
paths is the product.** Under a Composio-mediated path, Composio is the OAuth
client and CASA exposure moves to them, which changes this table entirely.

- **A. Pay and publish.** One-click Gmail. Recurring audit obligation.
- **B. Stay BYOK for Google.** Free as a *funding* decision. Rejected as a
  *product* decision: `google-setup.md` §4 currently tells the user to stay in
  Testing status, and Google expires Testing-status refresh tokens after 7 days
  `[INFERENCE — unverified]`. So B is not "friction remains", it is "every
  Google user re-consents weekly" — while `useConnectors.ts:667-669` tells them
  "You only need to do this once."
- **C. Ship Calendar and Drive only** with a shipped client, Gmail BYOK.
  Rejected: two client IDs and two consent screens for one Google account is
  worse UX than either pure option.

Recommendation: **B as the funding decision, not the product decision.** Do not
buy CASA yet, and in exchange fix the two things that make B honest:

- `google-setup.md` §4 must direct the user to **publish to Production**, not
  stay in Testing. Fifteen minutes against a weekly-logout failure.
- The reconnect copy at `useConnectors.ts:667-669` must stop promising "once".

Convert "does mailbox count justify the audit" into a written trigger rather
than an open question: revisit option A at N connected Google accounts.

Acceptance: an explicit decision recorded; the doc and copy fixes landed; if A,
the LOA on file.

### 6. CalDAV for IMAP accounts — opt-in

Invitation parsing cannot see meetings created directly in a web calendar and
never emailed. CalDAV closes that gap.

Shape: a CalDAV section beside the existing IMAP form, matching how SMTP fields
were added. Discovery via `.well-known/caldav` and `_caldavs._tcp` SRV, with
presets for Fastmail, iCloud and Zoho, and a manual URL otherwise. Reuse
`secret-cipher.ts` for credentials and the `calendar_files.ts` ownership rule
with a fourth prefix.

Cost: a new dependency (`tsdav`), a new credential store, a new connection-test
path, and setup friction for the user. Not every IMAP host offers CalDAV —
Proton requires Bridge, cPanel varies.

Recommendation: opt-in, and only after item 1 proves the cheaper paths work.

Acceptance: a Fastmail account syncs its calendar without affecting its mail;
an account with no CalDAV service fails at the form with a clear reason.

### 7. Recurrence expansion — read side

The write side moved into item 1's window (retain the recurrence envelope),
because discarding `EXDATE`/`RDATE`/`RECURRENCE-ID` is a one-way door: data not
written cannot be recovered later without a full mail resync. What remains here
is purely reading what is by then stored.

Recurring invitations store their `RRULE` unexpanded. A weekly standup appears
once, not weekly. Consumers that list upcoming meetings therefore miss
occurrences.

Correctness requires `EXDATE`, `RECURRENCE-ID` overrides, DST transitions, and
`UNTIL`/`COUNT` bounds. `ical.js` has the primitives. Expansion should be bounded
to the same window the other syncs use, and occurrence ids must be stable across
passes so mirrors do not churn.

Not promoted above items 2a–3, deliberately: it fixes wrong output for a
population of zero on the IMAP-only path, while 2a–3 are what create a population
at all. Fixing correctness for nobody before creating the somebody is the
proxy-metric trap.

Also fix while here:
- Equal-`SEQUENCE` ties fall through to a content compare and rewrite
  (`calendar_invites.ts:214-217`). RFC 5546 breaks equal-SEQUENCE ties on
  `DTSTAMP`.
- `ingestCalendarParts` collapses `unchanged`, `superseded`, `stale` and parse
  failure into one `skipped` counter, discarding the four-outcome return whose
  own docstring says it exists so the caller can log honestly.

Acceptance: a weekly invitation with one cancelled instance produces the right
occurrences across a DST boundary, and re-running produces identical files.

## Cut during review

- **Composio** was a numbered work item containing no work ("No code work
  outstanding"). It is a status line, recorded here: the stored key is a `ck_`
  Connect consumer key; the Platform API needs an `ak_` project key from
  platform.composio.dev. The app now names the mismatch. **User action, not
  project work.** The strategic question about Composio's Gmail path moved to
  item 0b, where it belongs.
- **Wiring invitation parsing into Gmail and Outlook** → `TODOS.md`. Its stated
  cost ("three lines") is wrong by an order of magnitude: `ExtractedAttachment`
  has no `content` field and `calendarParts()` requires one, so Gmail needs a
  per-part `users.messages.attachments.get` round trip plus a materialisation
  path, and Graph needs `$expand=attachments`. Its own text says the value is nil
  because dedupe rejects the results. A deferred item with a tenfold-wrong cost is
  a note, not a plan item.

## Dependencies

Hard ordering only. Everything else is priority, not dependency.

```
  0a (data flow) ──▶ 3 (privacy policy) ──▶ 4 (Gmail decision)
                              │
                              └──▶ 2b (publisher domain)
  0b (pick a path) ─────────────▶ 4
  1 (verify MS) ────────────────▶ 2a
  1 (retain envelope) ──────────▶ 7 (expansion)
```

Note 3 → 2b: item 2b needs a non-`onmicrosoft.com` publisher domain, and dhow.io
is item 3's deliverable. Item 3 is therefore not "unblocks everything Google" —
it gates Microsoft too.

## Priority

1. **0a** — hard blocker, gates the privacy policy and item 4
2. **1** — blocked on user; includes the one-way-door fixes
3. **2a** — the item that actually makes the Goal true for a provider
4. **0b** — decide before item 4 is discussable
5. **3** — free, parallel with 1 and 2a
6. **4** — funding decision plus the doc and copy fixes
7. **2b** — after 3; verify the policy inference first
8. **7** — read-side expansion
9. **6** — CalDAV, only if 1–3 prove insufficient

## Open questions

Reduced to one, after review. The other two were not questions.

- **Is Dhow's mailbox count expected to justify a recurring annual audit?**
  Unanswerable at zero users. Carried as a trigger, not a blocker: revisit item 4
  option A at N connected Google accounts. Set N.

Resolved during review:
- *Which model providers ship by default* — promoted to item 0a as a hard blocker.
- *Does any current Graph write touch sensitive properties* — not a question. The
  scopes are `Mail.ReadWrite` and `Mail.Send` (`providers.ts:96-98`); the answer
  is a ten-minute grep over the Graph call sites, folded into item 2b.

## Also needed

- **`TODOS.md` does not exist.** This plan defers three things and there is
  nowhere for them to go. Create it and file: the cut Gmail/Outlook invite wiring,
  the deferred `findExistingByUid` index (O(M×N) per incoming invitation — the
  `ics-` sweeper removes the growth that makes it urgent), and whichever Google
  paths item 0b parks rather than deletes.
- **A test anchored on idempotency.** "Re-running produces identical files"
  covers item 7's acceptance criterion, the retained recurrence envelope, the
  `ics-` sweeper, and the equal-SEQUENCE tie-break in one assertion.