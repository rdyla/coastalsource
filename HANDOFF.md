# Handoff — pick-up notes

Last touched 2026-04-21 via commit `c00a555`.

## Where this is

End-to-end Zoom Contact Center ↔ Zoho CRM + Zoho Desk integration deployed at `https://coastalsource.itcontact-521.workers.dev`.

### Working and live today

- **Webhook → Desk ticket** on `contact_center.engagement_disposition_added`
  - Queue-name routing: Technical Support → dept `570884000009266009`, Customer Service → `570884000000006907`
  - Subject: `<disposition> — <first note excerpt>` (note truncated at 80 chars)
  - HTML description with agent notes, disposition, queue, agent, durations
  - Contact linked via Desk `contactId` when CRM↔Desk sync has the caller
  - Owner mapping: Zoom agent → Zoho user via email, 30-day KV cache
  - Duplicate webhook protection: claim-then-reverify-ownership on `engagement_seen:<id>` KV key
  - Auto-dispatch controlled by `DESK_AUTO_CREATE_TICKETS="true"` secret

- **Agent popup** at `/popup?phone=<ANI>&engagement_id=<id>`
  - Contact match by phone → 302 to `/tab/Contacts/<id>`
  - Account-only match → 302 to `/tab/Accounts/<id>`
  - No match → HTML form with HMAC-signed token (30-min TTL)

- **Popup form** (deployed but lead path blocked — see below)
  - Live account autocomplete via `GET /popup/accounts/search`
  - Pick an account → creates Contact linked to that account (works today)
  - No account → tries to create Lead (needs new scope)

## Blocked on

**Zoho OAuth needs `ZohoCRM.modules.leads.CREATE` added**

The lead-create code path is fully wired. It will return 403 on submit until the scope is granted.

### When customer sends the new grant code tomorrow:

1. Exchange it — use the same client id/secret unless they regenerated:
   ```
   curl -s -X POST "https://accounts.zoho.com/oauth/v2/token" \
     -d "grant_type=authorization_code" \
     -d "client_id=<ZOHO_CLIENT_ID>" \
     -d "client_secret=<ZOHO_CLIENT_SECRET>" \
     -d "code=<NEW_GRANT_CODE>"
   ```

2. Update the refresh token:
   ```
   printf "<NEW_REFRESH_TOKEN>" | npx wrangler secret put ZOHO_REFRESH_TOKEN
   ```

3. Purge the cached access token so the next request mints a fresh one with full scopes:
   ```
   npx wrangler kv key delete --namespace-id=5e7000fe8fba49b69a998298f7c6c476 zoho_token --remote
   ```

4. Test a popup submit with no account picked — should land in Zoho as a Lead.

### Scope list to paste into the Zoho self-client grant form:

```
ZohoCRM.modules.contacts.READ,ZohoCRM.modules.accounts.READ,ZohoCRM.modules.leads.READ,ZohoCRM.users.READ,ZohoCRM.modules.contacts.CREATE,ZohoCRM.modules.leads.CREATE,Desk.tickets.CREATE,Desk.contacts.READ,Desk.contacts.CREATE,Desk.search.READ
```

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
- `DESK_AUTO_CREATE_TICKETS` = `"true"` (set to disable dispatch without redeploy)

## Handy endpoints for debugging

All `GET`, require `x-api-key: <ZOOM_API_KEY>`:

- `/zoom/webhooks/recent` — last 20 captured webhook payloads
- `/zoom/webhooks/<id>` — fetch a specific payload
- `/zoho/lookup-by-phone?phone=+1...` — Zoho phone lookup used by popup + webhook
- `/zoom/engagement/<id>` — raw Zoom engagement
- `/zoom/engagement/<id>/probe` — hits several Zoom sub-paths to discover what data is exposed

## After lead scope lands — follow-ups worth considering

1. Map Zoom `disposition_name` → Zoho Desk `classification` field so dispositions are filterable/reportable in Desk (requires pre-created classifications in Desk)
2. Optional dedup on Lead create by phone (leads normally tolerate duplicates, but customer may prefer)
3. Possibly retire the old `cx_engagement_end_data_ready` webhook handler now that `engagement_disposition_added` is the sole trigger (currently unused but still matched)
