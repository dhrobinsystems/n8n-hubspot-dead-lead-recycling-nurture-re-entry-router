# n8n-hubspot-dead-lead-recycling-nurture-re-entry-router

**An n8n engine that gives closed-lost and disqualified leads a second chance, safely.** Every day it finds HubSpot contacts on **closed-lost deals** or with a **disqualified lead status**. It waits until a **120-day cooling-off period** has passed since the *latest* touch, then removes everyone who must never be re-contacted. Next it **re-verifies email validity and the current job title** through a provider-agnostic enrichment adapter. Finally it **routes qualified prospects back into a targeted outbound sequence or a nurture track**.

```
closed-lost deals (closed ≥ 120 d ago) ─┐
                                        ├─► candidates ─► cooling-off clock (latest touch + 120 d)
disqualified lead statuses ─────────────┘                    │
                                                             ▼
               hard suppressions (unsubscribed · bounced · open deal · do-not-contact · customer · cap)
                                                             ▼
                  re-verify email + job title (enrichment adapter, credit-capped)
                                                             ▼
        OUTBOUND sequence ◄── senior title · verified email · lost reason allows ──► NURTURE list / workflow
                                                             ▼
                   recycle_* stamps on the contact (only when something changed)
```

> **Safe by default.** Out of the box the workflow runs in `SANDBOX_MODE=true` against a synthetic fixture: **zero** network calls, nothing stamped, enrolled or listed, no enrichment credits spent. Going live is staged, and each side effect has its own switch: contact stamps (`HUBSPOT_WRITES_ENABLED`), sequence enrollment (`SEQUENCE_ENROLLMENT_ENABLED`), nurture routing (`NURTURE_ROUTING_ENABLED`) and enrichment calls (`ENRICHMENT_ENABLED`).

---

## Contents

- [How a contact is decided](#how-a-contact-is-decided)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [HubSpot setup](#hubspot-setup)
- [Quick start (sandbox, 2 minutes)](#quick-start-sandbox-2-minutes)
- [Execution steps: going live](#execution-steps-going-live)
- [Environment variables](#environment-variables)
- [Cooling-off calculation](#cooling-off-calculation)
- [Re-verification adapter](#re-verification-adapter)
- [Re-entry routing](#re-entry-routing)
- [Contact stamps and idempotency](#contact-stamps-and-idempotency)
- [Error handling](#error-handling)
- [Offline simulator](#offline-simulator)
- [Troubleshooting](#troubleshooting)
- [Repository layout](#repository-layout)
- [Disclaimer](#️-disclaimer--liability-limitation)

---

## How a contact is decided

Checks run in this order. The first match decides.

| # | Check | Decision |
|---|---|---|
| 1 | No email · unsubscribed from all email · HubSpot hard bounce / invalid / quarantined address | `SUPPRESS` |
| 2 | `recycle_status = DO_NOT_RECYCLE` (set by people; never overwritten) | `SUPPRESS` |
| 3 | Lifecycle stage in `EXCLUDE_LIFECYCLE_STAGES` (customer, evangelist) | `SUPPRESS` |
| 4 | Any associated deal still open | `SUPPRESS` (`OPEN_DEAL`) |
| 5 | A lost reason matches `EXCLUDE_LOST_REASONS_REGEX` (do not contact, legal, fraud, …) | `SUPPRESS` |
| 6 | Already recycled `MAX_RECYCLES` times | `SUPPRESS` |
| 7 | No reference date at all | `HOLD` (`NO_REFERENCE_DATE`) |
| 8 | Fewer than `COOLING_OFF_DAYS` since the latest touch | `COOLING` (with `recycle_eligible_on`) |
| 9 | Verified less than `REEVALUATION_INTERVAL_DAYS` ago (unless a retryable hold) | `SKIP` |
| 10 | Re-verification: email invalid · person left the company · excluded title | `SUPPRESS` |
| 11 | Enrichment failed · risky email | `HOLD` |
| 12 | Senior title + verified email + lost reason not nurture-only + sequence + sender | `OUTBOUND` |
| 13 | Target persona with a clean email | `NURTURE` |
| 14 | Otherwise | `SUPPRESS` (`OFF_PERSONA`) |

Per-run caps (outbound per run and per owner, nurture per run, enrichments per run) defer the overflow to the next run, longest-cooled first.

---

## Architecture

![Workflow Overview](./workflow-overview.png)

```mermaid
flowchart TD
    T1[Manual Test Trigger] --> CFG
    T2[Daily Recycle Run 06:41] --> CFG
    CFG[Config & Safety Gate<br/>cooling window · rules · adapter · targets · gates] --> SB{Sandbox Mode?}
    SB -- yes --> FX[Load Synthetic Recycle Fixture] --> AS
    SB -- no --> SD[HubSpot: Search Closed-Lost Deals<br/>closedate ≤ cutoff, ≥ lookback]
    SD --> CD[Collect Deals & Build Association Reads] --> DN{Deal Contacts Needed?}
    DN -- yes --> RD[HubSpot: Read Deal Contacts] --> CDC
    DN -- no --> CDC[Collect Deal Contacts]
    CDC --> SQ[HubSpot: Search Disqualified Contacts] --> CC[Collect Candidates & Build Contact Reads]
    CC --> CF{Candidates Found?}
    CF -- yes --> RC[HubSpot: Read Contacts & Deal Links] --> CCD[Collect Contacts & Build Deal Reads]
    CCD --> DRN{Deal Reads Needed?}
    DRN -- yes --> BD[HubSpot: Batch Read Associated Deals] --> AS
    DRN -- no --> AS
    CF -- no --> AS[Assemble Candidates]
    AS --> EV[Evaluate Cooling-Off & Suppression] --> BE[Build Enrichment Requests]
    BE --> EN{Enrichment Needed?}
    EN -- yes --> SE{Sandbox Enrichment?}
    SE -- yes --> SIM[Simulated Enrichment] --> RT
    SE -- no --> API[Enrichment API: Verify Contact] --> RT
    EN -- no --> RT[Route Re-Entry<br/>OUTBOUND · NURTURE · SUPPRESS · HOLD · caps]
    RT --> WA{Writes Allowed?}
    WA -- no --> DR[Dry-Run Routing Report] --> RP
    WA -- yes --> EC[Build Enrollment Checks] --> ECN{Enrollment Checks Needed?}
    ECN -- yes --> CK[HubSpot: Check Active Enrollment] --> BS
    ECN -- no --> BS[Build Sequence Enrollments]
    BS --> ENN{Enrollments Needed?}
    ENN -- yes --> ES[HubSpot: Enroll in Sequence<br/>no retry] --> BU
    ENN -- no --> BU[Build Contact Updates]
    BU --> UN{Updates Needed?}
    UN -- yes --> UP[HubSpot: Update Contacts & Nurture List] --> RP
    UN -- no --> RP[Recycle Run Report]
```

38 nodes: 2 triggers, 1 sticky note, 16 Code nodes, 10 IF nodes and 9 HTTP Request nodes. Discovery is read-only, and there are exactly three write nodes: sequence enrollment, contact batch update, and static-list membership (the last two share one HTTP node).

---

## Prerequisites

- **n8n** 1.x or later (tested on n8n 2.47.7, self-hosted). Core nodes only; no community nodes and no stored n8n credentials.
- `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`, so `{{ $env.X }}` resolves. If env access is blocked, the workflow stays in sandbox mode.
- **HubSpot private app** with these scopes:

| Scope | Needed for |
|---|---|
| `crm.objects.contacts.read`, `crm.objects.deals.read` | Discovery (searches, batch reads, associations) |
| `crm.objects.contacts.write` | `recycle_*` stamps (`HUBSPOT_WRITES_ENABLED`) |
| `automation.sequences.read`, `automation.sequences.enrollments.write` | Active-enrollment check and enrollment (`SEQUENCE_ENROLLMENT_ENABLED`) |
| `crm.lists.read`, `crm.lists.write` | Adding nurture contacts to a static list (`NURTURE_LIST_ID`) |

- **Sequences:** sequence enrollment needs a HubSpot plan that includes sequences. Each sender must be a HubSpot user with a connected inbox: the `senderEmail` in `OWNER_SENDER_MAP_JSON` / `DEFAULT_SENDER_EMAIL` must be a connected address.
- **An enrichment / email-verification provider** (optional). Any HTTP API that can verify an email and return the current title works through the [adapter](#re-verification-adapter). Without one, the router screens emails with HubSpot's own bounce and opt-out signals only.
- **A HubSpot sandbox or developer test account** for rehearsal.

---

## HubSpot setup

### 1. Custom contact properties

| Internal name | Type | Written by the router |
|---|---|---|
| `recycle_status` | Single-line text (or dropdown) | `RECYCLED_OUTBOUND`, `RECYCLED_NURTURE`, `ELIGIBLE_OUTBOUND`, `ELIGIBLE_NURTURE`, `IN_ACTIVE_SEQUENCE`, `COOLING`, `SUPPRESSED`, `HOLD`, `DEFERRED`. **`DO_NOT_RECYCLE` is set by people and is never overwritten.** |
| `recycle_reason` | Single-line text | The deciding reason code |
| `recycle_route` | Single-line text (or dropdown: `SEQUENCE`, `NURTURE`) | Set when routed |
| `recycle_count` | Number | +1 per routing |
| `recycle_last_routed_at` | Date picker / datetime | When routed (also restarts the cooling-off clock) |
| `recycle_last_evaluated_at` | Datetime | When last re-verified |
| `recycle_eligible_on` | Date | Cooling-off end date |
| `recycle_email_status` | Single-line text | `VALID`, `INVALID`, `RISKY`, `UNKNOWN`, `UNVERIFIED` |
| `recycle_disqualified_at` | Datetime | **Your** process sets this when a lead is disqualified (the clock for disqualified leads; see `DISQUALIFIED_DATE_PROPERTY`) |

```bash
# Example: create recycle_status (repeat for each property; use a contact property group of your choice)
curl -X POST "https://api.hubapi.com/crm/v3/properties/contacts" \
  -H "Authorization: Bearer your_hubspot_private_app_token_here" \
  -H "Content-Type: application/json" \
  -d '{"name":"recycle_status","label":"Recycle status","type":"string","fieldType":"text","groupName":"contactinformation"}'
```

### 2. Re-entry targets

- **Outbound:** create one sequence for recycled closed-lost contacts and one for recycled disqualified contacts. Copy their IDs into `SEQUENCE_MAP_JSON`. Map contact owners to sender user IDs and connected inboxes in `OWNER_SENDER_MAP_JSON`, with an optional default sender for unowned contacts.
- **Nurture:** create a contact workflow triggered by **`recycle_route` is `NURTURE`** (and/or membership of a static list, `NURTURE_LIST_ID`) that enrolls the contact in your nurture emails. The router never sends marketing email itself.

---

## Quick start (sandbox, 2 minutes)

```bash
# 1. Run the offline simulator. Zero dependencies, zero network.
node scripts/simulate-sandbox-run.js
#    → 102 checks; routing report and run reports in sim-output/

# 2. Import into n8n
#    Workflows → Import from File → workflow.json  (arrives inactive)

# 3. Click "Test workflow" on the Manual Test Trigger and open "Dry-Run Routing Report".
```

The fixture is fully synthetic: fictitious people at `example.com`, placeholder IDs, and dates stored relative to *now* so results don't drift. Its 26 contacts on 10 deals cover every path:

| Contact | Scenario | Decision |
|---|---|---|
| 51000001 | Lost 150 d ago (budget), contacted 140 d ago, VP | `OUTBOUND` closed-lost sequence |
| 51000002 | Same deal, Marketing Manager | `NURTURE` |
| 51000003 / 51000008 | Lost only 60 d ago / 1000 d ago | not in the population |
| 51000004 | Lost to a competitor, Director | `NURTURE` (nurture-only lost reason) |
| 51000005 | Lost reason "Do not contact – legal" | `SUPPRESS` |
| 51000006 | Has an open deal | `SUPPRESS` |
| 51000007 | Contacted 30 d ago | `COOLING`, eligible in 90 days |
| 51000009 | Enrichment: left the company | `SUPPRESS` (job changer report) |
| 51000010 | Enrichment: undeliverable | `SUPPRESS` |
| 51000011 / 51000012 | Unsubscribed / hard bounce in HubSpot | `SUPPRESS` |
| 51000013 | Customer | `SUPPRESS` |
| 51000014 | Disqualified 200 d ago, Founder | `OUTBOUND` disqualified sequence |
| 51000015 | Student | `SUPPRESS` |
| 51000016 | No reference date | `HOLD` |
| 51000017 | Enrichment timeout | `HOLD`, retried next run |
| 51000018 | Recycled twice already | `SUPPRESS` |
| 51000019 | Verified 10 d ago | `SKIP` |
| 51000020 | Office Assistant | `SUPPRESS` (off persona) |
| 51000021 | Catch-all email | `HOLD` (risky) |
| 51000022 | `DO_NOT_RECYCLE` | `SUPPRESS` |
| 51000023 | Title changed to VP Growth | `OUTBOUND`, `JOB_TITLE_CHANGED` |
| 51000024 | Recycled to nurture 100 d ago | `COOLING` (clock from last recycle) |
| 51000025 | No owner, Director of IT | `OUTBOUND` via the default sender (already in a rep's sequence in live tests) |
| 51000026 | No email | `SUPPRESS` |

Sandbox result: 4 outbound, 2 nurture, 12 suppressed, 2 cooling, 3 held, 1 skipped.

> In sandbox only, the fixture's example sequences, senders and nurture list stand in for `SEQUENCE_MAP_JSON`, `OWNER_SENDER_MAP_JSON`, `DEFAULT_SENDER_*` and `NURTURE_LIST_ID` when those aren't set. Enrichment is always simulated in sandbox.

---

## Execution steps: going live

| Step | Set | What happens |
|---|---|---|
| 1. Sandbox | *(nothing)* | Read the routing report and tune the rules. |
| 2. Live dry run | `SANDBOX_MODE=false`, `HUBSPOT_PRIVATE_APP_TOKEN` | Read-only discovery against your portal. Decisions use HubSpot signals only (`UNVERIFIED`). Nothing is written. |
| 3. Dry run with verification | `ENRICHMENT_MODE=http`, `ENRICHMENT_ENABLED=true`, `ENRICHMENT_API_KEY`, `ENRICHMENT_API_URL` | Real re-verification (spends credits, capped by `ENRICHMENT_MAX_PER_RUN`); still nothing written. |
| 4. Stamps only | `DRY_RUN=false`, `HUBSPOT_WRITES_ENABLED=true` | `recycle_*` properties written (`ELIGIBLE_*`, `COOLING`, `SUPPRESSED`, …). Build HubSpot views and review. |
| 5. Nurture | `NURTURE_ROUTING_ENABLED=true` (+ `NURTURE_LIST_ID`) | Nurture contacts are marked `RECYCLED_NURTURE` / `recycle_route=NURTURE`, so your workflow takes over. |
| 6. Outbound | `SEQUENCE_ENROLLMENT_ENABLED=true` with low `MAX_OUTBOUND_PER_RUN` / `MAX_OUTBOUND_PER_OWNER` | Sequence enrollments; reps see recycled leads in their task queue. |
| 7. Schedule | Activate the workflow | Daily at 06:41. |

### Sample `.env` for step 6

```bash
SANDBOX_MODE=false
DRY_RUN=false
HUBSPOT_WRITES_ENABLED=true
NURTURE_ROUTING_ENABLED=true
SEQUENCE_ENROLLMENT_ENABLED=true
HUBSPOT_PRIVATE_APP_TOKEN=your_hubspot_private_app_token_here
ENRICHMENT_MODE=http
ENRICHMENT_ENABLED=true
ENRICHMENT_API_KEY=your_enrichment_api_key_here
ENRICHMENT_API_URL=https://enrichment.example.com/v1/verify
ENRICHMENT_ALLOWED_HOSTS=enrichment.example.com
SEQUENCE_MAP_JSON={"CLOSED_LOST":"10000001","DISQUALIFIED":"10000002"}
OWNER_SENDER_MAP_JSON={"20000001":{"userId":"30000001","senderEmail":"rep.one@example.com"}}
NURTURE_LIST_ID=40000001
MAX_OUTBOUND_PER_RUN=20
MAX_OUTBOUND_PER_OWNER=5
```

---

## Environment variables

All values are read only from `$env`. The complete template with placeholders and safe defaults is in [.env.example](.env.example).

### Safety switches

| Variable | Default | Turns on/off when | Effect |
|---|---|---|---|
| `SANDBOX_MODE` | `true` | *off* only on `false/0/no/off` | Synthetic fixture, zero network calls |
| `DRY_RUN` | `true` | *off* only on `false/0/no/off` | Routing report only |
| `HUBSPOT_WRITES_ENABLED` | `false` | `true/1/yes/on` | `recycle_*` stamps (required by the next two) |
| `SEQUENCE_ENROLLMENT_ENABLED` | `false` | `true/1/yes/on` | Sequence enrollments |
| `NURTURE_ROUTING_ENABLED` | `false` | `true/1/yes/on` | Nurture route stamp + static list add |
| `ENRICHMENT_ENABLED` | `false` | `true/1/yes/on` | Enrichment API calls (also in a live dry run) |

A typo (for example `DRY_RUN=flase`) keeps the safe value.

### Cooling-off, population and rules

| Variable | Default | Notes |
|---|---|---|
| `COOLING_OFF_DAYS` | `120` | Days since the latest touch. |
| `LOOKBACK_DAYS` | `730` | Closed-lost deals with `closedate` between `now − 120 − 730` and `now − 120` days. |
| `REEVALUATION_INTERVAL_DAYS` | `30` | Minimum gap between verifications of one contact. |
| `MAX_RECYCLES` | `2` | Lifetime cap. |
| `CLOSED_LOST_STAGES` | `closedlost` | Deal stage internal IDs (every pipeline's lost stage); `none` disables. |
| `DISQUALIFIED_LEAD_STATUSES` | `UNQUALIFIED,BAD_TIMING` | `hs_lead_status` values; `none` disables. |
| `DISQUALIFIED_DATE_PROPERTY` | `recycle_disqualified_at` | Date the lead was disqualified. |
| `EXCLUDE_LIFECYCLE_STAGES` | `customer,evangelist` | Never recycled; `none` disables. |
| `EXCLUDE_LOST_REASONS_REGEX` | do not contact · legal · fraud · spam · bankrupt · out of business | Matched against `closed_lost_reason`. |
| `NURTURE_ONLY_LOST_REASONS_REGEX` | competitor · went with · chose · signed with · multi-year | These losses are nurtured, never sequenced. |
| `OUTBOUND_TITLE_REGEX` | chief · CxO · VP · head of · director · founder · owner · president · partner | Seniority for outbound. |
| `TARGET_TITLE_REGEX` | manager · lead · director · … · engineer | Persona for nurture; `none` = everyone. |
| `EXCLUDE_TITLE_REGEX` | student · intern · retired · unemployed · freelance · job seeker | Suppressed. |
| `REQUIRE_VERIFIED_EMAIL_FOR_OUTBOUND` | `true` | Outbound only to re-verified `VALID` emails. |
| `NURTURE_ALLOW_RISKY` | `false` | Allow `RISKY` / `UNKNOWN` emails into nurture. |
| `UPDATE_JOB_TITLE` | `false` | Overwrite `jobtitle` with the verified title. |
| `SET_LEAD_STATUS_ON_ROUTE` | *(empty)* | e.g. `OPEN` to reopen routed leads. |

All regexes are case-insensitive and validated: up to 400 characters, no nested quantifiers and no backreferences (a ReDoS guard).

### Enrichment adapter, targets and caps

| Variable | Default | Notes |
|---|---|---|
| `ENRICHMENT_MODE` | `none` | `none` (HubSpot signals only) or `http`. |
| `ENRICHMENT_API_KEY` | `your_enrichment_api_key_here` | Secret; header only. |
| `ENRICHMENT_API_URL` / `ENRICHMENT_ALLOWED_HOSTS` | placeholder / `enrichment.example.com` | https; host allowlisted; no query string (keys never go in URLs). |
| `ENRICHMENT_AUTH_HEADER` / `ENRICHMENT_AUTH_PREFIX` | `Authorization` / `Bearer` | e.g. `X-API-Key` + `none`. |
| `ENRICHMENT_RESPONSE_MAP_JSON` | `email_status`, `job_title`, `company`, `still_at_company` | Dotted paths into the provider response. |
| `ENRICHMENT_EMAIL_STATUS_MAP_JSON` | valid / deliverable / ok → VALID; invalid / undeliverable / bounced → INVALID; risky / catch_all / accept_all → RISKY; unknown → UNKNOWN | Merged with your entries. |
| `ENRICHMENT_SEND_NAME` | `true` | `false` sends only email, company and title. |
| `ENRICHMENT_MAX_PER_RUN` / `ENRICHMENT_TIMEOUT_MS` | `200` / `15000` | Credit and latency guards. |
| `SEQUENCE_MAP_JSON` | placeholder | `{"CLOSED_LOST":"<id>","DISQUALIFIED":"<id>"}` |
| `OWNER_SENDER_MAP_JSON` | placeholder | `{"<owner id>":{"userId":"<user id>","senderEmail":"<connected inbox>"}}` |
| `DEFAULT_SENDER_USER_ID` / `DEFAULT_SENDER_EMAIL` | *(empty)* | Fallback sender (both or neither). |
| `NURTURE_LIST_ID` | *(empty)* | Static list for nurture re-entry. |
| `MAX_OUTBOUND_PER_RUN` / `MAX_OUTBOUND_PER_OWNER` / `MAX_NURTURE_PER_RUN` | `50` / `15` / `500` | Overflow → `DEFERRED` (next run). |
| `HUBSPOT_API_BASE_URL` / `HUBSPOT_ALLOWED_HOSTS` | `https://api.hubapi.com` / `api.hubapi.com,api-eu1.hubapi.com` | |
| `NOW_OVERRIDE` | — | Pins "now" for reproducible tests. |

---

## Cooling-off calculation

```
clockStart  = max( latest closed-lost closedate,
                   DISQUALIFIED_DATE_PROPERTY,          (disqualified leads)
                   notes_last_contacted,                 (Last contacted)
                   hs_last_sales_activity_timestamp,
                   hs_sales_email_last_replied,
                   recycle_last_routed_at )              (previous recycle)
eligibleOn  = clockStart + COOLING_OFF_DAYS
eligible    = now ≥ eligibleOn
```

- **Any newer touch restarts the clock.** A lead lost 150 days ago but called 30 days ago waits another 90 days.
- **A recycle restarts the clock too,** so a contact routed today can't be routed again for another cooling-off period. `MAX_RECYCLES` caps the lifetime total.
- **The deal search is narrowed server-side** (`closedate ≤ now − 120 d` and `≥ now − 120 d − LOOKBACK_DAYS`). The clock is still computed per contact, across *all* of their touches.
- **Dates are parsed defensively** (ISO, date-only, or epoch ms; anything before 1990 or in the future is ignored). A disqualified contact with no usable date is held (`NO_REFERENCE_DATE`) rather than guessed.

---

## Re-verification adapter

For every cooled-off, unsuppressed contact (up to `ENRICHMENT_MAX_PER_RUN`, longest-cooled first), the workflow sends:

```http
POST ENRICHMENT_API_URL
Authorization: Bearer <ENRICHMENT_API_KEY>        (header and prefix configurable)
Content-Type: application/json

{ "email": "…", "firstName": "…", "lastName": "…", "company": "…", "jobTitle": "…" }
```

It expects a JSON response. `ENRICHMENT_RESPONSE_MAP_JSON` maps four values out of it, so most email-verification and enrichment APIs fit through the mapping alone or with a tiny proxy:

| Mapped value | Used for |
|---|---|
| `emailStatus` | Normalized to `VALID` / `INVALID` / `RISKY` / `UNKNOWN` via `ENRICHMENT_EMAIL_STATUS_MAP_JSON` |
| `jobTitle` | Title re-check (`JOB_TITLE_CHANGED`; optional `jobtitle` update) |
| `company` | `COMPANY_CHANGED` flag |
| `stillAtCompany` | `false` → `SUPPRESS LEFT_COMPANY`, listed under `jobChangers` |

- A failed or timed-out call (retried once) becomes `HOLD ENRICHMENT_FAILED`. Nobody is routed on missing data, and the contact is retried on the next run.
- Only the fields above leave HubSpot. `ENRICHMENT_SEND_NAME=false` drops the names too.

---

## Re-entry routing

| Route | Requirements | What happens (when its switch is on) |
|---|---|---|
| **OUTBOUND** | Title matches `OUTBOUND_TITLE_REGEX` · email `VALID` (or `UNVERIFIED` if `REQUIRE_VERIFIED_EMAIL_FOR_OUTBOUND=false`) · no nurture-only lost reason · a sequence for the source (`CLOSED_LOST` / `DISQUALIFIED`) · a sender for the owner (or the default sender) | `GET /automation/v4/sequences/enrollments/contact/{id}` first: an active enrollment means `IN_ACTIVE_SEQUENCE` (never double-enrolled). Otherwise `POST /automation/v4/sequences/enrollments?userId=<sender>` with `{contactId, sequenceId, senderEmail}`, **no automatic retry**. Then `RECYCLED_OUTBOUND`. |
| **NURTURE** | Persona match (`TARGET_TITLE_REGEX`, or senior) · email `VALID` / `UNVERIFIED` (`RISKY` / `UNKNOWN` only with `NURTURE_ALLOW_RISKY`) | `recycle_route=NURTURE`, `RECYCLED_NURTURE`; added to `NURTURE_LIST_ID` via `PUT /crm/v3/lists/{id}/memberships/add`. Your HubSpot workflow sends the nurture. |

Outbound-qualified contacts without a sequence or sender fall back to nurture (`OUTBOUND_UNAVAILABLE` / `NO_SENDER_FOR_OWNER`). When a route's switch is off, the contact is stamped `ELIGIBLE_OUTBOUND` / `ELIGIBLE_NURTURE` (not counted as recycled), so you can review it in HubSpot first.

---

## Contact stamps and idempotency

- **Write only on change.** A contact is written only when its status, reason, eligible-on date or email status changed, or it was verified or routed this run. Daily runs don't churn records or the property history.
- **Recycled stays recycled.** A routed contact keeps `RECYCLED_*` while its next cooling-off period runs.
- **No double sends.** Re-runs never enroll twice (active-enrollment check plus the recycle clock), and adding a contact to a list twice is a no-op.
- **People win.** `DO_NOT_RECYCLE` is never overwritten.
- **Retries are targeted.** Only transient holds (`ENRICHMENT_FAILED`, `ENROLLMENT_FAILED`, `ENROLLMENT_CHECK_FAILED`) and cap deferrals bypass `REEVALUATION_INTERVAL_DAYS`. A risky email isn't re-verified (and paid for) every day.
- **Order of side effects.** Check, then enroll, then stamp. If the stamp fails after an enrollment, the next run's active-enrollment check prevents a second enrollment.

---

## Error handling

| Failure | Behavior |
|---|---|
| Any discovery call fails (after 3 tries) or a page is malformed | Run stops before verification or any write. |
| HubSpot reports ≥ 10,000 search matches, or pagination stops early | Run stops (narrow `LOOKBACK_DAYS` / statuses). |
| Batch-read response count mismatch | Run stops. |
| Enrichment call fails / times out | Contact `HOLD ENRICHMENT_FAILED`; retried next run. |
| Enrollment check fails | Contact `HOLD`; not enrolled. |
| Enrollment rejected (for example, inbox not connected) | Contact `HOLD ENROLLMENT_FAILED`; run `PARTIAL`; retried next run. |
| Contact update / list add fails (after 3 tries) | Run `PARTIAL` with `writeResults` errors (idempotent; the next run repeats). |
| Config error (bad JSON map, regex, host, number) | Everything stays dry-run; errors listed in the report. |

Run statuses: `SANDBOX_DRY_RUN`, `DRY_RUN`, `NOTHING_TO_EVALUATE`, `COMPLETED`, `PARTIAL`. The routing report references contacts **by HubSpot record ID only**, with no emails or names.

---

## Offline simulator

```bash
node scripts/simulate-sandbox-run.js          # verbose
node scripts/simulate-sandbox-run.js --quiet  # summary only
```

Zero dependencies (Node ≥ 18, using only `fs`, `path` and `vm`). It executes `workflow.json` itself. It follows connections, runs every Code node in a VM, and evaluates expressions, including the expression-valued header name and HTTP method. It also emulates search pagination and full-response mode. HTTP goes to in-memory HubSpot and enrichment mocks: the HubSpot mock evaluates real search filters, rejects double enrollment, and records every write. Its **102 checks** cover:

1. Structure and static safety: token headers via `$env`, no retry on enrollment, fail-closed discovery, only two write builders, license footer in every Code node.
2. Safe defaults and config validation: cutoff arithmetic, typos, blocked env, missing token, URL allowlist / no query strings, invalid maps, ReDoS guard, gate dependencies.
3. Fixture parity and synthetic data.
4. Sandbox end to end: every decision, the latest-touch clock, recycle restarts, senders and sequences, title changes, job changers, status mapping, report privacy.
5. Policies and caps: cooling days, outbound / owner / enrichment caps, risky nurture, missing sequence, lost-reason rules, `none` toggles, re-evaluation interval, recycle cap.
6. Live dry run: search bodies, read-only calls, parity with the sandbox, enrichment payloads and auth prefix, enrichment off, unverified outbound.
7. Armed run:
   - Enrollment: the active-enrollment check comes first, the enrollment body is correct, and an already-enrolled contact is skipped.
   - Stamps and the nurture list are written correctly.
   - A rerun enrolls nobody twice and writes only what changed. `DO_NOT_RECYCLE` and `RECYCLED_*` statuses are preserved.
   - Options and failures: optional title / lead-status updates, an enrollment failure followed by its retry, the routing switches off, and an update outage.
8. Fail-closed paths: search failure, 10k limit, enrichment outage, config errors, empty population, schedule trigger.

Outputs go to `sim-output/` (git-ignored): `sandbox-routing-report.json`, `sandbox-run-report.json` and `armed-run-report.json`.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Always `DRY_RUN` | `DRY_RUN` or a write switch is off, `$env` is blocked, or a config error exists. See `writeBlockedBy` and `safetyDecisions`. |
| Nobody is routed to outbound | `ENRICHMENT_MODE=none` with `REQUIRE_VERIFIED_EMAIL_FOR_OUTBOUND=true`, an empty `SEQUENCE_MAP_JSON`, or no sender for the owners (`NO_SENDER_FOR_OWNER`). |
| `ENROLLMENT_FAILED` | The sender inbox isn't connected, the user lacks a sequences seat, or the scope is missing. |
| Everyone is `COOLING` | Recent sales activity restarts the clock; check `clockFrom` in the report. |
| Disqualified leads are `HOLD NO_REFERENCE_DATE` | Populate `recycle_disqualified_at` (or point `DISQUALIFIED_DATE_PROPERTY` at your own date property). |
| Search refused at 10,000 | Narrow `LOOKBACK_DAYS` or the statuses / stages. |
| `HOLD ENRICHMENT_FAILED` for everyone | Wrong `ENRICHMENT_API_URL`, auth header / prefix, or provider outage. Try one call with `ENRICHMENT_MAX_PER_RUN=1`. |
| Unexpected `EMAIL_RISKY` | The provider returns `catch_all` / `accept_all`. Set `NURTURE_ALLOW_RISKY=true` or adjust `ENRICHMENT_EMAIL_STATUS_MAP_JSON`. |
| A contact must never be recycled | Set `recycle_status` to `DO_NOT_RECYCLE`. |

---

## Repository layout

```
n8n-hubspot-dead-lead-recycling-nurture-re-entry-router/
├── workflow.json                     # n8n workflow (38 nodes, inactive on import)
├── README.md                         # this file
├── DISCLAIMER.md                     # liability limitation
├── LICENSE                           # MIT
├── .env.example                      # every variable, placeholder values, safe defaults
├── .gitignore                        # .env, SQLite / n8n data, sandbox outputs, exports
├── sample-payloads/
│   └── recycle-fixture.json          # synthetic deals, contacts, associations, enrichment responses
└── scripts/
    └── simulate-sandbox-run.js       # zero-dependency offline simulator (102 checks)
```

---

## ⚠️ Disclaimer & Liability Limitation

**Use at your own risk.** The code, workflows, and scripts in this repository are provided for educational and architectural demonstration purposes.

**No Liability:** The author and dhRobin Systems accept no responsibility or liability for any direct, indirect, incidental, or consequential damages that result from using, misusing, or deploying these scripts, including unwanted outreach, deliverability damage, enrichment charges and incorrect contact records.

**No Warranty:** All software, n8n JSON blueprints, JavaScript modules, qualification rules and sample payloads are provided "AS IS", without warranty of any kind, express or implied, including warranties of merchantability, fitness for a particular purpose and non-infringement. Verification and job-title data from any provider can be wrong or out of date.

**Production Testing Required:** Always test thoroughly in an isolated staging environment, such as a HubSpot developer test account or sandbox, with `SANDBOX_MODE=true` and `DRY_RUN=true` enabled, before you connect live HubSpot or enrichment credentials or enable stamps, enrollment, nurture routing or enrichment. Review every routing report and the first enrollments.

**Third-Party APIs & Compliance:** You alone are responsible for complying with the terms of service, rate limits, data privacy regulations (GDPR/CCPA), anti-spam and electronic-marketing laws, and security policies of HubSpot, your enrichment provider, n8n and any connected services. That includes confirming a lawful basis before re-contacting people, honouring opt-outs and do-not-contact requests, and reviewing every automatically updated record and enrollment.

The full disclaimer is also available in [DISCLAIMER.md](DISCLAIMER.md).

## License

Released under the MIT License. Copyright (c) 2026 DH Robin (dhRobin Systems). See [LICENSE](LICENSE).

---

Full text: DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.
