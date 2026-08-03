# Plan: Dhow multi-tenant SaaS on dhow.io

Status: draft, awaiting review
Owner: Saj
Branch: main
Written: 2026-08-03

Companion to `docs/plans/connectivity-and-calendar.md`. That plan needs dhow.io to exist.
This plan is what dhow.io becomes.

## Problem

Dhow desktop is bring-your-own-everything. A user must become an OAuth administrator
before they can read their own mail, and a model-provider customer before the assistant
says a word. That is a wall in front of every user who is not the author.

There is also no business. Every unit of value Dhow creates is paid for by the user
directly to Google, Anthropic and Composio. Nothing accrues to Dhow.

And the app already knows this. The desktop build ships a complete client-side
implementation of a hosted account that has no server behind it:

- `packages/shared/src/models.ts:19` — `"dhow"` is a first-class provider flavor.
- `packages/core/src/models/defaults.ts:49,54-55` — `"dhow" → gateway provider (auth via
  OAuth bearer; no creds field)`.
- `packages/core/src/auth/repo.ts:29-34` — provider mode is `z.enum(['byok','dhow'])`;
  `dhow` means *"signed-in user; client_id+secret never on the desktop; tokens stored
  locally but refresh goes through the api"*.
- `packages/core/src/models/repo.ts:95` — the flavor is explicitly auth-derived and
  refused a slot in `models.json`.
- `apps/renderer/src/components/onboarding/steps/welcome-step.tsx:77-91` — the primary
  call to action on the first screen a new user sees is **"Sign in with Dhow"**.
- `apps/renderer/src/hooks/use-models.ts:115`, `components/connectors-popover.tsx:213-215`,
  `components/chat-input-with-mentions.tsx:540-542` — connection state, connector UI, and
  a capability gate that grants web search without an Exa key when signed in.

None of it works. `packages/core/src/auth/providers.ts:62-122` registers only `google`,
`microsoft` and `fireflies-ai`, so `getProviderConfig('dhow')` throws `Unknown OAuth
provider: dhow` at `:127-131`. Even past that, `packages/core/src/models/models.ts:29-113`
has thirteen flavor cases and no `dhow` case, so it throws `Unsupported provider flavor:
dhow`.

**The desktop app is a client waiting for a server. The contract is already written down
in its type system.** That is the wedge, and it is why this is a smaller project than it
looks.

## Goal

dhow.io is a hosted account that makes the desktop app work without the user becoming an
administrator, and charges for the value it adds. A user clicks "Sign in with Dhow",
approves one consent screen, and has mail, calendar, models and search working.

Later, and only later, dhow.io is also a place you can *use* Dhow in a browser.

## Non-goals

- **Porting the desktop app to the cloud.** Not in this plan, possibly not ever. See
  "What cannot move" below — meeting detection needs a native macOS helper, Code Mode
  spawns local CLIs against a real git checkout, and the knowledge vault is 77 files of
  direct filesystem writes. Hosting those is a different company.
- **Keeping the RowBoat product.** `apps/dhow` is scaffolding, not a product. Its
  agent-builder (projects → workflows → copilot → chat widget) is a different business
  from an AI coworker with memory. We keep the architecture and delete the product.
- **`apps/dhowx`.** See "Current state".
- **Replacing BYOK.** A user-supplied credential always overrides a Dhow-supplied one, in
  both directions. Local-first stays true; hosted becomes the default *convenience*, never
  the requirement. `auth/repo.ts:26-31` already encodes this — `byok` is the default for
  an absent mode.

## Current state

### `apps/dhow` — better scaffolding than expected

457 tracked TS/TSX files. Copied verbatim from upstream in `dd9e0668` (605 files,
101,894 insertions, 0 deletions) and touched once since, cosmetically. No tests, no CI.

What is genuinely good and worth keeping:

- **Clean/hexagonal architecture, properly done.** 61 use-cases in
  `src/application/use-cases/`, 11 repository interfaces, 25 Mongo adapters in
  `src/infrastructure/repositories/`, all wired through one awilix container
  (`di/container.ts`). Swapping or extending persistence is a container edit.
- **Authorization is enforced in the use-case layer, which is the right place.**
  `src/application/policies/project-action-authorization.policy.ts:32-54` takes
  `{caller, userId|apiKey, projectId}` and checks membership or key. 20+ use-cases inject
  it and call `.authorize()` as the first statement of `execute()`
  (e.g. `create-conversation.use-case.ts:55-59`). Not middleware, not controllers — so a
  new transport cannot accidentally bypass it.
- **Jobs are durable.** Mongo is the queue of record with claim-and-lock
  (`mongodb.jobs.repository.ts:74-144`); Redis pub-sub is a wake-up optimization on top,
  with a 5s poll fallback (`jobs.worker.ts:29,186-220`). That survives a Redis outage.
- **Qdrant already uses the pattern Qdrant recommends.** One shared collection
  `"embeddings"` (`setup_qdrant.ts:8-13`), tenant-filtered by payload at query time
  (`agent-tools.ts:224-234`). Qdrant's own guidance is a single collection with payload
  partitioning; collection-per-tenant "does not scale past a few hundred and wastes
  resources."
- **Rate limiting exists.** `redis.usage-quota.policy.ts:10-44` — sliding-window `INCR`
  + `EXPIRE` for `MAX_QUERIES_PER_MINUTE` and `MAX_JOBS_PER_HOUR`.

What is broken, missing, or dishonest:

- **The billing service does not exist.** `USE_BILLING`/`BILLING_API_URL`/`BILLING_API_KEY`
  point at a service absent from this repo and from `docker-compose.yml`. It was never
  open source. Every call is funneled through 13 exported functions in one file,
  `app/lib/billing.ts` (319 lines), against a contract frozen in
  `app/lib/types/billing_types.ts` (annotated *"DO NOT MODIFY — manually copied from the
  billing service repo"*). That concentration is lucky: it means one file to rewrite.
- **No organization, team or workspace entity exists.** Fifteen entity models, none of
  them an org. Tenancy is `Project` with a flat `ProjectMember` many-to-many
  (`project-member.ts:3-8`). There is no billing boundary above the project.
- **Most of the API is dead.** Of 17 route files, 2 are functional and authorized
  (`/api/v1/[projectId]/chat`, the Composio webhook). Nine are permanent `501`s — all 7
  chat-widget routes are stubbed at `app/api/widget/v1/utils.ts:19-20,46-47`, plus both
  Twilio routes. Four are unauthenticated internal helpers.
- **The AI SDK is two major rewrites behind.** `ai@^4.3.13` against `ai@7` current; v5 was
  a ground-up rewrite. This is the single largest piece of unavoidable modernization.
  Next 15.3.8 against 16.2.11. HeroUI at `2.8.0-beta.10` — a pre-1.0 beta as the primary
  UI kit. ESLint 8.
- **`rowboat-shared` is a live install-time dependency on `github:rowboatlabs/shared`**
  (`package.json:65`) — 7 import sites, all inside the dead widget code, all pure Zod.
  Vendoring it is a copy and seven import edits.
- **`MAX_PROJECTS_PER_USER` is wired in docker-compose and referenced nowhere in code.**
  With `USE_BILLING=false` there is no project-count enforcement at all.

### `apps/dhowx` — delete it

69 files, orphaned. Its own Next.js and React install, zero shared code with `apps/dhow`,
zero API routes. Its single 1046-line page calls `/api/dhow/agent`, `/api/dhow/config`,
`/api/dhow/summary`, `/api/stream` — **none of which exist** in dhow's 17 real routes. It
depends on `v0-sdk`; it is a v0.dev prototype built against a backend that never shipped.
It also pins `ai@^5.0.108` while `apps/dhow` pins `ai@^4.3.13`, so the two apps in this
monorepo are on different major generations of the same SDK. Not referenced by
docker-compose, not by CI, not by anything.

### `apps/x` — what can be shared

`packages/core` is genuinely Electron-free: zero imports of `electron`, `node-pty` or
`uiohook-napi` anywhere in 374 files. All Electron coupling lives in `apps/main`, which
injects platform adapters via `setSecretCipher`, `registerNotificationService`,
`registerBrowserControlService`. That discipline is the reason any of this is possible.

`packages/shared` (39 files) is **already server-safe** — zod and vitest only, zero
`node:*` imports. It could be installed into a Next.js backend today, unchanged.

**The agent runtime is portable, and this is proven rather than asserted.**
`ITurnRepo` (`runtime/turns/repo.ts:6-15`) and `ISessionRepo`
(`runtime/sessions/repo.ts:4-20`) each have **two** independent implementations — an
append-only JSONL filesystem repo and an in-memory repo built explicitly to "mirror
FSTurnRepo semantics without touching disk." `TurnRuntime` (1,535 lines) has zero direct
`fs` or `WorkDir` references; everything arrives through injected interfaces. A Mongo
implementation is a new class registered at `di/container.ts:124,145`.

The blocker is not the runtime. It is everything around it:

| | Count | Note |
|---|---|---|
| Files in `packages/core/src` | 374 | |
| ...referencing `WorkDir` | 124 (33%) | `config/config.ts:6-24` resolves it as a **process-wide singleton at import time**, with side-effecting mkdirs and config writes at `:30-62`. Two WorkDir values cannot coexist in one process. |
| ...importing `fs`/`node:fs` directly | 142 (38%) | |
| Repos with an `IXRepo` interface | ~24 | but only `turns`/`sessions` have a second implementation; the other ~20 are declared-but-unproven |
| No abstraction at all | `filesystem/files.ts` (649 lines), `knowledge/*` (77 files), `search/search.ts` (shells to `grep`), `events/producer.ts`, `workspace/watcher.ts` | |

Every DI registration is `.singleton()` and **nothing in the codebase passes a tenant
identifier anywhere.**

**What cannot move**, regardless of effort:
`meetings/detector.ts` (native macOS Swift mic helper) · `code-mode/acp/*` and
`code-mode/git/service.ts` (spawns local CLIs against a real local checkout — a cloud
version is a sandboxed-compute product, not a port) · `models/local.ts` (local Ollama by
definition) · `workspace/watcher.ts` (chokidar — replaced by change events, not ported).

## The product decision

Three genuinely different things could be built on dhow.io. They are not phases of each
other; picking wrong wastes a year.

```
  A. HOSTED DHOW              B. AGENT PLATFORM          C. ACCOUNT + BROKER
     the desktop app             what apps/dhow              the server the desktop
     in a browser                already is                  app is already asking for

  Reuse:  ~15% of core       Reuse: ~90% of apps/dhow   Reuse: apps/dhow's shell,
          (runtime only)            (it IS the product)        packages/shared as-is
  Build:  storage rewrite    Build: modernize, sell     Build: OAuth broker, model
          for 79 files,             a product Dhow's            gateway, metering,
          sandboxed compute,        README doesn't               billing, accounts
          headless browser,         describe
          hosting for Apps
  Cost:   9-18 months        Cost: 3-4 months           Cost: 6-10 weeks to revenue
  Risk:   competes with      Risk: two unrelated        Risk: users may not pay for
          Cowork and Atlas         products, one team          convenience alone
          head-on
  Moat:   none new           Moat: none                 Moat: the desktop install base
                                                              and the OAuth verification
                                                              nobody else will bother with
```

**Recommendation: C, then A's collaboration slice.** Reasons, in order:

1. **The contract is already written.** `auth/repo.ts:29-30` specifies the broker's job in
   one sentence. `models/defaults.ts:49` specifies the gateway's. We are not designing an
   integration; we are implementing one the client already declares.
2. **It is on the critical path for work already planned.** The connectivity plan's item 2
   (ship a Microsoft client ID) and item 4 (the Gmail restricted-scope decision) both
   require a hosted entity that owns the OAuth registration. Building C *is* doing items
   2 and 4.
3. **It fixes the worst bug in the product.** The first button a new user presses throws.
   Today the only fix is deleting it. C makes it work instead.
4. **It is the only option with a moat.** Anthropic and OpenAI are absorbing the
   "AI desktop with memory" category into subscriptions users already pay for. What they
   will not do is act as the verified OAuth publisher for someone else's local-first
   client. That is unglamorous, annoying, expensive in calendar time, and therefore
   defensible.
5. **A and B stay open.** Nothing in C forecloses them; C builds the accounts, billing and
   metering that both would need anyway.

## Architecture

### Tenancy

**Introduce `Organization` as the tenant and billing boundary.** It does not exist today
and retrofitting it later is the single most expensive mistake available. The 2026
consensus is blunt: the tenant must be resolved before the first query hits the database,
and any code path where tenant context can be silently defaulted is a critical failure
mode.

```
  Organization  (tenant + billing boundary)   ← NEW
      │
      ├── Member (user × org, with role)      ← replaces flat ProjectMember
      ├── Subscription / usage ledger         ← NEW
      ├── OAuth grants (per member identity)  ← NEW
      └── Device (a desktop install, paired)  ← NEW
```

A solo user gets an implicit single-member org on signup. They never see the word
"organization" until they invite someone.

**Isolation model: pool by default, silo by tier.** Shared Mongo database, mandatory
`orgId` on every document, `orgId` as the shard key when sharding arrives. Reserve
database-per-tenant for enterprise contracts that pay for it. MongoDB's own guidance:
shared collections for an indefinitely growing tenant count; database-per-tenant only for
a small stable number (hundreds) with strict isolation needs, and never past ~10,000
collections per cluster.

**Enforce it in one place, not 61.** The existing `ProjectActionAuthorizationPolicy` is
the right shape and the right layer; generalize it to `TenantAuthorizationPolicy` and make
tenant scope a constructor-injected, non-optional argument to every repository, so a
missing filter is a type error rather than a leak. This is the single most important line
of defense and it is cheap because the pattern already exists.

**Qdrant.** Keep the single `"embeddings"` collection. Two required changes:
add `orgId` to the payload alongside `projectId`, and create the tenant payload index —
`is_tenant=true` on the tenant key, `payload_m: 16`, and `m: 0` in the HNSW config to
disable the global index. Skipping `is_tenant=true` kills sequential read performance;
the filter then runs *inside* HNSW traversal rather than after it, so a tenant-filtered
query is typically faster than an unfiltered one. If a tenant passes ~20K points,
Qdrant 1.16's tiered multitenancy promotes it to a dedicated shard inside the same
collection — the escape hatch is built in, so we do not need collection-per-tenant.

### The AI-specific isolation obligation

This is where an agent platform differs from ordinary SaaS, and it is worth stating
plainly because Dhow's own desktop build currently gets it wrong.

In classic SaaS a tenant-boundary failure returns the wrong data to the wrong requester —
bounded and usually detectable. In an agent platform the wrong data enters the agent's
reasoning chain and the agent then *acts on it through tool calls*. **The blast radius is
bounded only by what the agent's tools can reach.**

The desktop app demonstrates the failure mode concretely. A crafted email reaches an agent
prompt unsanitized (`runtime/tools/domains/app.ts:108-124`); `~/.dhow/config/**` sits
inside the workspace boundary so `permission-metadata.ts:112-117` returns `null` — no
permission — for reading it; OAuth refresh tokens there are plaintext
(`auth/repo.ts:211-213`); and `fetch-url` is `permission: "none"` with arbitrary URL,
method and body and no SSRF guard (`runtime/tools/domains/web.ts:125`). Background agents
run with `autoPermission: true, humanAvailable: false` hardcoded
(`runtime/assembly/headless.ts:158-159`).

Hosting that architecture multiplies it by the tenant count. So four rules are
non-negotiable in the server build, and all four should be back-ported to desktop:

1. **Credentials are never inside the agent's readable surface.** Separate namespace,
   separate permission class, no exceptions.
2. **Egress is allowlisted and per-tenant.** No unrestricted `fetch` tool. SSRF guard,
   domain policy, and the egress log is a billable, auditable event.
3. **Tool calls authenticate as the tenant**, via tenant-scoped credentials or a
   delegation token asserting tenant identity — never as the platform.
4. **Observability is a leakage vector, not just a control.** Agent logs carry reasoning
   chains, retrieved chunks and tool parameters. Tenant-tag and access-control them like
   tenant data, because they are.

### Model gateway

The `"dhow"` provider flavor needs a server. It is an OpenAI-compatible proxy that
authenticates the org's bearer token, applies plan-based model eligibility, enforces the
credit balance *before* the call, streams the response, and meters tokens after.

Desktop-side work is one `case "dhow"` in
`packages/core/src/models/models.ts:29-113` returning a gateway client pointed at
`https://api.dhow.io/v1` with the session bearer, plus a `dhow` entry in
`packages/core/src/auth/providers.ts:62-122`. Two small diffs against a type system that
already expects them.

Margin discipline: run cheap models by default. Frontier reasoning models run to ~$30 per
million input tokens; capable budget models are near $0.14 input / $0.28 output, with
cache-hit input around two orders of magnitude cheaper. Route by task, not by habit —
Dhow already has `taskModels` for exactly this (`CLAUDE.md:119-120`).

### Auth

Auth0 is already wired (`app/lib/auth0.ts:6-21`, v4, middleware, auto-provisioning at
`app/lib/auth.ts:35-59`). Keep it for v1 — replacing working auth to save money before
there is revenue is the wrong trade.

Revisit at the first enterprise deal. As of 2026 Auth0's self-service B2B tier includes
SSO, SCIM and one enterprise connection free to 25K MAU, with B2B Essentials at $150/mo
including three connections; WorkOS is per-connection ($125 at 1–15, tiering down) with
AuthKit free to 1M MAU but SCIM billed as a separate per-connection SKU, so 100
connections lands near $13k/mo for both; Clerk is $25/mo Pro with the first connection
included and $75 each for 2–15. The common 2026 trajectory is start managed, migrate to
Better Auth or Supabase Auth when MAU cost becomes a line item.

**Two things must be added to Auth0 now, not later:** the org claim in the JWT (tenant
resolved before the first query), and device pairing for desktop clients.

### Reuse and rebuild, honestly

| Component | Source | Decision | Cost |
|---|---|---|---|
| Zod schemas / shared types | `apps/x/packages/shared` | **Reuse as-is** — server-safe today, zero changes | hours |
| Clean-arch skeleton, DI, use-case + policy pattern | `apps/dhow/src` | **Reuse the pattern**, delete the RowBoat domain | days |
| Mongo repository layer | `apps/dhow/src/infrastructure` | **Reuse the shape**, new entities | days |
| Job queue (Mongo + Redis pub-sub) | `apps/dhow` workers | **Reuse** | days |
| Qdrant RAG pipeline | `rag-worker.ts` | **Reuse**, add `orgId` + tenant index | days |
| Auth0 integration | `app/lib/auth0.ts` | **Reuse**, add org claim | days |
| Rate limiting | `redis.usage-quota.policy.ts` | **Reuse** | hours |
| Billing client | `app/lib/billing.ts` | **Rewrite** — 13 endpoint semantics against Stripe | 2-3 weeks |
| Agent runtime | `apps/x/packages/core/runtime/turns` | **Extract + new Mongo `ITurnRepo`** | 1-2 weeks |
| `rowboat-shared` | `github:rowboatlabs/shared` | **Vendor** — 7 imports, pure zod | hours |
| Projects/workflows/copilot/widget | `apps/dhow` | **Delete** — wrong product | — |
| Twilio + widget routes | 9 × `501` stubs | **Delete** | hours |
| `apps/dhowx` | — | **Delete** | minutes |
| AI SDK v4 → v7 | `apps/dhow` | **Migrate** — two major rewrites | 1-2 weeks |
| Knowledge vault, Council, live notes | `apps/x/packages/core` | **Defer** — 79 files with no storage interface | months, later |
| Code Mode, meetings, built-in browser | `apps/x` | **Never** (as hosted) | — |

## Billing and pricing

**Hybrid: a small base subscription plus metered usage.** That is what most AI SaaS runs
in 2026, and pure subscription breaks under spiky agent usage while pure token billing is
unpredictable for both sides — which is why providers have been moving toward task quotas.

Sell **credits**, not tokens. Users cannot forecast tokens; they can forecast "500 assisted
emails." Meter tokens internally, display credits.

Stripe is the right choice and got materially better for this in March 2026: Stripe Billing
can now ingest token usage, map it to model pricing, compute the underlying cost, and apply
a markup before generating line items — so a 30% margin over raw model cost is
configuration rather than code, across multiple providers. Note the API change: the legacy
usage-records API is gone since `2025-03-31.basil` and every metered price now needs a
backing Meter. Aggregate usage in Redis and flush one event per minute rather than one per
action; Stripe Billing's ~100 req/s ceiling is the thing that breaks AI companies metering
per token. Metronome (now a Stripe product) is the upgrade path if that ceiling bites;
Solvimon is 0.4% of revenue with the first $3M free.

The existing `UsageItem` taxonomy in `billing_types.ts` is already the right shape and
should be kept: `LLM_USAGE{model, inputTokens, outputTokens, context}`,
`EMBEDDING_MODEL_USAGE`, `COMPOSIO_TOOL_USAGE`, `COMPOSIO_TRIGGER_USAGE`,
`FIRECRAWL_SCRAPE_USAGE`. Add `EGRESS_FETCH` — it is both a cost and a security signal.

Proposed shape, to be tested rather than believed:

| | Free | Personal | Team | Enterprise |
|---|---|---|---|---|
| Price | $0 | ~$20/mo | ~$40/user/mo | contract |
| Model access | BYOK only | Dhow gateway, credits included | + higher credits, pooled | + dedicated infra |
| OAuth broker (no client ID setup) | ✓ | ✓ | ✓ | ✓ |
| Web search without an Exa key | — | ✓ | ✓ | ✓ |
| Shared knowledge / shared Council | — | — | ✓ | ✓ |
| SSO / SCIM / audit log | — | — | — | ✓ |
| Isolation | pool | pool | pool | silo |

Free must include the OAuth broker. It is the entire adoption argument, and it costs
almost nothing to serve.

## Compliance

Two separate tracks, different triggers, do not conflate them.

**Google restricted scopes / CASA.** The connectivity plan's item 4 already scopes this:
`gmail.modify` or `gmail.readonly` are restricted, requiring an annual CASA Tier 2
assessment at roughly $540–$1,000/year self-serve, recertified every 12 months. It also
correctly identifies why CASA applies — restricted data transits third-party servers,
because Dhow sends message content to Anthropic, OpenAI, Google or OpenRouter.

**One prerequisite that plan does not list, and it is disqualifying as written.** A CASA
Tier 2 review examines credential storage and data-egress controls. Today Dhow stores Gmail
refresh tokens in plaintext (`auth/repo.ts:211-213`), lets any agent read them with no
permission check (`permission-metadata.ts:112-117`), and ships an unrestricted egress tool
(`web.ts:125`) reachable from an email-triggered background agent with no human in the loop
(`headless.ts:158-159`). Submitting before fixing that is paying to be told so. It also
makes the privacy policy — which that plan correctly calls the load-bearing artifact —
impossible to write truthfully, because no policy language covers an unbounded `fetch`
egress path.

Sequencing consequence: **the desktop security fixes are a prerequisite for the Google
path, not parallel to it.**

**SOC 2.** Not now. Trigger it 3–6 months before the first real enterprise deal, not
before. Reality check: 85% of enterprise buyers require a SOC 2 report before signing; the
observation window is 3–12 months with 6–15 months start-to-report; first-year all-in for
an AI startup is typically $40k–$120k, with internal labor around 65% of the spend;
automation platforms run $7.5k–$20k/year at startup tier (Drata's observed floor is lower
than Vanta's). AI-specific evidence auditors now ask for first: model lineage, prompt and
inference logs with PII redacted *before* logging, drift monitoring, and a vendor risk
assessment for every third-party LLM called. Design the logging pipeline for that on day
one — retrofitting redaction into an existing log store is the expensive version.

## Work

### 1. Foundation — dhow.io exists

Homepage, privacy policy, terms of service, domain verification in Google Search Console.
This is item 3 of the connectivity plan; it is also the front door of the SaaS and the
legal entity behind every OAuth consent screen. Free, and it blocks Google, Microsoft
publisher verification, and any billing at all.

The privacy policy must describe the model-provider data flow truthfully, which means the
egress path has to be bounded first (item 2).

Acceptance: three pages live; domain verified; Google brand verification passes.

### 2. Desktop security prerequisites

Not optional, and not really part of the SaaS — but the SaaS cannot ship honestly without
them, and CASA cannot be attempted at all.

- `~/.dhow/config/**` moves outside the agent-readable workspace boundary
  (`runtime/assembly/permission-metadata.ts`).
- `fetch-url` loses `permission: "none"`, gains an SSRF guard and a domain policy
  (`runtime/tools/domains/web.ts:125`).
- OAuth tokens and provider keys route through the existing `auth/secret-cipher.ts`
  (already correct for IMAP; unused for everything else).
- Shell execution moves from a shell-string `exec` to argv `execFile`, and `find`, `awk`,
  `env`, `printenv` leave the default allowlist (`config/security.ts:8-43`,
  `application/lib/command-executor.ts:92-97`).

Acceptance: an email cannot cause a background agent to read a credential file, and cannot
cause an outbound request to an unlisted domain. Both proven by a test.

### 3. Repository surgery

Delete `apps/dhowx` (orphaned, calls endpoints that do not exist). Delete the 9 `501`
route stubs. Vendor `rowboat-shared` into the tree and drop the `github:rowboatlabs/shared`
dependency. Give `apps/dhow` a CI job — it currently has none, and everything below lands
in it.

Acceptance: `npm install` reaches no third-party GitHub org; CI runs typecheck and lint on
`apps/dhow`.

### 4. Modernize the shell

Next 15.3.8 → 16.x. AI SDK v4 → v7 (two major generations; this is the real work).
Replace HeroUI beta. ESLint 8 → 9.

Do this *before* building on top, not after. Every feature written against `ai@4` is
migration debt.

Acceptance: clean build, no beta dependencies in the UI layer.

### 5. Organizations and the tenant boundary

New `Organization`, `Member`, `Device` entities. `orgId` mandatory on every document and
every Qdrant payload. `ProjectActionAuthorizationPolicy` generalizes to a tenant policy
with the scope injected, not passed. Org claim in the Auth0 JWT. Qdrant tenant payload
index (`is_tenant=true`, `payload_m: 16`, `m: 0`).

Acceptance: a repository method that omits the tenant filter fails to compile. A test
proves org A cannot read org B through any use-case, including the RAG path.

### 6. The OAuth broker — the wedge

Google and Microsoft app registrations owned by dhow.io. `/oauth/authorize` and
`/oauth/refresh` endpoints. The desktop app gets a `dhow` entry in
`packages/core/src/auth/providers.ts` and mode `dhow` finally means something. Client
secret never leaves the server; tokens stay local on the desktop; refresh goes through the
API — exactly as `auth/repo.ts:29-30` already specifies.

Ship Microsoft first: personal Outlook.com accounts consent normally, `Mail.ReadWrite` only
needs admin approval on work and school tenants, and it needs no CASA. Gmail follows the
item-4 decision.

Acceptance: a clean desktop install connects Outlook with no client ID prompt, no Azure
portal, and no console.

### 7. The model gateway

`api.dhow.io/v1`, OpenAI-compatible, bearer-authenticated. Plan-based model eligibility.
Credit check before the call, token metering after. `case "dhow"` lands in
`packages/core/src/models/models.ts`.

Acceptance: "Sign in with Dhow" on `welcome-step.tsx:77-91` completes and the assistant
answers, with no API key anywhere. That button has never worked.

### 8. Metering and billing

Stripe with the March 2026 token-billing features. Redis usage aggregation flushed on an
interval, not per event. Credits UI. Customer portal. Plan gating.

Rewrite `app/lib/billing.ts` in place — the ~10 function signatures stay, the bodies
become Stripe calls, and the 20+ call sites do not change.

Acceptance: a user can subscribe, spend credits, see a truthful balance, and cancel,
without support intervention.

### 9. Team layer

Invitations, roles, pooled credits, shared Council, shared knowledge. This is where Team
pricing earns its price and where the desktop app stops being single-player.

Requires the shared-knowledge storage question to be answered — Council persists to plain
Markdown by explicit design (`council/store.ts:14-27`) and a shared Council needs a
database without abandoning "your data is a file you can read."

Acceptance: two users in one org see the same Council session and the same shared notes.

### 10. Hosted surfaces — only on evidence

A browser view of the knowledge graph, then read-only mail triage. Only after paying
users ask for it. This is where option A creeps back in, one lake at a time, paid for by
revenue from C.

## Sequence

1. dhow.io foundation (item 1) — free, unblocks everything, parallel with item 2
2. Desktop security prerequisites (item 2) — gates the privacy policy and CASA
3. Repository surgery (item 3) — cheap, removes noise before real work lands
4. Modernize the shell (item 4) — before building on it, not after
5. Organizations and tenant boundary (item 5) — the one thing that must not be retrofitted
6. OAuth broker (item 6) — first user-visible win; delivers connectivity-plan item 2
7. Model gateway (item 7) — makes the broken button work
8. Metering and billing (item 8) — first revenue
9. Team layer (item 9)
10. Hosted surfaces (item 10) — on evidence only

Items 1–8 are the minimum viable business. Estimate 6–10 weeks with AI-assisted
implementation, dominated by items 4, 5 and 8.

## Risks

- **Users may not pay for convenience alone.** The whole thesis of option C is that OAuth
  and model setup friction is worth $20/mo. Untested. Cheapest test: ship item 6 free,
  measure how many desktop users sign in when they do not have to.
- **The upstream fork keeps diverging.** `rowboatlabs/rowboat` is 27 commits ahead with a
  56-file overlap against files we have already renamed, including `App.tsx`, `ipc.ts`,
  `main.ts`. Every week raises the merge cost. Decide explicitly: merge now, or announce a
  clean divorce. Keeping `apps/dhow` means keeping the collision surface too.
- **Becoming a model reseller means owning model margin.** Gateway users spend Dhow's money.
  Hard credit caps before the call, not after, and cheap-model-by-default routing.
- **Hosting mail content changes the threat model completely.** Desktop is local-first, so
  a breach is one machine. The gateway sees prompt content in transit. Zero-retention terms
  with providers are a prerequisite, not a nice-to-have — and the connectivity plan already
  identifies this as gating the entire Google path.
- **One maintainer, two products.** Desktop plus SaaS plus a fast-moving upstream. Item 3
  exists partly to reduce surface for this reason.

## Open questions

- Which model providers ship by default in the gateway, and do they offer zero-retention
  terms? This gates both the Google path and the privacy policy. (Same question as
  connectivity-plan item 4 — answer it once.)
- Is the desktop install base large enough that a free hosted OAuth broker produces
  measurable sign-ins? If not, the wedge does not exist and option C needs rethinking.
- Does a shared Council keep the plain-Markdown promise, or does hosted mean "a database
  with an export button"? This is a product-values decision, not a technical one.
- Credits or seats for Team? Pooled credits are friendlier; seats are more predictable
  revenue.
- Does anything currently run `apps/dhow` via `docker-compose`? If a real deployment exists
  somewhere, item 3's deletions need scoping first.
