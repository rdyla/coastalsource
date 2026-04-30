# Handoff — pick-up notes

Last touched 2026-04-30 via commit `bea025b`.

## Where this is

End-to-end Zoom Contact Center ↔ Zoho CRM + Zoho Desk integration deployed at `https://coastalsource.itcontact-521.workers.dev`. Customer Service and Technical Support queues are both production-ready.

## Working today

### Webhook → Desk ticket

Triggered on `contact_center.engagement_disposition_added`.

- **Department routing** by queue name on the engagement
  - "Technical Support" → dept `570884000009266009`
  - "Customer Service" → dept `570884000000006907`
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

## Possible follow-ups (none blocking)

1. **`cx_engagement_end_data_ready` cleanup** — that older event is no longer the trigger; the route still matches it harmlessly and can be removed if cleaning up
2. **Lead dedup by phone** — leads currently can duplicate; popup form is fine with that, but could add a check if the customer prefers
3. **Disposition → Desk classification** — if reporting wants this in a first-class field rather than the cf_inquiry_type custom field, requires Desk classification config + a translation map
4. **Recording / transcript ingestion** — Zoom CC has scopes for these (`contact_center:read:list_recordings:admin`, etc.); not currently granted
