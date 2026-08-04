# Plan: Dhow multi-tenant SaaS on dhow.io

Status: in progress — items 2 and 3 complete
Owner: Saj
Branch: main
Written: 2026-08-03
Revised: 2026-08-03 — direction set: reach RowBoat feature parity on dhow.io first, then
enhance. Stack fixed: Auth0, MongoDB, a dedicated billing service, shared API credentials,
a credits ledger. An earlier draft recommended a narrower "account + broker" wedge and
argued against rebuilding the web product; that recommendation is superseded.

Two later decisions changed the shape of the work, both recorded inline where they apply:
parity means the **full** RowBoat product surface including the agent-builder (see the end
of "Open questions"), and **`apps/dhowx` is the trunk** rather than something to delete —
`apps/dhow` is ported into it, inverting item 4.

Companion to `docs/plans/connectivity-and-calendar.md`.

## Problem

Two problems, and they are different.

**The product has no business.** Every unit of value Dhow creates is paid for by the user
directly to Google, Anthropic and Composio. Nothing accrues to Dhow.

**The hosted layer was amputated, not designed away.** Commit `dd9e0668` deleted 37 files
from `apps/x` — the account, gateway, billing, credits, referrals, usage metering and the
managed Google broker. The client-side stubs remain: provider flavor `"dhow"`
(`packages/shared/src/models.ts:19`), auth mode `z.enum(['byok','dhow'])`
(`packages/core/src/auth/repo.ts:34`), a "Sign in with Dhow" button
(`welcome-step.tsx:77-91`), and a live billing-error classifier
(`apps/renderer/src/lib/billing-error.ts`, still called from `App.tsx:84-85` and
`chat-sidebar.tsx:62-63`) that matches gateway error strings nothing currently sends.

The web half is in better shape than the desktop half: `apps/dhow` is RowBoat's complete
SaaS, inherited verbatim and untouched. It is missing exactly one thing, and it is the
thing that was never open source.

## Goal

**RowBoat feature parity, running on dhow.io.** Then enhance.

Stack, decided:

| Layer | Choice | Status |
|---|---|---|
| Identity | Auth0 | already wired (`apps/dhow/app/lib/auth0.ts:6-21`); desktop client created |
| Database | MongoDB | already wired, 25 repositories behind 11 interfaces |
| Billing | dedicated service | **does not exist — must be built** |
| Model access | shared API credentials | already the model (one `PROVIDER_API_KEY`) |
| Metering | credits ledger | **does not exist — must be built** |

## Non-goals (for parity; revisit when enhancing)

- **Porting desktop-only features to the cloud.** Meeting detection needs a native macOS
  helper (`meetings/detector.ts`), Code Mode spawns local CLIs against a real git checkout
  (`code-mode/acp/*`), and the knowledge vault is 77 files of direct filesystem writes.
  RowBoat did not host these either. Parity does not require it.
- **Organizations/teams.** RowBoat had none — tenancy was `Project` + a flat
  `ProjectMember` join, with billing attributed to `project.createdByUserId`. Adding orgs
  is an *enhancement*. See "The one thing to get right before parity" below, because this
  is the single decision that is expensive to defer.
- **Replacing BYOK.** A user-supplied credential always overrides a Dhow-supplied one.
  Hosted becomes the default convenience, never the requirement.
- ~~**`apps/dhowx`.** Delete.~~ **Reversed 2026-08-03 — it is the trunk.** Its frontend is
  orphaned (it calls `/api/dhow/agent`, `/api/dhow/config`, `/api/dhow/run`,
  `/api/dhow/summary`, `/api/stream`, none of which exist among the 17 real routes), but
  the app carries the newer stack — `ai@5.0.108`, Next 15.5.7, stable Radix/shadcn, 30
  Vercel AI Elements — and `apps/dhow` is ported into it rather than migrated in place.
  See item 4.

## How RowBoat actually built this

Reconstructed from git history (`git show dd9e0668^:<path>`) and the surviving `apps/dhow`
tree. Historical paths are marked *(deleted)*.

### It was two products, not one

This is the most consequential finding, and it is not obvious from the outside.

```
   DESKTOP (apps/x)                          WEB (apps/dhow)
   api.x.rowboatlabs.com                     Next.js + http://billing
   ─────────────────────                     ────────────────────────
   Supabase Auth (GoTrue), DCR clients       Auth0, Mongo users
   GET  /v1/me           account + credits   POST /api/customers/{id}/authorize
   GET  /v1/config       bootstrap catalog   POST /api/customers/{id}/log-usage
   POST /v1/llm          OpenRouter-protocol GET  /api/customers/{id}/usage
   GET  /v1/llm/models   plan-filtered       ... 13 functions total
   POST /v1/google-oauth/{claim,refresh}
   POST /v1/billing/credit-activations       tenancy: Project + ProjectMember
   GET/POST /v1/referral[/claims]            billing attributed to project creator

   credits: monthly / daily / store          credits: single pool
   plans:   open catalog, server-owned       plans:   enum(free|starter|pro)
   gate:    none client-side; gateway 4xx    gate:    pre-flight authorize()
```

**No code path, shared ID, or shared API call connected them.** Every apparent overlap is
same-name-different-thing: the desktop's `projectId` is a local git-repo registration
(`code-mode/projects/repo.ts`), not the web's tenant. The only literally shared artifact is
the constant `CREDITS_PER_DOLLAR = 100_000_000` *(deleted, `packages/shared/src/billing.ts:4`)*.

**Decision this forces:** build *one* backend for both, or repeat RowBoat's split?
Recommend **one** — a single Auth0 tenant, one credits ledger, one billing service, one
gateway, serving desktop and web. That is a deliberate improvement over parity, it is what
the chosen stack implies, and the alternative means two ledgers a user can be
simultaneously out of credits on. Cost of unifying now: near zero. Cost later: a migration.

### The model gateway *(deleted, `packages/core/src/models/gateway.ts`)*

```ts
export function getGatewayProvider(): ProviderV4 {
    return createOpenRouter({
        baseURL: `${API_URL}/v1/llm`,
        apiKey: 'managed-by-rowboat',   // placeholder, never on the wire
        fetch: authedFetch,
    });
}
```

- `API_URL` defaulted to `https://api.x.rowboatlabs.com` *(deleted, `config/env.ts:1-2`)*.
- **Auth was the user's account bearer**, not an API key. `authedFetch` overwrote
  `Authorization` per request.
- It also stamped `x-rowboat-use-case`, `x-rowboat-sub-use-case`, `x-rowboat-agent-name`
  from AsyncLocalStorage — that is how spend was attributed to a *feature*, not just a user.
- `GET /v1/llm/models` returned a **pre-filtered** list. Plan eligibility was enforced
  server-side by omission; the desktop applied no filter and trusted the response.
- On sign-in, `rowboat-selection.ts` *(deleted)* auto-picked an initial model from
  `getRowboatConfig().modelRecommendations`. **Dhow has no equivalent today** — a real UX
  gap versus parity.

### The account *(deleted, `account/account.ts`, `auth/tokens.ts`)*

Supabase Auth (GoTrue), discovered at runtime — `providers.ts` declared
`issuer: 'TBD'` and overrode it from `GET /v1/config`'s `supabaseUrl`. Client registration
was **DCR** (RFC 7591), so no client_id shipped in the bundle. `account.ts` was 8 lines: it
only answered `isSignedIn()`; identity and plan came fresh from `GET /v1/me`.

Tokens were plaintext JSON in `WorkDir/config/oauth.json` — unchanged today. Refresh was
entirely client-side against the issuer, deduped through a module-level `refreshInFlight`.

### Billing and credits *(deleted, `billing/billing.ts`, `billing/credits.ts`)*

- Unit: credits, `CREDITS_PER_DOLLAR = 100_000_000`.
- Three buckets: `monthly` and `daily` (sanctioned per plan) plus `store` (bonus, from
  referrals and first-action rewards).
- **Warn, don't hard-block.** No client-side pre-flight. The desktop always attempted the
  call; the gateway returned `out_of_credits` / `subscription_required` /
  `subscription_inactive`, which the client matched by regex. That classifier
  (`lib/billing-error.ts`) **still exists in the current tree** — so the gateway's error
  contract is already defined for us.
- Growth loops: invite codes (`POST /v1/referral/claims`, dual-sided grant, one lifetime
  claim) and one-time action rewards (`first_gmail_connected`, `first_email_sent`,
  `first_meeting_note`, `first_bg_agent`, `first_app_built`).

### Usage metering *(deleted, `runtime/turns/bridges/real-usage-reporter.ts`)*

Reported `{useCase, subUseCase, agentName, model, provider, usage}` — **into PostHog**, not
a billing endpoint. Fire-and-forget, errors swallowed. Actual credit deduction happened
server-side inside the `/v1/llm` request path. **Do not copy this.** Metering that can be
silently dropped is not a ledger; deduct in the gateway and treat analytics as a separate,
lossy concern.

### The managed Google broker *(deleted, `auth/google-backend-oauth.ts`)*

The most valuable deleted thing, and the one with no successor.

```
desktop → opens browser at {webappUrl}/oauth/google/start
          webapp runs the FULL Google exchange, holding client_secret server-side
          parks tokens under a state ticket
        → deep-link rowboat://oauth/google/done?session=<state>
desktop → POST /v1/google-oauth/claim {session}     (acct bearer) → tokens
          POST /v1/google-oauth/refresh {refreshToken} → backend does the exchange
```

The desktop **never held a Google client_secret**. There was also a Picker variant
(`/oauth/google/picker/start` → `claim-picked` → `{fileIds, accessToken}`) needing no
Picker API key or appId.

**Today's design is different, not a port.** `config/env.ts:14-19` states the new
philosophy plainly — a desktop client cannot keep a secret, PKCE protects the flow, ship a
secret only because Google's *web application* client type demands one at the token
endpoint. Today `knowledge/google-client-factory.ts` performs every exchange and refresh
**locally**, using a bundled secret. The `mode: 'dhow'` value survives only so pre-rebrand
`oauth.json` files still revoke correctly (`oauth-handler.ts:560`); **no code path can write
it today**. The doc-comment at `auth/repo.ts:29-30` still promises the old broker design and
is now inaccurate.

Parity here means standing up `/v1/google-oauth/{claim,claim-picked,refresh}` from scratch.

## The billing service — the one thing that must be built from nothing

`USE_BILLING` / `BILLING_API_URL` / `BILLING_API_KEY` point at `http://billing`, a hostname
with **no service in `docker-compose.yml`**. It was never open source. But its complete
contract survives in the client (`apps/dhow/app/lib/billing.ts`, 319 lines, 13 exported
functions) and its types are frozen in `app/lib/types/billing_types.ts` — annotated
*"DO NOT MODIFY — manually copied from the billing service repo."*

That is a full specification. Build against it and every one of the 20+ call sites in
`apps/dhow` works unchanged.

| # | Endpoint | Encodes |
|---|---|---|
| 1 | `POST /api/customers` | provision customer (creates the Stripe customer) |
| 2 | `GET /api/customers/{id}` | fetch customer |
| 3 | `POST /api/customers/{id}/sync-with-stripe` | force re-pull after Checkout, closes the webhook-lag race |
| 4 | `POST /api/customers/{id}/authorize` | **the gate** — see variants below |
| 5 | `POST /api/customers/{id}/log-usage` | meter after the fact |
| 6 | `GET /api/customers/{id}/usage` | balance for the dashboard |
| 7 | `POST /api/customers/{id}/customer-portal-session` | Stripe portal URL |
| 8 | `GET /api/prices` | plan catalog |
| 9 | `POST /api/customers/{id}/update-sub-session` | Checkout/upgrade URL |
| 10 | `GET /api/customers/{id}/models` | plan-gated model allowlist (advisory) |

Plus three composed client-side helpers: `getCustomerForUserId`, `getCustomerIdForProject`
(billing attributed to `project.createdByUserId`), and `requireActiveBillingSubscription`.

**`AuthorizeRequest` variants** — these are the business rules:

| Variant | Gates |
|---|---|
| `{type:'use_credits'}` | any credit-consuming action: chat turns, copilot turns, webhook-fired jobs, RAG ingestion |
| `{type:'create_project', data:{existingProjectCount}}` | plan project cap (server owns the limit; `maxProjectsOverride` per customer) |
| `{type:'agent_response', data:{agentModels[]}}` | **hard** per-model eligibility at run time — the enforcement counterpart to the advisory `getEligibleModels` |

**`UsageItem` taxonomy:** `LLM_USAGE{modelName, inputTokens, outputTokens, context}`,
`EMBEDDING_MODEL_USAGE`, `COMPOSIO_TOOL_USAGE`, `COMPOSIO_TRIGGER_USAGE`,
`FIRECRAWL_SCRAPE_USAGE`. Add `EGRESS_FETCH` — it is both a cost and a security signal.

Auth is a single static server-to-server secret (`BILLING_API_KEY`), never a user token —
the Next.js server calls on the authenticated user's behalf.

### Shared API credentials — and the margin that implies

Confirmed: one shared upstream key for all tenants. `docker-compose.yml:49-51` injects
`PROVIDER_API_KEY` / `PROVIDER_BASE_URL` / `PROVIDER_DEFAULT_MODEL` as process-level env;
`agents-runtime/agents.ts:23-25`, `agent-tools.ts:28-34` and `copilot/copilot.ts:17-20` each
build **one module-scoped client** shared by every request. The only per-request variable is
the model *name*. Grep for `byok|apiKeyOverride|customApiKey` in `apps/dhow`: zero matches.

So margin = subscription revenue − aggregate upstream token cost. The credits ledger is the
entire enforcement layer. Two consequences: **hard credit caps must be checked before the
call, not after**, and cheap-model-by-default routing is a margin decision, not a
preference. (2026 spread: frontier reasoning ~$30/M input; capable budget models ~$0.14 in
/ $0.28 out; cache hits two orders cheaper.)

Stripe's March 2026 Billing can ingest token usage, map it to model pricing, and apply a
markup before invoicing — that turns "30% over cost" into configuration. Note the legacy
usage-records API is gone since `2025-03-31.basil`; every metered price needs a backing
Meter, and you should aggregate in Redis and flush per interval rather than per event
(Stripe's ~100 req/s ceiling is what breaks AI companies metering per token).

## The one thing to get right before parity

RowBoat had no organization entity, and copying that is the one shortcut that will hurt.
Tenancy was `Project` + flat `ProjectMember`, billing attributed to the project creator.
That has no billing boundary above the project — a user with three projects is three
independent billing relationships, and there is nowhere to hang a team plan.

Retrofitting a tenant boundary after launch is the single most expensive migration
available. Add `Organization` now even though RowBoat lacked it:

```
Organization   (tenant + billing boundary)   ← NEW, the one deviation from parity
    ├── Member (user × org, role)
    ├── Project (existing entity, gains orgId)
    ├── Subscription + credits ledger
    └── Device (a paired desktop install)
```

A solo user gets an implicit single-member org at signup and never sees the word.

**Isolation: pool by default, silo by tier.** Shared Mongo, mandatory `orgId` on every
document, `orgId` as the shard key later. MongoDB's own guidance: shared collections for an
indefinitely growing tenant count; database-per-tenant only for a small stable number, and
never past ~10,000 collections per cluster.

**Enforce in one place.** `ProjectActionAuthorizationPolicy`
(`src/application/policies/project-action-authorization.policy.ts:32-54`) is already the
right shape in the right layer — invoked from inside use-cases, not middleware, so a new
transport cannot bypass it. Generalize it to a tenant policy and make tenant scope a
constructor-injected, non-optional repository argument, so a missing filter is a compile
error rather than a leak.

**Qdrant.** Keep the single `"embeddings"` collection — that is Qdrant's own recommendation
and `setup_qdrant.ts:8-13` already does it. Two changes: add `orgId` to the payload beside
`projectId`, and create the tenant payload index (`is_tenant=true`, `payload_m: 16`,
`m: 0`). Without `is_tenant` sequential read performance collapses; with it the filter runs
*inside* HNSW traversal. Past ~20K points per tenant, Qdrant 1.16 tiered multitenancy
promotes a tenant to a dedicated shard inside the same collection.

**The agent-specific obligation.** In ordinary SaaS a tenant-boundary failure returns wrong
data. In an agent platform it enters the reasoning chain and the agent *acts on it through
tools* — blast radius is bounded only by tool reach. Four rules, non-negotiable, and all
four should be back-ported to desktop: credentials never inside the agent's readable
surface; egress allowlisted per tenant and logged as a billable event; tool calls
authenticate *as the tenant*; agent logs are tenant data (they carry reasoning chains,
retrieved chunks and tool parameters) and must be access-controlled as such.

## Work

### 1. dhow.io foundation
Homepage, privacy policy, terms of service, Google Search Console verification. Free, and
it blocks Microsoft publisher verification, the Google path, and any billing at all. The
privacy policy must describe the model-provider data flow truthfully — which requires
item 2 first.

### 2. Desktop security prerequisites
`~/.dhow/config/**` out of the agent-readable workspace boundary
(`runtime/assembly/permission-metadata.ts:112-117`); `fetch-url` loses `permission:"none"`
and gains an SSRF guard (`runtime/tools/domains/web.ts:125`); tokens through
`auth/secret-cipher.ts` (already correct for IMAP, unused elsewhere); shell execution to
argv `execFile` with `find`/`awk`/`env`/`printenv` out of the default allowlist
(`config/security.ts:8-43`).

*Acceptance:* an email cannot make a background agent read a credential file or reach an
unlisted domain, both proven by test.

### 3. Repository surgery
**Done 2026-08-03.** Vendored `rowboat-shared` and dropped the
`github:rowboatlabs/shared` dependency — 7 import sites in `apps/dhow` plus 1 in
`apps/experimental/chat_widget`, ~100 lines of pure Zod that `npm install` pulled from an
org this project does not control. Schemas now sit at
`apps/dhow/src/entities/models/api-v1.ts` and `chat_widget/app/lib/api-v1.ts` (deliberate
duplicate: no workspace root, separate lockfiles). Both lockfiles regenerated, so `npm ci`
now fails on any reintroduced GitHub-org dependency. Added `.github/workflows/dhow-web.yml`
— `apps/dhow` had no CI at all across 457 files.

Both deletions this item originally called for are **cancelled**:

- *The 9 `501` route stubs stay.* Parity means reviving them; their implementations sit
  commented out beneath the stubs (`app/api/widget/v1/utils.ts:19-20,46-47`). The vendored
  schemas are their wire contract — load-bearing, not dead code.

  **Landmine found while writing the characterization tests:** three of those stubs — the
  widget turn route and both Twilio voice routes — call `getResponse`
  (`agents-runtime/agents.ts:1550`), whose entire body is commented out beneath a
  `throw new Error("Not implemented!")`. Nothing hits it today only because the stubs
  return `501` first. Reviving any of the three turns it into a live crash on the first
  request. `getResponse` has to be reimplemented as part of that revival, not discovered
  afterwards; the commented body shows the intended shape (drain `streamResponse`,
  partition messages from usage). Pinned by a test that asserts it throws, so the port
  fails red rather than shipping a mystery 500.
- *`apps/dhowx` is not deleted. It is the trunk.* See item 4.

### 4. Port `apps/dhow` into `apps/dhowx`
**Direction set 2026-08-03, reversing this item.** The original plan migrated `apps/dhow`
in place (Next 15.3.8 → 16, `ai@4` → v7, replace HeroUI beta). Instead the newer app
becomes the base and the product is ported across.

Neither app was strictly ahead, which is why this needed deciding rather than assuming:

| | `apps/dhowx` | `apps/dhow` |
|---|---|---|
| Stack | `ai@5.0.108`, Next 15.5.7, stable Radix/shadcn + 30 Vercel AI Elements | `ai@4.3.13`, Next 15.3.8, HeroUI `2.8.0-beta.10` |
| LOC | 10,883 | 56,665 |
| API routes | 0 | 17 |
| Pages | 1 (`page.tsx`, 1045 LOC) | 24 |
| Auth0 / Mongo / Stripe / Qdrant / Redis | none | all wired |

So `dhowx` leads on UI stack and has no product; `dhow` is the product on an older stack.

**The blocker this surfaced, now cleared.** `dhowx` shipped `output: "export"` — a static
site, where Next refuses to build any `route.ts`. It had never had a server at all. Flipped
to `output: "standalone"` (matching `apps/dhow`) and proven: `apps/dhowx/app/api/health`
builds as `ƒ` dynamic, and the running standalone server returns `{"ok":true,
"runtime":"server"}` while the UI still renders. `.github/workflows/dhowx-trunk.yml` gates
typecheck, lint, build, **and** asserts both the standalone output and a live API response
— a silent revert to static export would otherwise pass every other check while quietly
dropping every API route.

**Order of the port.** Backend first, UI last: the 17 API routes and server actions, then
Auth0 session handling, then Mongo/Qdrant/Redis wiring, then pages — reworking each onto
`dhowx`'s Radix/shadcn kit as it lands rather than carrying HeroUI across. `apps/dhow`
stays the source of truth and keeps its CI gate until the last route moves, then is
deleted in one commit.

**Characterization tests: done 2026-08-03.** `apps/dhow` went from no test runner at all to
107 tests over the agent runtime (vitest + `vite-tsconfig-paths`, wired into
`dhow-web.yml`). Every pin was mutation-tested — the source was deliberately broken to
confirm the test fails, then restored byte-for-byte. One escaped on the first pass (a
precedence test asserting only `.name`, which every tool factory sets identically) and was
rewritten until it caught the mutation.

Covered: prompt builders, the four handoff schemas, tool dispatch precedence, pipeline
state transitions, the greeting short-circuit, and the live loop end to end — single turn,
tool-call round trips, and agent-to-agent transfers — driven against a scriptable local
OpenAI-compatible mock via the `PROVIDER_BASE_URL` seam. No network, no API key, no
recorded fixtures. **Not covered:** the ~440 files outside the agent runtime.

**A real bug this caught.** `agents.ts:707` used a CommonJS
`require('./agent_instructions')` inline, in a file that already statically imports six
other symbols from that exact module. It resolves today only because Next's bundler shims
`require()` into ESM output; under plain ESM it throws `Cannot find module`, and it sits on
the agent-transfer path. The transfer tests failed on it immediately. Fixed by moving the
symbol to the existing static import. Worth noting for the port: apps/dhowx uses the same
bundler, so this would have kept working there and only surfaced under a different runtime
— a test runner, an edge target, or a standalone worker.

**A decision this surfaced.** `USE_NATIVE_HANDOFFS` (`agents.ts:28`) is unset in
docker-compose and every `.env` here, so production runs `createAgentsLegacy` with
`pipelineStateManager = null`. `createAgentsWithNativeHandoffs` and the whole
`PipelineStateManager` (321 lines, plus `createPipelineHandoff`/`createTaskHandoff`) are
**dormant behind a flag** — written, typechecked, never executed. The port must choose:
flip the flag on and test it properly, or delete the dormant path. Carrying two handoff
implementations across a port and picking neither is the bad outcome. Pinned by a test
asserting LEGACY is the default, so a silent flip fails red.

**Two risks still to hold.** The port *moves* untested code between apps rather than
editing it in place, and the pins above cover the runtime, not the other ~440 files. And
`ai@5` is a waypoint, not the target: the v4→v7 jump still spans two majors, and `dhowx`'s
v5 patterns need checking against current docs rather than being trusted as current.

### 5. Organizations and the tenant boundary
Per the section above. The one deliberate deviation from parity, and the one that must
land before real tenants exist.

### 6. The billing service
Implement the 13-endpoint contract against Stripe. Credits ledger with RowBoat's three
buckets (`monthly`, `daily`, `store`). Redis aggregation flushed per interval. Deduct in
the gateway path, before the call.

*Acceptance:* every existing `authorize` / `logUsage` / `requireActiveBillingSubscription`
call site in `apps/dhow` works unchanged against the new service.

### 7. The model gateway
`api.dhow.io/v1`, bearer-authenticated against Auth0, shared upstream credentials, plan-based
eligibility, credit check before the call, metering after. Honor the error contract
`lib/billing-error.ts` already expects: `out_of_credits`, `subscription_required`,
`subscription_inactive`.

Desktop side is **already built and tested** (`models/dhow.ts`, `auth/dhow-auth.ts`,
catalog branches, `case "dhow"`), including RowBoat's `x-dhow-use-case` attribution headers.

*Acceptance:* "Sign in with Dhow" completes and the assistant answers with no API key
anywhere. That button has never worked.

### 8. The managed Google broker
`/oauth/google/start` + `/v1/google-oauth/{claim,claim-picked,refresh}`, per the deleted
design. This is the feature that removes the OAuth-administrator wall, and it is the one
piece with genuinely no successor in the current tree.

Note the cheaper interim: shipping `DHOW_MICROSOFT_CLIENT_ID` against an Azure registration
gives one-click Outlook **with zero code** — `config/env.ts:21-23` and `providers.ts` already
implement it. Do that first regardless.

### 9. Growth loops
Invite codes and first-action credit rewards. RowBoat had both; they are cheap and they are
why a credits ledger beats raw token billing.

### 10. Enhance
Teams, pooled credits, shared knowledge, hosted surfaces — after parity, on evidence.

## Sequence

```
1  dhow.io foundation ─┐
2  desktop security  ──┴─→ 3  repo surgery → 4  port apps/dhow ─→ apps/dhowx
                            [done]                    │
                            5  organizations ←────────┘
                                   │
                            6  billing service
                                   │
                            7  model gateway ──→ 8  Google broker → 9  growth → 10 enhance
```

Items 1 and 2 are independent; **2 is done**, 1 is unblocked by it. Item 3 is done. Item 4
gates 5–9 and is now the largest single item in the plan — it moves ~45k LOC of backend and
product surface into an app that had none. Items 6 and 7 remain the critical path to
revenue.

## Compliance

**Google restricted scopes / CASA.** Per `connectivity-and-calendar.md` item 4: `gmail.modify`
and `gmail.readonly` are restricted, needing an annual CASA Tier 2 assessment (~$540–$1,000/yr,
recertified every 12 months) because restricted data transits third-party model servers.

**One prerequisite that plan does not list, and it is disqualifying as written.** CASA
examines credential storage and egress control. Today Dhow stores Gmail refresh tokens in
plaintext (`auth/repo.ts:211-213`), lets any agent read them with no permission check
(`permission-metadata.ts:112-117`), and ships an unrestricted egress tool (`web.ts:125`)
reachable from an email-triggered background agent with no human in the loop
(`headless.ts:158-159`). **Item 2 is a prerequisite for the Google path, not parallel to it.**

**SOC 2.** Not now — trigger 3–6 months before the first enterprise deal. Reality: 85% of
enterprise buyers require it; 3–12 month observation window, 6–15 months start-to-report;
$40k–$120k first-year all-in for an AI startup, ~65% of that internal labor. AI-specific
evidence auditors now ask for first: model lineage, prompt/inference logs with PII redacted
*before* logging, drift monitoring, vendor risk assessment per third-party LLM. Design the
logging pipeline for that on day one; retrofitting redaction is the expensive version.

## Risks

### Security findings — found and fixed 2026-08-03 while characterizing `apps/dhow`

Eight parallel agents pinning behaviour across the ~440 files outside the agent runtime
surfaced five real defects. **All five are now fixed.** Each fix deliberately inverted the
test that pinned the vulnerable behaviour — the old assertion is quoted in a comment above
the new one, so the record of what was wrong survives in the test file. Every fix was
mutation-tested: the guard was removed, the test confirmed failing, then restored.

`apps/dhow` is at 836 tests / 49 files, typecheck and lint clean.

1. **Path traversal → arbitrary host file read.** `src/infrastructure/…/local.uploads-storage.service.ts:36-37`
   joins an unsanitised stored path onto the upload root, and `path.join('/uploads',
   '../../etc/passwd')` normalises to `/etc/passwd`. Full chain traced: `app/actions/data-source.actions.ts:123`
   accepts an arbitrary `file_local.path` from any authenticated project member,
   `mongodb.data-source-docs.repository.ts:29-43` stores it verbatim, and
   `data-source.actions.ts:175` reads it back through the vulnerable join. **Any
   authenticated user of any project can read arbitrary files off the host.** Highest
   severity found.
2. **Unauthenticated write of Twilio credentials.** `app/actions/twilio.actions.ts`
   `mockConfigureTwilioNumber` is exported from a `'use server'` file — a browser-reachable
   RPC endpoint regardless of its "testing/development" comment. It performs no auth check
   (its three siblings all call `projectAuthCheck` first) and writes `account_sid` /
   `auth_token` for whatever `project_id` the caller supplies.
3. **Billing bypass in the RAG worker.** `app/scripts/rag-worker.ts:417-419` tests
   `if ('error' in authResponse)` where every other call site tests `if (!authResponse.success)`.
   `AuthorizeResponse.error` is `z.string().optional()`, so a `{success:false}` response
   with no `error` key has no `error` property at all — the guard never fires and document
   processing proceeds on a denied credit check. `billing.ts` itself fails closed
   everywhere; this one call site does not.
4. **Unescaped regex → uncaught crash.** `mongodb.assistant-templates.repository.ts:42-47`
   passes `filters.search` straight into `$regex`. An unbalanced parenthesis throws a
   `SyntaxError` out of `list()` — an unhandled-crash DoS from ordinary user input.
5. **Dynamic `$set` path injection.** `mongodb.projects.repository.ts:87,117` interpolates
   `toolkitSlug` / `name` into a Mongo update field path with no charset validation, so a
   dotted value can deepen the write path.

Also worth carrying into the port, not vulnerabilities: **`fetch()` by id is not
tenant-scoped** in the jobs, conversations, data-sources, data-source-docs and
composio-trigger-deployments repositories. Isolation is a convention — the use-case layer
re-derives `projectId` from the fetched document and authorizes before use. Spot-checks
found every call site doing this correctly, so there is no leak today, but it is enforced
by discipline rather than by the data layer, and a port is exactly where that discipline
lapses.

- **The billing service is a real service, not a shim.** Credit ledger, Stripe webhooks,
  plan limits, model eligibility, idempotency. RowBoat kept it closed-source and separate
  for a reason. Underestimating item 6 is the most likely way this slips.
- **Shared upstream credentials mean Dhow owns model margin.** Gateway users spend Dhow's
  money. Hard caps before the call, cheap-model-by-default routing.
- **Hosting mail content changes the threat model.** Desktop is local-first: a breach is one
  machine. The gateway sees prompt content in transit. Zero-retention terms with providers
  are a prerequisite, not a nice-to-have — and they gate the Google path too.
- **`apps/dhow` has 0 tests across 457 files.** Every parity feature lands on untested
  inherited code, and item 4 now *moves* that code between apps rather than editing it in
  place — a port with no behavioural tests is a rewrite you cannot diff. Item 3 added CI
  (`dhow-web.yml`, typecheck + lint), and `dhowx-trunk.yml` gates the trunk including a
  live API-route assertion. Neither catches behaviour. Characterization tests around
  `agents-runtime` are a prerequisite for item 4, not a follow-up.
- **Upstream divergence.** `rowboatlabs/rowboat` is 27 commits ahead with 56 overlapping
  files including `App.tsx`, `ipc.ts`, `main.ts`. Every week raises the merge cost. Decide
  explicitly: merge, or announce a clean divorce.
- **One maintainer, two products.**

## Open questions

- Which model providers ship by default in the gateway, and do they offer zero-retention
  terms? Gates the Google path and the privacy policy. (Same question as connectivity-plan
  item 4 — answer once.)
- One backend for desktop + web, or RowBoat's two? Recommend one; needs a decision before
  item 6.
- Credits or seats when teams arrive? Pooled credits are friendlier; seats are more
  predictable revenue.
- ~~Does anything currently deploy `apps/dhow` via `docker-compose`?~~ **Moot** — item 3's
  deletions were cancelled and nothing is being removed. Still worth knowing before item 4
  retires `apps/dhow` at the end of the port.

**Resolved 2026-08-03 — parity means the full RowBoat product surface**, including the
project-scoped agent-builder: workflows, copilot, data sources, jobs and triggers, and the
chat widget. Not just the account/billing/gateway layer. Consequences: item 4's AI SDK
v4→v7 migration covers the whole agent runtime (`src/application/lib/agents-runtime/`,
`copilot/`), not a slice; the 9 dead `501` widget/Twilio routes in item 3 are
*revivals*, not deletions — their handlers exist fully commented out beneath the stubs
(`app/api/widget/v1/utils.ts:19-20,46-47`); and item 6's `create_project` authorize variant
becomes load-bearing rather than vestigial.
