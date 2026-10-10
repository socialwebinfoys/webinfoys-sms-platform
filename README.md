# Webinfoys SMS Automation Platform

An SMS automation platform for Webinfoys: contacts, templates, multi-step
campaigns, an automation engine, a shared two-way inbox, delivery tracking,
number intelligence and analytics.

> **Status.** FINAL roadmap phases 1–10 are implemented: hardening and
> compliance, the automation engine, delivery tracking, the shared inbox,
> multi-step campaigns, contact import, settings, **Phase 8 (logs, analytics and
> the dashboard)**, **Phase 9 (design system, branding, responsive layout,
> loading / empty / error states)** and **Phase 10 (QA, security and originality
> review — see [Testing](#testing))**. Phase 11 (deployment) is not built.
>
> **AI reply system (v2 plan, Phases 8 – 10): COMPLETE, and OFF by default.**
> An earlier roadmap removed AI entirely, and this README previously said so; the
> v2 remaining-work plan reinstated it. The backend exists — three providers,
> encrypted key storage, guardrails, draft/auto modes, human takeover, draft
> approval — with the frontend in Phase 9 (AI Assistant page, draft review queue,
> configuration, and AI controls inside the inbox) and Phase 10 adding **AI
> analytics and a Test Reply sandbox**. All v2 development phases are now built.
> It is disabled out of the box and sends nothing until an admin enables it.
>
> **This platform is not yet cleared for production sending.** Secret rotation
> is outstanding and the deployment configuration is incomplete — see
> [Before going live](#before-going-live).

### A note on phase numbering

Two planning documents exist in this repository and they number phases
differently, which is worth stating plainly:

* **`Webinfoys_SMS_Platform_Roadmap (1).pdf` — the FINAL roadmap, authoritative.**
  Phase 8 is *Logs, Analytics & Dashboard*; Phase 9 is *Frontend Polish &
  Branding*. **Both are implemented.**
* `Webinfoys_SMS_Upgrade_and_AI_Plan.pdf` — the interim upgrade plan. Its
  phases 0–7 drove the hardening, compliance, automation, delivery, inbox,
  campaign, import and settings work described below, and the endpoint tables
  in this README use its numbering. Its phases 8–10 described an AI reply
  system. That specific design was dropped, but a later plan
  (`Webinfoys_SMS_Remaining_Work_Plan_v2`) reinstated an AI reply backend, which
  is what Phase 8 below describes. Its phase 11 (deployment automation) is still
  not built.

## Tech stack

| Layer      | Choice                                   |
| ---------- | ---------------------------------------- |
| Backend    | Node.js + Express 5 (REST API, JWT auth) |
| Database   | MongoDB (Mongoose) / MongoDB Atlas       |
| Frontend   | React 18 + Vite 5 (Axios, React Router)  |
| SMS        | Twilio (Messages + Lookup v2)            |
| Scheduler  | node-cron                                |

## Project structure

```
AI_SMS_Platform/
├── server/            # Backend (Node.js + Express)
│   ├── config/        # Env loading + validation, DB connection
│   ├── models/        # Mongoose schemas
│   ├── controllers/   # Request handling
│   ├── routes/        # URL -> controller mapping
│   ├── services/      # Twilio, lookup, send policy, delivery policy, import
│   ├── jobs/          # The automation worker
│   ├── middleware/    # Auth, rate limiting, Twilio signature, errors
│   ├── scripts/       # One-off maintenance scripts
│   └── utils/         # Phone, parsing, merge fields, query guards, opt-out
└── client/            # Frontend (React + Vite)
    └── src/{pages,components,context,services}
```

## Setup

### Backend

Requires Node.js 18+ and MongoDB (local or Atlas).

```bash
cd server
npm install
cp .env.example .env    # then fill in real values
npm run seed:admin      # creates the first admin from ADMIN_* in .env
npm run dev             # or: npm start
```

### Frontend

```bash
cd client
npm install
npm run dev             # http://localhost:5173, proxies /api to :5000
```

For a production build where the API is on a different origin:

```bash
cd client
cp .env.example .env    # set VITE_API_URL=https://your-api.example.com/api
npm run build
```

`client/public/.htaccess` is copied into `dist/` and provides the Apache SPA
rewrite, so refreshing a deep link such as `/inbox` does not 404 on Hostinger.

## Environment variables (`server/.env`)

`.env` is git-ignored and must never be committed or shared. `.env.example` is
the safe template.

| Variable | Required | Description |
| --- | --- | --- |
| `NODE_ENV` | — | `development` or `production` |
| `PORT` | — | API port (default `5000`) |
| `CORS_ORIGIN` | **in production** | Allowed client origin(s), comma-separated. `*` is refused in production |
| `MONGO_URI` | yes | MongoDB connection string |
| `JWT_SECRET` | yes | Token signing key — **minimum 32 characters**, startup fails below that |
| `JWT_EXPIRES_IN` | — | Token lifetime (default `7d`) |
| `PUBLIC_API_URL` | **in production** | Public base URL of this API; builds the Twilio status callback |
| `TWILIO_ACCOUNT_SID` | for real sending | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | for real sending | Twilio auth token — never returned by the API |
| `TWILIO_PHONE_NUMBER` | for real sending | Default "from" number |
| `TWILIO_WEBHOOK_BASE_URL` | **in production** | Public base URL used to verify the webhook signature. In production: https, and identical to `PUBLIC_API_URL` |
| `TWILIO_VALIDATE_WEBHOOK` | — | `false` only for local testing. Production refuses to start with `false` |
| `SMS_SIMULATE` | — | `true` simulates every send (no real SMS, nothing billed) |
| `LOOKUP_SIMULATE` | — | `true` simulates Twilio Lookup (Lookup is billable) |
| `DEFAULT_COUNTRY_CODE` | — | e.g. `+1`; applied to imported numbers with no country code |
| `AUTOMATION_ENABLED` | — | Starts the cron worker. In production only the exact value `true` starts it; in development it starts unless `false` |
| `SHUTDOWN_TIMEOUT_MS` | — | How long a graceful shutdown waits for a running worker pass (default `20000`) |
| `AUTOMATION_CRON` | — | Worker tick schedule (default every minute) |
| `AUTOMATION_MAX_SENDS_PER_RUN` | — | Per-run throttle; a Settings value overrides it |
| `AUTOMATION_MAX_RETRIES` | — | Attempts per step before the enrollment fails |
| `AUTOMATION_RETRY_BACKOFF_MINUTES` | — | Base retry backoff (grows exponentially) |
| `ADMIN_NAME` / `ADMIN_EMAIL` / `ADMIN_PASSWORD` | seed only | First admin. Password **minimum 12 characters** |

Twilio credentials come **only** from the environment. They are never stored in
the database and never returned by any endpoint.

`client/.env` holds `VITE_API_URL` only. Everything in it is inlined into the
public JavaScript bundle, so **no secret may ever go there**.

## What each phase delivers

### Upgrade-plan phases 0–7

These numbers come from `Webinfoys_SMS_Upgrade_and_AI_Plan.pdf`, the interim
document — **not** from the FINAL roadmap. The endpoint tables below use the same
numbering. That plan's phases **8–10 were an earlier AI reply design** which was
dropped; the AI backend that now exists was built to the v2 plan instead — see
**AI reply system** below.

| Phase | Delivers |
| --- | --- |
| 0 | Security hardening: admin-only destructive endpoints, trust proxy, CORS allow-list, 1 MB body limits, production env validation, US phone normalization fix, query guards, auth logging, 12-character passwords, SPA routing |
| 1 | Compliance: STOP/START/HELP, opt-out, stop-on-reply, send guards on every path, Twilio 21610 handling |
| 2 | Automation engine: per-row claims, a global worker lease, sending window + timezone + send days, per-run throttle |
| 3 | Delivery tracking: Twilio status callbacks, out-of-order protection, delivery blocking, unblock, delivery report |
| 4 | Inbox: polling, filters, search, unread badge, message pagination, retry, admin soft delete, contact panel |
| 5 | Campaigns: multi-step sequences with stable step IDs, safe live editing, clone, per-campaign stats |
| 6 | Import: preview before committing, count integrity, optional enroll-after-import |
| 7 | Settings & misc: allowed line types, log search, template options, user management, theme toggle |

### FINAL roadmap phases 8–10

These numbers come from `Webinfoys_SMS_Platform_Roadmap (1).pdf`, the
authoritative document. **FINAL Phase 10 is "QA, Security & Originality Review" —
it has nothing to do with the discarded AI phase that shared the number 10 in the
interim plan.**

| FINAL Phase | Delivers |
| --- | --- |
| 8 | Logs, Analytics & Dashboard |
| 9 | Frontend Polish & Branding |
| 10 | QA, Security & Originality Review: an in-repo test suite (`npm test`) that cannot reach the live database or Twilio, plus four defect fixes — NANP phone validation, the line-type filter on inbox replies, a single send budget per cron tick, and recipient-timezone quiet hours for follow-ups. (At that time the repository contained no AI code; the v2 plan's Phase 8 added the AI backend afterwards.) |
| 11 | Deployment on Hostinger — **not built** |

## API

All routes require a Bearer token unless marked otherwise. Responses use
`{ success, data, pagination }`.

### Auth
| Method | Route | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/api/auth/login` | public | Log in (rate-limited: 10 failed attempts / 15 min / IP) |
| GET | `/api/auth/me` | user | Current user |
| POST | `/api/auth/register` | admin | Create an operator (password ≥ 12 chars) |

There is no public self-registration by design.

### Contacts & import
| Method | Route | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/contacts` | user | List — `search`, `tag`, `optedOut`, `deliveryBlocked`, `import`, `sort`, `page`, `limit` |
| POST / GET / PUT / DELETE | `/api/contacts[/:id]` | user | CRUD |
| DELETE | `/api/contacts` | **admin** | Delete ALL contacts |
| PATCH | `/api/contacts/:id/opt-out` | user | Manual opt-out / opt-in |
| POST | `/api/contacts/:id/lookup` | user | Twilio Lookup enrichment |
| POST | `/api/contacts/import/preview` | user | **Writes nothing.** Returns a summary, the first 200 valid rows, all invalid rows with reasons, and a `previewToken` |
| POST | `/api/contacts/import/confirm` | user | `{ previewToken, enrollCampaignId? }` — commits the previewed upload |
| POST | `/api/contacts/import` | user | Back-compat one-shot import (same engine) |
| GET | `/api/contact-imports` | user | List import batches |
| DELETE | `/api/contact-imports/:id` | **admin** | Delete an import record (never its contacts) |

#### Import preview flow

1. **Choose** a `.csv` or `.xlsx` file (max 5 MB).
2. **Preview** — the server parses and validates it and reports what *would*
   happen. No contact, import record or enrollment is created. The uploaded
   bytes are held in a short-lived `ImportPreview` document with a **1-hour TTL**.
3. **Confirm** — the client sends back only the `previewToken`. The server
   re-parses the **stored original file** and imports from that, so rows edited
   in the browser can never be smuggled in. A token belongs to the user who
   created it and can be used once.

Counts always balance:

```
created + duplicatesInFile + duplicatesInDb + invalid = totalRows
```

A row rejected by schema validation (e.g. a malformed email) moves from
`created` to `invalid` and is reported **with its row number** — it is never
silently dropped.

Supported columns (aliases are accepted, matching is case-insensitive):

| Column | Maps to | Notes |
| --- | --- | --- |
| `name` | `name` | also `full name`, `contact name` |
| `phone` | `phone` | **required**; normalized to E.164 |
| `email` | `email` | |
| `tags` | `tags` | comma-separated |
| `timezone` | `timezone` | IANA name; an unusable value is warned about and ignored |
| `opt_in_date` | `optedInAt` | consent evidence |
| `opt_in_source` | `optInSource` | consent evidence |

Any other column becomes a custom field. The opt-in columns are **evidence
only** — no send guard consults them, so they can never override an opt-out.

A sample CSV is downloadable from the Contacts page.

### Templates
| Method | Route | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/templates` | user | Paginated list (max 100 per page) |
| GET | `/api/templates/options` | user | **id + name only**, up to 1000 — for dropdowns |
| POST / GET / PUT / DELETE | `/api/templates[/:id]` | user | CRUD |
| POST | `/api/templates/preview` | user | Render a template against a contact (no send) |

### Campaigns
| Method | Route | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/campaigns` | user | List — `search`, `isActive`, `sort`, `page`, `limit` |
| POST / PUT | `/api/campaigns[/:id]` | user | Accepts `steps[]` (each `templateId` **or** `body`, `delayValue`, `delayUnit`). The single-message payload still works |
| GET | `/api/campaigns/stats` | user | Per-campaign performance |
| POST | `/api/campaigns/:id/clone` | user | Duplicate the definition as an **inactive** copy |
| GET | `/api/campaigns/:id/eligible-contacts` | user | Contacts still enrollable |
| DELETE | `/api/campaigns/:id` | user | **409** if it has enrollments; `?force=true` **and admin** to cascade |
| DELETE | `/api/campaigns` | **admin** | Delete ALL campaigns |

Campaign steps carry a stable `_id`. An in-flight enrollment tracks
`currentStepId`, so reordering a sequence never changes which message someone is
waiting for; if the step they were waiting on is deleted, they advance to their
next unsent step. `sentSteps[].stepId` makes the "never send a step twice"
guarantee survive an edit.

**Stats definitions** (also returned in the payload):
`enrolled` = enrollment rows in any state; `replyRate` = replied enrollments /
enrolled enrollments; `sent` = outbound messages stamped with the campaign;
`delivered` = of those, the ones with a Twilio `delivered` receipt.
`optOuts` is **derived** — see [Known limitations](#known-limitations).

### Enrollments
| Method | Route | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/api/enrollments` | user | Enroll by `contactId`, `contactIds[]` or `selectAll` |
| GET | `/api/enrollments` | user | List — `status`, `campaign`, `contact` |
| GET | `/api/enrollments/by-contact/:contactId` | user | For the inbox side panel |
| PATCH | `/api/enrollments/:id` | user | `paused` / `active` / `cancelled` |
| POST | `/api/enrollments/run` | **admin** | One worker pass now (`{ ignoreWindow? }`) |
| DELETE | `/api/enrollments` | **admin** | Delete ALL enrollments |

### Inbox
| Method | Route | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/conversations` | user | `status`, `unread`, `needsReply`, `assigned`, `search` |
| GET | `/api/conversations/unread-count` | user | Nav badge |
| GET | `/api/conversations/changes?since=` | user | Cheap polling |
| GET | `/api/conversations/:id/messages?before=&limit=` | user | Newest page first, `before=` loads older |
| POST | `/api/conversations/:id/reply` | user | Reply (`body` or `templateId`, rendered server-side) |
| PATCH / POST | `/api/conversations/:id` , `/read` | user | Status, assignment, mark read |
| DELETE | `/api/conversations/:id` , `/messages/:messageId` | **admin** | Soft delete |
| POST | `/api/sms/send` , `/api/sms/:id/retry` | user | Send one SMS / retry a failed one |

Inbound STOP/START messages **cannot be deleted** — they are the compliance
record. Deleting a thread never deletes its messages.

### Delivery, analytics and logs
| Method | Route | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/api/webhooks/twilio/inbound` | Twilio signature | Inbound SMS |
| POST | `/api/webhooks/twilio/status` | Twilio signature | Delivery receipts |
| GET | `/api/delivery/report?days=` | user | Delivery breakdown, error codes, blocked list |
| PATCH | `/api/delivery/unblock/:contactId` | **admin** | Clear a delivery block |
| GET | `/api/analytics/overview` , `/campaigns` | user | Dashboard metrics |
| GET | `/api/logs` | user | `search`, `contact`, `eventType`, `severity`, `from`, `to`, pagination |

`search` covers the message, event type and status, with the term escaped so
regex characters are matched literally.

### Settings and users
| Method | Route | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/settings/twilio` | user | Status + operational settings (**never credentials**) |
| PUT | `/api/settings/twilio` | **admin** | `smsEnabled`, `allowedLineTypes[]`, `lookupMaxAgeDays`, `defaultFrom`, `deliveryFailureThreshold` |
| GET | `/api/settings/automation` | user | Sending window, days, throttle |
| PUT | `/api/settings/automation` | **admin** | Configure the above |
| GET | `/api/users?includeInactive=` | user | Operators (inactive visible to admins only) |
| PATCH | `/api/users/:id` | **admin** | Role, activate/deactivate, password reset |

An admin **cannot deactivate or demote themselves** — that would be a way to
lock an installation out of administrator access.

#### Allowed line types

`allowedLineTypes` controls which Twilio Lookup classifications may be messaged:
`mobile`, `landline`, `fixedVoip`, `nonFixedVoip`, `tollFree`, `unknown`.

It is enforced on **every** send path — manual send, retry, campaign automation,
follow-up automation and inbox replies — with exactly one exception: replying to
a contact who has messaged us (`lastInboundAt` is set) skips the check, because
their inbound message already proves the number receives SMS, and checking would
spend a billable Lookup call to learn it again. Consent (opt-out, inactive,
delivery-blocked) is never exempt anywhere.

* An **empty array is rejected** — it would silently block every message.
* The filter **fails closed**: a number whose type cannot be established is
  blocked, not sent to.
* A cached classification older than `lookupMaxAgeDays` (default 30) is looked
  up again, because numbers get ported between carriers.
* If Twilio Lookup is unavailable, a stale cached type is honoured **only when
  that type is allowed**; otherwise the send is blocked.

The former `mobileOnly` boolean is kept for backward compatibility and still
works: with no `allowedLineTypes` saved, `mobileOnly=true` behaves as
`['mobile']` and `false` as all types. **No migration is required.**

## Theme

The sidebar has a light/dark toggle. The preference is stored in
`localStorage` and survives a refresh. Dark remains the default; the light
theme is a CSS-variable override, so no component was restyled.

## Operational notes

* `SMS_SIMULATE=true` makes every send simulated — nothing leaves the system and
  nothing is billed. Messages are recorded with status `simulated`.
* `AUTOMATION_ENABLED=false` stops the cron worker starting (in production it is off unless set to `true`). **It is not a
  sending kill switch:** admins can still trigger a pass with
  `POST /api/enrollments/run` or `POST /api/followings/run`. To stop all outbound
  SMS, turn off `smsEnabled` in Settings or keep `SMS_SIMULATE=true`.
* `maxSendsPerRun` caps one **cron tick**, shared across the campaign and
  follow-up passes: the enrollment pass is served first and the follow-up pass
  spends whatever is left. A direct admin "run now" is a separate action and gets
  its own budget.
* The sending window is evaluated in each **recipient's** timezone where they
  have one (enrollment tz → contact tz → the global window tz), for campaign
  steps and follow-ups alike.
* Twilio **Lookup is billable**; `LOOKUP_SIMULATE=true` avoids real calls in
  development.
* The sending window defaults to 09:00–20:00 `America/New_York` for **new**
  installations only. An existing settings document keeps whatever it holds —
  check it in Settings before sending to US numbers (TCPA allows 8 AM–9 PM in
  the recipient's local time).

### Maintenance scripts

```bash
node scripts/fixUsPhones.js           # DRY RUN — reports only, writes nothing
node scripts/fixUsPhones.js --apply   # actually writes the corrections
node scripts/backfillConversationContacts.js
```

`fixUsPhones.js` repairs numbers corrupted by the old normalization bug
(`+1` + an 11-digit number). Dry run is the default.

## AI reply system (v2 plan, Phase 8 — backend only)

**It is off by default and sends nothing until an admin turns it on.** Two
switches must both be set: `AI_WORKER_ENABLED=true` in the environment (which
only starts the scheduler) and **AI enabled** in Settings (the master switch,
`false` by default). Configuring a provider does *not* enable it.

| Concern | How it works |
| --- | --- |
| Providers | `gemini`, `groq`, `openai`, behind one adapter interface. Adding a fourth means one new file plus one registry line. |
| API keys | AES-256-GCM encrypted with `AI_ENCRYPTION_KEY` before storage, held `select: false`, and returned **only** as `{ configured, masked }`. No endpoint returns a decrypted key, and no log or error carries one. |
| Modes | `draft` (default) stores a candidate for a human. `auto` may send, but only if every guard passes. |
| Guardrails | AI enabled, contact active, **not opted out**, `smsEnabled`, no human takeover, line-type policy, sending window and send days (in the recipient's timezone), reply limit, escalation rules, valid output, confidence threshold. |
| Compliance | Reuses the platform's existing helpers — `sendPolicy.checkCanSend`, `sendPolicy.checkMobileOnly`, the automation worker's window helpers, and `optOut.handleCarrierOptOut` for 21610. There is **one** opt-out system and AI cannot override it. |
| Sending | Goes through the same `twilioService` wrapper as every other outbound message, so `SMS_SIMULATE` applies. There is no second Twilio implementation. |
| Escalation | Keyword hit, low confidence, reply limit, model request, or parser/provider failure. The reason is stored on the thread and the job. |
| Worker | `jobs/aiWorker.js` — the existing cron + `WorkerLock` + per-row claim pattern. No Redis, no BullMQ. |
| Webhook | The inbound webhook only **enqueues**; it never waits on a provider, and enqueue failures cannot affect acknowledgement. STOP/START are excluded. |

### AI endpoints

| Method | Route | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/ai/settings` | user | Configuration; the API key is **masked** |
| PUT | `/api/ai/settings` | **admin** | Update configuration / store a key (write-only) |
| POST | `/api/ai/test` | **admin** | Generate a reply **without sending** (rate-limited per admin) |
| GET | `/api/ai/jobs` | user | AI jobs and drafts |
| POST | `/api/ai/jobs/:id/approve` | user | Send a draft; optional `{ body }` replaces the text |
| DELETE | `/api/ai/jobs/:id` | user | Discard a draft (**nothing is deleted** — status becomes `rejected`) |
| GET | `/api/ai/conversations/:id` | user | AI state for one thread |
| PATCH | `/api/ai/conversations/:id` | user | Set the per-thread AI mode: `{ mode: 'draft'\|'auto' }` |
| POST | `/api/ai/conversations/:id/takeover` | user | Stand the assistant down |
| DELETE | `/api/ai/conversations/:id/takeover` | user | Hand the thread back |

### Phase 8.1 — draft review, per-thread mode, test throttling

A backend hardening pass on top of Phase 8. No AI behaviour was changed and
nothing was enabled.

**Approving a draft** (`POST /api/ai/jobs/:id/approve`) is the only way a stored
draft becomes a sent message. The **only** things taken from the client are the
job id and an optional replacement `body`; the recipient, the thread, the
provider, the approving identity and every compliance decision are re-read on the
server. It re-runs the full send policy at the moment of sending — so a STOP that
arrives after a draft is written still blocks it — sends through the one
`twilioService` wrapper (`SMS_SIMULATE` applies), records `approvedBy` /
`approvedAt`, and stamps the message `source: 'ai'`. **No provider is called**:
the text already exists, so the stored API key is not even decrypted.

An edited body is validated against the configured `maxReplyCharacters` and
**refused rather than truncated** if it is too long. `draftReply` always keeps the
unedited model output; the human text is stored beside it in `approvedBody`, so
the record shows both what the AI proposed and what was actually sent.

**Idempotency is a single atomic status transition.** Approval claims a job by
moving it `drafted → processing` in one database operation, so simultaneous
approvals cannot both proceed: exactly one sends, the rest get **409**. A
definitive consent block retires the draft to `skipped` (never approvable again);
a condition that can clear — quiet hours, `smsEnabled` off, a takeover, an
unverifiable line type, a Twilio failure — hands the draft back intact.

**Rejecting a draft** uses `DELETE`, but nothing is deleted: the job moves to the
terminal `rejected` status with `rejectedBy` / `rejectedAt`. Repeating it is
idempotent (`changed: false`) and a rejected draft can never afterwards be
approved.

**`POST /api/ai/test`** is now rate-limited — admin-only caps *who* may spend
provider credit, not how much. The budget is keyed per admin (not per IP, so
colleagues behind one address do not share one) and mounted after the
authorization check, so a rejected non-admin cannot drain it. Configure with
`AI_TEST_RATE_LIMIT_MAX` and `AI_TEST_RATE_LIMIT_WINDOW_MINUTES`; the default is
10 per 15 minutes in production and 30 otherwise. It is the only rate-limited AI
route.

New `SystemLog` events: `ai.draft.approved` (with `edited` and `bodyLength` — never
the message text), `ai.draft.rejected`, `ai.draft.blocked`, `ai.draft.send_failed`
and `ai.mode.changed`.

### Phase 9 — the AI frontend

A new **AI Assistant** page (`/ai`) with two tabs, and extensions to the existing
inbox. No separate visual style: the same cards, chips, alerts, modals and theme
tokens as the rest of the app.

* **Drafts** — the review queue, newest first, filterable by status and
  paginated. Each row approves, edits and approves, or discards, and links
  through to the conversation (`/inbox?conversation=<id>`).
* **Configuration** — activation, mode, provider, model, API key, persona,
  business rules, FAQ, escalation keywords and the four limits. Activation is a
  separate control from the single Save, because turning the assistant on is a
  different decision from editing a persona. Operators see it read-only; the
  server enforces that regardless.
* **Inbox** — AI chips on the thread header (takeover, escalated, reply limit,
  mode), an `AI` badge on messages the assistant sent (from the existing
  `source: 'ai'`), and a side-panel section with takeover / hand back, the
  per-conversation mode, and any draft waiting on that thread.

The frontend **calls the backend and nothing else**: there is no second send
path, no provider call from the browser, and no compliance rule reimplemented in
React. It never claims success before a 2xx, and after every action it refetches
rather than assuming the result. A stored API key is never returned to the page —
only `{ configured, masked }` — and is never written to browser storage.

`GET /api/ai/jobs` populates `contact` and `conversation` with a narrow
projection so the queue can name a recipient without one request per row.

Run the frontend tests with `npm test` in `client/`.

### Phase 10 — AI analytics and Test Reply

Two more tabs on the same AI Assistant page, so there is still one nav entry.

**Analytics** (`GET /api/analytics/ai?range=today|7d|30d|all`, extending the
existing analytics controller and its range convention). Aggregated server-side
with MongoDB; the browser receives summary numbers, never raw logs to add up.

Every number is traceable, and the two sources are split so nothing is counted
twice:

* **AIReplyJob** — one row per inbound message, with a single terminal status.
  All reply outcomes, confidence, provider/model, tokens and non-send reasons
  come from here. Grouping by status partitions the rows, so a job counted as
  `sent` cannot also be counted as `drafted`.
* **SystemLog** — worker runs, takeovers, provider errors and configuration
  changes, none of which have a job row.

The trap this avoids: `ai.reply.sent` is logged *and* the job's status becomes
`sent`. Sends are therefore counted from the job status alone.

What it deliberately does **not** show: a monetary cost (no pricing model
exists), a takeover rate (a takeover can happen on a conversation with no AI
attempt in the period, so the ratio would compare different populations), and an
average confidence when none was recorded (shown as "—", never 0%). The response
says all of this in its own `notes` field.

The AI activity table reuses `GET /api/logs`, which is already paginated and
filterable; a small additive `eventPrefix` parameter keeps it to `ai.*` events
exactly. Charts are the dependency-free CSS bars the dashboard already uses.

**Test Reply** drives the existing `POST /api/ai/test` (admin-only,
rate-limited). It is a sandbox: it generates a reply and returns it, and
**cannot send**. It never calls `twilioService`, creates no `SMSMessage`, no
conversation, no contact, no enrollment and no AI job, and never starts the
worker — asserted structurally in `test/api/ai-test-reply-safety.test.js`, where
every one of those is a recording double. The result is styled as a labelled
panel, never as a message bubble, and carries a persistent "simulation only"
statement.

Two indexes were added for this: `{ eventType: 1, createdAt: -1 }` on SystemLog
and `{ createdAt: -1 }` on AIReplyJob — both serve the "this family, in this
window, newest first" query the analytics and the table share.

## Testing

```bash
cd server
npm test            # the whole suite
npm run test:unit   # pure logic, no HTTP
npm run test:api    # the real Express app over HTTP
npm run test:worker # the automation engine
npm run test:syntax # node --check over every .js file
```

Node's built-in test runner (`node --test`) — no test framework is installed.

**The suite cannot reach the live database or Twilio.** `test/_support/env.js`
loads before any application module and:

* sets a complete test environment, so `server/.env` can never reach the code
  under test (dotenv does not override an existing value);
* replaces `mongoose.connect` and `mongoose.createConnection` with functions that
  **throw** — isolation is structural, not a convention;
* replaces the Twilio SDK so constructing a client throws.

Persistence is supplied by in-memory doubles swapped into `require.cache` before
the app loads (`test/_support/stubs.js`), so controllers, routers, middleware and
the worker all run as shipped. `test/unit/harness-safety.test.js` asserts these
guarantees, and the three tiers are:

| Tier | What runs for real |
| --- | --- |
| `test/unit` | policy, parsing, timezone/window maths, config validation |
| `test/api` | the real Express app end to end over HTTP |
| `test/worker` | the real automation worker, locks, claims and budgets |

## Deploying the API to Render

Nothing here has been deployed; this is what the code expects.

**Service:** a Render *web service* with the Node runtime, root directory
`server`, build command `npm ci --omit=dev` (development tools such as nodemon are not needed to run it), start command `npm start`. It must be an
instance type that stays running — the campaign and follow-up worker is a timer
inside this process, so an instance that is suspended when idle stops sending.
Run **one** instance.

**Node.js:** `engines.node` in `server/package.json` (and `client/package.json`)
is `>=24.21.0 <25`. Render reads that field. 24.21.0 is the version the test
suite was run on, and every dependency's own minimum (the highest is 20.19.0) is
below it.

**Environment variables to set in the Render dashboard.** Values are never
committed; `server/.env` is git-ignored and is not used on Render.

| Variable | Initial value | Notes |
| --- | --- | --- |
| `NODE_ENV` | *(leave unset)* | Render sets `production` at runtime. Any other value makes the server refuse to start on Render |
| `MONGO_URI` | secret | The production database |
| `JWT_SECRET` | secret, 32+ characters | Changing it signs everyone out |
| `JWT_EXPIRES_IN` | `7d` | Seven-day login session. `7d` is also the default if unset |
| `CORS_ORIGIN` | the frontend origin | `https://host`, no path, no trailing slash; comma-separate several |
| `PUBLIC_API_URL` | this service's public https URL | Required |
| `TWILIO_WEBHOOK_BASE_URL` | **the same URL** as `PUBLIC_API_URL` | Required; startup fails if the two differ |
| `TWILIO_ACCOUNT_SID` | secret | |
| `TWILIO_AUTH_TOKEN` | secret | Also verifies webhook signatures |
| `TWILIO_PHONE_NUMBER` | the sending number | |
| `TWILIO_VALIDATE_WEBHOOK` | *(leave unset)* | On by default. `false` makes the server refuse to start in production |
| `SMS_SIMULATE` | `true` | **Start with `true`**: no SMS leaves the system. Set `false` when ready to send |
| `LOOKUP_SIMULATE` | `true` | **Start with `true`**: no billable Lookup. Set `false` when ready |
| `AUTOMATION_ENABLED` | `false` | In production the worker starts only when this is exactly `true` |
| `AI_WORKER_ENABLED` | `false` | AI is also off in Settings by default |
| `AI_ENCRYPTION_KEY` | *(unset)* | Only needed before storing an AI provider key (32+ characters) |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME` | secret | Checked on every start (Render's disk is not kept between deploys). An existing admin is never changed; a new one needs a 12+ character password. Keep `ADMIN_EMAIL` the same as the existing admin's, or a second admin is created |
| `DEFAULT_COUNTRY_CODE` | `+1` if importing US numbers without a country code | |
| `SHUTDOWN_TIMEOUT_MS` | *(unset → 20000)* | Must stay below Render's 30-second shutdown window |

`PORT` is supplied by Render. Do not set `DB_STATE_FILE`.

**What startup enforces in production** (the server exits with a message naming
the variable, never its value): `MONGO_URI`, `JWT_SECRET` (32+), `CORS_ORIGIN`
(no `*`, bare origins only), `PUBLIC_API_URL` and `TWILIO_WEBHOOK_BASE_URL`
(https, identical), and webhook signature validation switched on.

**Frontend:** build with `VITE_API_URL=https://<api-host>/api npm run build` and
upload `client/dist` to the static host. `client/.env*` files are git-ignored.

**Shutdown and restarts.** On `SIGTERM` the server stops accepting connections,
stops scheduling worker ticks, lets a running pass finish the one enrollment or
follow-up recipient it is on, then exits. Each follow-up recipient is claimed
before it is sent and its result is saved immediately afterwards, so an
interruption can affect at most the one recipient in flight.

**Delivery is at-least-once, not exactly-once.** Twilio's send call cannot be
made idempotent, so one message can be repeated, to one person, if the process
dies after Twilio accepted it but before that was saved, or if Twilio accepted
it and the response was lost. An interrupted follow-up recipient is checked
against the message log before anything is sent again.

## Before going live

These are **outstanding** and must be done by hand:

1. **Rotate every credential.** The Twilio auth token, the MongoDB Atlas
   password, `JWT_SECRET` (this signs everyone out) and the admin password —
   which must now be at least 12 characters. Rotation has **not** been performed.
2. **Never share `server/.env`.** Share `.env.example` only.
3. Set `NODE_ENV=production` (Render does this itself), `CORS_ORIGIN`,
   `TWILIO_WEBHOOK_BASE_URL` and `PUBLIC_API_URL`. Startup fails without them.
   See "Deploying the API to Render" above for the full list.
4. Set `SMS_SIMULATE=false` only when you intend to send real messages.
5. Review the sending window and the allowed line types in Settings.
6. Enable Twilio Advanced Opt-Out on the number/Messaging Service — the app
   deliberately sends no STOP/START confirmation itself.
7. Point the Twilio number's webhooks at `/api/webhooks/twilio/inbound` and
   `/api/webhooks/twilio/status`.

## Known limitations

* **Secret rotation is pending** (see above). Until it is done, treat the
  current credentials as compromised.
* **Campaign opt-out attribution is derived, not recorded.** The schema has no
  campaign reference on an opt-out, so a contact is attributed to the campaign
  that sent their most recent campaign message before `optedOutAt`. It is
  deterministic and never double-counts, but it is a heuristic.
* **Delivery counts only reflect receipts.** Simulated sends never receive one,
  so `delivered` is 0 while `SMS_SIMULATE=true`.
* Messages sent before Phase 2 carry no campaign reference, so older campaigns
  report `sent: 0` even where enrollments exist.
* A log entry referencing a since-deleted contact shows no contact name.
* **The test suite does not cover persistence.** It substitutes the Mongoose
  models, so Mongoose schema validation, index behaviour (including the partial
  unique enrollment index and the TTL on import previews) and real concurrency
  against MongoDB are not exercised. Running the suite against a disposable
  database is the natural next step.
* The automated suite does not drive the React frontend; the browser pass is
  still manual.
* The AI system is complete across v2 Phases 8, 8.1, 9 and 10 — backend,
  frontend, analytics and Test Reply. It is disabled by default and sends nothing
  until enabled.
* **AI analytics reports only what the data supports.** There is no cost metric,
  because the platform holds no provider pricing; no takeover *rate*, because
  takeovers and AI-handled conversations are different populations; and a
  confidence that was never recorded shows as "—" rather than 0%.
* **The AI frontend has its own tests but no browser-driven ones.** `client`
  runs pure-logic, API-contract and server-rendered component tests
  (`npm test` in `client/`, using Node's test runner with no new dependency).
  Click-through behaviour — opening a dialog, typing in the draft editor — is
  still a manual pass, because the project has no DOM test environment.
* The earlier upgrade plan's AI reply phases were removed by
  the FINAL roadmap and were never built; deployment automation is also not built.
* The Phase 9 theme ships dark by default with an optional light theme. Both were
  checked against WCAG AA (4.5:1) for body, secondary and status text.
