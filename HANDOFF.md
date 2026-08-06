# Handoff — pick-up notes

Last touched 2026-07-28 via commit `0010864`.

> **Deploy state:** the repo is now in sync with production as of 2026-07-28. Commit `54ce388`
> recovered five changes that had been deployed on 2026-07-21 but never committed — if you are
> picking this up after a gap, verify the running version still matches `main` before editing.
> `npx wrangler deploy --dry-run --outdir=/tmp/b` and diff `/tmp/b/index.js` against the deployed
> bundle from `GET /accounts/<acct>/workers/scripts/coastalsource/content/v2` (the OAuth token
> wrangler already holds works for `/content/v2`; the legacy `/content` returns 405).

## Where this is

End-to-end Zoom Contact Center ↔ Zoho CRM + Zoho Desk integration deployed at `https://coastalsource.itcontact-521.workers.dev`. Customer Service and Technical Support queues are both production-ready.

## Working today

### Webhook → Desk ticket

Triggered on `contact_center.engagement_disposition_added`.

- **Department routing** by queue name on the engagement, via `pickDeskQueueBucket`
  - queue contains "technical" or "warranty" → dept `570884000009266009`
  - queue contains "customer" → dept `570884000000006907`
  - anything else → `ZOHO_DESK_DEFAULT_DEPARTMENT_ID`, which is **not set** — so an
    unrecognized queue fails closed and the call is dropped with no ticket. Teach new
    queues in `pickDeskQueueBucket` (one place; both the department and the Inquiry
    Type field branch off it).
- **Inquiry Type** custom field, branched by queue
  - CS queue → `cf_inquiry_type_2`, value mapped via `DESK_INQUIRY_TYPE_MAP` in [src/index.js](src/index.js)
  - TS queue → `cf_inquiry_type_tech_support`, value is the disposition name verbatim
  - Skip dispositions (currently `No Ticket Needed`) bypass ticket creation entirely
- **Subject + status from structured agent notes**
  - Agent writes notes like `Title: ... Notes: ... Ticketstatus: closed`
  - Parser extracts each field; latest note (chronological) wins for Title/Status overrides
  - Falls back to `<disposition> — <note excerpt>` and default Open status if no structured fields
- **Wrap-up note capture**
  - Initial fetch may miss the wrap-up note (race vs disposition event)
  - Worker re-fetches after 10s and keeps whichever response has more notes
  - Body renders all notes' parsed `Notes:` values as bullet list
- **Owner / Assignee**
  - Zoom agent → CRM user (CRM `users` API by email) → cached
  - Zoom agent → Desk agent (Desk `agents` API by email) → cached
  - Combined cache: `zoom_to_zoho_user:<zoom_id>` with both ids, 30-day TTL
  - Desk agent id sets `assigneeId` on the ticket
- **Linked records on the ticket**
  - `contactId` from Desk contact lookup by phone
  - `accountId` from the Desk contact's linked account
  - `email` from the CRM contact's email (fallback to Desk contact email)
- **Duplicate webhook protection**
  - `engagement_seen:<id>` claim-then-reverify-ownership before dispatch
  - Concurrent duplicate webhooks: only one POST hits Desk
- **Auto-dispatch toggle:** `DESK_AUTO_CREATE_TICKETS="true"` secret (flip to disable without a redeploy)

### Alerting

`maybeSendAlert(env, {type, summary, details, force})` fans out to whichever channels are
configured and records a per-type cooldown in KV (`alert_cooldown:<type>`, TTL from
`ALERT_COOLDOWN_SECONDS`, default 1h). The cooldown only starts once a send actually
succeeds, so a broken channel can't suppress the next hour.

- Zoom chat via `ALERT_ZOOM_WEBHOOK_URL` (+ optional `ALERT_ZOOM_WEBHOOK_SECRET` as `Authorization`)
- Email via Resend, needs `ALERT_RESEND_API_KEY` + `ALERT_EMAIL_TO` (comma-separated)
- Smoke test: `GET /zoom/alert-test` — bypasses the cooldown, always sends

**What alerts**

| Condition | Alert type |
|---|---|
| Zoom engagement fetch failed | `zoom_fetch` |
| Desk dispatch failed after a payload was built | `desk_dispatch` |
| Call dropped before a ticket was attempted | `desk_dropped:<reason>:<queue>` |

The third covers the three pre-dispatch bail-outs — `no_disposition`,
`no_department_mapping`, `no_inquiry_type_mapping` — driven by the `deskDroppedReason` flag
set at each bail-out site rather than by matching on `desk_ticket_error` wording. All three
mean the call is simply gone, so they're the ones you actually want paged. Intentional skips
never set the flag and stay quiet, and all of it is gated on `DESK_AUTO_CREATE_TICKETS`.

The cooldown key includes the reason *and* the queue, so a second unmapped queue still alerts
instead of being swallowed by the first one's hour.

Until 2026-07-28 the `desk_dropped` case did not exist, and the `desk_dispatch` condition
required `deskTicketPayload` to be non-null — which no pre-dispatch bail-out ever satisfies.
That is why the Warranty queue dropped 11 calls across five days with alerting switched on.

### Agent popup at `/popup?phone=<ANI>&engagement_id=<id>`

- Contact match by phone → 302 to `/tab/Contacts/<id>`
- Account-only match → 302 to `/tab/Accounts/<id>`
- No match → HTML form with HMAC-signed token (30-min TTL)

### Popup form (live)

- Live account autocomplete via `GET /popup/accounts/search`
- Pick an account → creates Contact linked to that account
- No account picked → creates a Lead with whatever was typed as `Company` (now unblocked — `ZohoCRM.modules.leads.CREATE` granted)

## Disposition mappings

### Customer Service queue → `cf_inquiry_type_2`

| Zoom disposition | Desk picklist value |
|---|---|
| Dealer Relations | Dealer Relations |
| Escalations | Escalations – Customer Service and Warehouse |
| Order Management & Shipping | Order and Shipping – Warehouse and Shipping |
| Product/Account Support | Product/Service Support – Customer Service |
| Returns/Exchanges | Returns/Exchanges – Warehouse and Shipping |
| Rollover | Rollover |
| Set-up or diagnostics | Setup or diagnostics - Tech Support |

### Technical Support queue → `cf_inquiry_type_tech_support`

Disposition names match Desk picklist values exactly (no translation table). Currently configured: `Customer Service`, `Dealer Relations`, `Homeowner/Non-Dealer`, `Internal`, `Other`, `Sales`, `Tech Support`, `Warranty`.

The **Warranty** queue (`ZWQ5300518494B9414472F2EF51769E4DD2`, flow `Warranty_Voice`) and
`Technical Support_SMS` both route here too, so their dispositions must exist in this same
picklist. Observed from the Warranty queue so far: `Warranty`, `Tech Support`.

### Skip dispositions (both queues)

- `No Ticket Needed` — webhook is processed and recorded, but no Desk ticket is created

To add another skip disposition, edit `SKIP_TICKET_DISPOSITIONS` in [src/index.js](src/index.js).

## Key IDs (non-secret, repo-safe)

| Resource | Value |
|---|---|
| Cloudflare account_id | `521c322a89a17bb69f91f1e65177606e` |
| KV namespace id | `5e7000fe8fba49b69a998298f7c6c476` |
| Zoho Desk org id | `736784923` |
| Desk dept — Tech Support | `570884000009266009` |
| Desk dept — Customer Service | `570884000000006907` |
| CRM Plus URL base | `https://crmplus.zoho.com/coastalsource/index.do/cxapp/crm/org728200559` |

## Secrets in Cloudflare

Set via `wrangler secret put <NAME>`, never committed:

- `ZOOM_API_KEY` — gates `/zoho/*` endpoints and popup inspection routes
- `ZOOM_WEBHOOK_SECRET` — Zoom HMAC verification + popup form token signing
- `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET` — S2S OAuth for Zoom CC API
- `ZOHO_REFRESH_TOKEN`, `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET` — Zoho OAuth
- `ZOHO_DESK_ORG_ID` = `736784923`
- `ZOHO_DESK_DEPARTMENT_TECHNICAL_SUPPORT` / `ZOHO_DESK_DEPARTMENT_CUSTOMER_SERVICE`
- `DESK_AUTO_CREATE_TICKETS` = `"true"`
- `ALERT_ZOOM_WEBHOOK_URL`, `ALERT_ZOOM_WEBHOOK_SECRET` — Zoom chat alert channel
- `ALERT_RESEND_API_KEY`, `ALERT_EMAIL_TO`, `ALERT_EMAIL_FROM` — email alert channel
- `ALERT_COOLDOWN_SECONDS` — optional, defaults to 3600

Not set, but referenced in code: `ZOHO_DESK_DEFAULT_DEPARTMENT_ID` (see department routing above).

`ZOOM_API_KEY` was rotated 2026-07-28 because the Zoom CC flow's HTTP widget was sending a
stale value and getting 401s. Any consumer of `/zoho/*` or `/zoom/*` inspection routes needs
the current value; `wrangler secret put` cannot read it back, so keep it in the password
manager. Note `wrangler secret put` creates a new Worker version but reuses the deployed
script — it will not push local code.

## Current Zoho OAuth scopes

Re-auth with this exact list if a refresh is ever needed:

```
ZohoCRM.modules.contacts.READ,ZohoCRM.modules.accounts.READ,ZohoCRM.modules.leads.READ,ZohoCRM.users.READ,ZohoCRM.modules.contacts.CREATE,ZohoCRM.modules.leads.CREATE,Desk.tickets.CREATE,Desk.contacts.READ,Desk.contacts.CREATE,Desk.search.READ,Desk.basic.READ
```

To swap a refresh token after a re-auth:

```
curl -s -X POST "https://accounts.zoho.com/oauth/v2/token" \
  -d "grant_type=authorization_code" \
  -d "client_id=<ZOHO_CLIENT_ID>" \
  -d "client_secret=<ZOHO_CLIENT_SECRET>" \
  -d "code=<NEW_GRANT_CODE>"

printf "<NEW_REFRESH_TOKEN>" | npx wrangler secret put ZOHO_REFRESH_TOKEN
npx wrangler kv key delete --namespace-id=5e7000fe8fba49b69a998298f7c6c476 zoho_token --remote
```

## Handy endpoints for debugging

All `GET`, require `x-api-key: <ZOOM_API_KEY>`:

- `/zoom/webhooks/recent` — last 20 captured webhook payloads
- `/zoom/webhooks/<id>` — fetch a specific payload
- `/zoho/lookup-by-phone?phone=+1...` — Zoho phone lookup used by popup + webhook
- `/zoho/desk/agents?email=...` — probe Desk agents endpoint, optionally filter by email
- `/zoom/engagement/<id>` — raw Zoom engagement
- `/zoom/engagement/<id>/probe` — hits several Zoom sub-paths to discover what data is exposed
- `/zoho/contact/<id>` — old vs new name derivation for one contact (debug aid for the
  `Full_Name` change; safe to delete once no longer needed)
- `/zoom/alert-test` — force-send a test alert on every configured channel

**Reading errors.** The worker `console.log`s throughout the webhook path — signature
failures, engagement fetch, Zoho lookup, owner resolution, Desk payload build and dispatch,
plus the whole processed record. `npx wrangler tail coastalsource --format=json` is the live
view. But Workers console output is ephemeral: nothing retains it, so a failure nobody was
watching leaves no trace there. The durable record is the `webhook:<ts>-<rand>` KV entries
(7-day TTL) — `desk_ticket_error` and `engagement_fetch_error` on each. To read them without
an API key, bulk-fetch straight from KV (max 100 keys per call):

```
npx wrangler kv key list --namespace-id=5e7000fe8fba49b69a998298f7c6c476 --remote
npx wrangler kv bulk get keys.json --namespace-id=5e7000fe8fba49b69a998298f7c6c476 --remote
```

Note `desk_ticket_error` also carries the intentional-skip messages, so it is not a pure
error field — filter out `intentionally skipped` before counting failures.

## Possible follow-ups (none blocking)

1. **Verify the alert channels actually deliver** — `GET /zoom/alert-test` force-sends on
   every configured channel. Nothing has confirmed `ALERT_ZOOM_WEBHOOK_URL` or the Resend
   key still work, and a dead channel fails silently (logged, then swallowed by
   `Promise.allSettled`). The `desk_dropped` alerting added 2026-07-28 is only as good as
   the channels underneath it.
2. **Set `ZOHO_DESK_DEFAULT_DEPARTMENT_ID`** — so an unrecognized queue lands somewhere a
   human will see instead of failing closed.
3. **Backfill the 11 Warranty-queue calls** dropped between 2026-07-23 and 2026-07-28.
   Engagement ids are in the KV `webhook:` records; two of them (`vy-lZUUTQZuqg4jbcFc4aQ`,
   `8IjeRKX_QauSDPG15z5xbA`) are the same Pratt Guys thread, so it's ~10 tickets.
4. **Trailing-slash footgun on the webhook catcher** — `catcherPaths` accepts
   `/zoom/webhooks` and `/zoom/webhooks/` but only `/zoom/engagement-webhook` without a
   trailing slash. A POST to `/zoom/engagement-webhook/` falls through to the api-key gate
   and returns 401 with no log line at all. Worth normalizing.
5. **Durable logs** — a Tail Worker or Logpush would keep the console output that currently
   vanishes unless someone is holding a `wrangler tail` open.
6. **`cx_engagement_end_data_ready` cleanup** — that older event is no longer the trigger; the route still matches it harmlessly and can be removed if cleaning up
7. **Lead dedup by phone** — leads currently can duplicate; popup form is fine with that, but could add a check if the customer prefers
8. **Disposition → Desk classification** — if reporting wants this in a first-class field rather than the cf_inquiry_type custom field, requires Desk classification config + a translation map
9. **Recording / transcript ingestion** — Zoom CC has scopes for these (`contact_center:read:list_recordings:admin`, etc.); not currently granted
