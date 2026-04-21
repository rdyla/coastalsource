export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    try {
      if (url.pathname.startsWith("/zoho/")) {
        return await handleZohoRoutes(request, env, ctx, url);
      }
      if (url.pathname.startsWith("/zoom/")) {
        return await handleZoomRoutes(request, env, ctx, url);
      }
      if (url.pathname === "/popup" || url.pathname.startsWith("/popup/")) {
        return await handlePopupRoutes(request, env, ctx, url);
      }
      return json({ error: "Not Found" }, 404);
    } catch (err) {
      if (err?.details && err?.status) {
        return json({ error: "Upstream request failed", details: err.details }, err.status);
      }
      return json({ error: "Worker error", message: String(err?.message || err) }, 500);
    }
  },
};

/* -----------------------------
 * Zoho route dispatcher
 * ----------------------------- */

async function handleZohoRoutes(request, env, ctx, url) {
  const authErr = requireApiKey(request, env);
  if (authErr) return authErr;

  const routes = {
    "GET /zoho/leads": handleLeads,
    "GET /zoho/account-summary": handleAccountSummary,
    "GET /zoho/lookup-by-phone": handleLookupByPhone,
    "POST /zoho/create-contact": handleCreateContact,
  };

  const handler = routes[`${request.method} ${url.pathname}`];
  if (!handler) return json({ error: "Not Found" }, 404);

  return handler(request, env, ctx, url);
}

/* -----------------------------
 * Zoom route dispatcher
 * ----------------------------- */

async function handleZoomRoutes(request, env, ctx, url) {
  // Webhook catcher — Zoom POSTs here. Unauthenticated for now so we can
  // observe what headers Zoom actually sends; lock down once known.
  const catcherPaths = new Set([
    "/zoom/engagement-webhook",
    "/zoom/webhooks",
    "/zoom/webhooks/",
  ]);
  if (request.method === "POST" && catcherPaths.has(url.pathname)) {
    return handleWebhookCatch(request, env, ctx, url);
  }

  // Inspection endpoints require the same x-api-key as /zoho/*
  const authErr = requireApiKey(request, env);
  if (authErr) return authErr;

  if (url.pathname === "/zoom/webhooks/recent" && request.method === "GET") {
    return handleWebhooksRecent(request, env);
  }

  const idMatch = url.pathname.match(/^\/zoom\/webhooks\/([^/]+)$/);
  if (idMatch) {
    const id = decodeURIComponent(idMatch[1]);
    if (request.method === "GET") return handleWebhookGet(env, id);
    if (request.method === "DELETE") return handleWebhookDelete(env, id);
  }

  const engagementMatch = url.pathname.match(/^\/zoom\/engagement\/([^/]+)$/);
  if (engagementMatch && request.method === "GET") {
    const engagementId = decodeURIComponent(engagementMatch[1]);
    return handleEngagementFetch(env, engagementId);
  }

  return json({ error: "Not Found" }, 404);
}

async function handleEngagementFetch(env, engagementId) {
  const details = await fetchZoomEngagement(env, engagementId);
  return json(details);
}

/* -----------------------------
 * Webhook catcher + inspection
 * ----------------------------- */

async function handleWebhookCatch(request, env, ctx, url) {
  const rawBody = await request.text();

  let parsedBody = null;
  try {
    parsedBody = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    parsedBody = null;
  }

  // URL validation challenge — must respond synchronously with the encrypted token.
  if (
    parsedBody?.event === "endpoint.url_validation" &&
    parsedBody?.payload?.plainToken
  ) {
    const plainToken = parsedBody.payload.plainToken;
    if (!env.ZOOM_WEBHOOK_SECRET) {
      return json({ error: "ZOOM_WEBHOOK_SECRET not configured" }, 500);
    }
    const encryptedToken = await hmacSha256Hex(env.ZOOM_WEBHOOK_SECRET, plainToken);
    return json({ plainToken, encryptedToken });
  }

  // Verify signature synchronously so invalid requests still get rejected fast.
  const sigResult = await verifyZoomSignature(request, rawBody, env);
  if (!sigResult.ok) {
    console.log("Zoom signature verification failed:", sigResult.reason);
    return json({ error: "Invalid signature", reason: sigResult.reason }, 401);
  }

  const headers = {};
  for (const [k, v] of request.headers.entries()) headers[k] = v;

  const query = {};
  for (const [k, v] of url.searchParams.entries()) query[k] = v;

  const receivedAt = new Date().toISOString();
  const id = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

  // Hand off the heavy work (engagement fetch, Zoho lookup, owner resolution,
  // storage) to run in the background so Zoom gets an immediate 200.
  ctx.waitUntil(
    processEngagementWebhook(env, {
      id,
      receivedAt,
      method: request.method,
      path: url.pathname,
      query,
      headers,
      rawBody,
      parsedBody,
    }).catch((err) => {
      console.log("processEngagementWebhook failed:", String(err?.message || err));
    })
  );

  return json({ ok: true, id });
}

async function processEngagementWebhook(env, data) {
  const {
    id,
    receivedAt,
    method,
    path,
    query,
    headers,
    rawBody,
    parsedBody,
  } = data;

  const eventName = parsedBody?.event;
  const engagementId = parsedBody?.payload?.object?.engagement_id;
  const isEngagementReady =
    eventName === "contact_center.cx_engagement_end_data_ready" && engagementId;

  let duplicateOf = null;
  if (isEngagementReady && env.coastalsource_kv) {
    duplicateOf = await env.coastalsource_kv.get(`engagement_seen:${engagementId}`);
  }

  let engagementDetails = null;
  let engagementFetchError = null;
  let phoneLookupResult = null;
  let ownerResolution = null;
  let zohoCreatePayload = null;

  if (isEngagementReady && !duplicateOf) {
    try {
      engagementDetails = await fetchZoomEngagement(env, engagementId);
    } catch (err) {
      engagementFetchError = String(err?.message || err);
      console.log("Zoom engagement fetch failed:", engagementFetchError);
    }

    const callerPhone = engagementDetails?.consumers?.[0]?.consumer_number || null;
    if (callerPhone) {
      try {
        phoneLookupResult = await lookupZohoByPhone(env, callerPhone);
      } catch (err) {
        console.log("Zoho phone lookup failed:", String(err?.message || err));
      }

      if (phoneLookupResult && !phoneLookupResult.found) {
        const agentUserId = extractPrimaryAgentId(engagementDetails);
        if (agentUserId) {
          try {
            ownerResolution = await resolveZohoOwnerForZoomAgent(env, agentUserId);
          } catch (err) {
            ownerResolution = {
              zoom_user_id: agentUserId,
              zoho_user_id: null,
              error: String(err?.message || err),
              error_status: err?.status ?? null,
              error_details: err?.details ?? null,
            };
            console.log("Owner resolution failed:", JSON.stringify(ownerResolution));
          }
        }

        zohoCreatePayload = buildZohoContactCreatePayload({
          phone: callerPhone,
          engagementId,
          receivedAt,
          ownerId: ownerResolution?.zoho_user_id || null,
        });
      }
    }

    if (env.coastalsource_kv) {
      await env.coastalsource_kv.put(`engagement_seen:${engagementId}`, id, {
        expirationTtl: 60 * 60 * 24 * 7,
      });
    }
  }

  const record = {
    id,
    received_at: receivedAt,
    method,
    path,
    query,
    headers,
    raw_body: rawBody,
    parsed_body: parsedBody,
    duplicate_of: duplicateOf,
    engagement_details: engagementDetails,
    engagement_fetch_error: engagementFetchError,
    phone_lookup_result: phoneLookupResult,
    owner_resolution: ownerResolution,
    zoho_create_payload: zohoCreatePayload,
    zoho_create_dispatched: false,
  };

  console.log("Zoom webhook processed:", JSON.stringify(record));

  if (env.coastalsource_kv) {
    await env.coastalsource_kv.put(`webhook:${id}`, JSON.stringify(record), {
      expirationTtl: 60 * 60 * 24 * 7,
    });
  }
}

function extractPrimaryAgentId(engagementDetails) {
  if (Array.isArray(engagementDetails?.agents) && engagementDetails.agents.length > 0) {
    const a = engagementDetails.agents[0];
    if (a?.user_id) return a.user_id;
  }
  const events = engagementDetails?.events || [];
  const accept = events.find((e) => e?.event_type === "Agent Accept" && e?.user_id);
  return accept?.user_id || null;
}

async function resolveZohoOwnerForZoomAgent(env, zoomUserId) {
  const cacheKey = `zoom_to_zoho_user:${zoomUserId}`;
  if (env.coastalsource_kv) {
    const cached = await env.coastalsource_kv.get(cacheKey, { type: "json" });
    if (cached?.zoho_user_id) {
      return { ...cached, source: "cache" };
    }
  }

  const zoomToken = await getZoomAccessToken(env);
  const zoomRes = await fetch(
    `https://api.zoom.us/v2/users/${encodeURIComponent(zoomUserId)}`,
    { headers: { Authorization: `Bearer ${zoomToken}` } }
  );
  const zoomText = await zoomRes.text();
  let zoomUser = null;
  try {
    zoomUser = zoomText ? JSON.parse(zoomText) : null;
  } catch {
    zoomUser = null;
  }
  if (!zoomRes.ok) {
    throw new Error(`Zoom user lookup failed: ${zoomRes.status} ${zoomText?.slice(0, 200)}`);
  }
  const email = zoomUser?.email || null;
  if (!email) {
    return { zoom_user_id: zoomUserId, email: null, zoho_user_id: null, error: "Zoom user has no email" };
  }

  const zohoUserId = await findZohoUserByEmail(env, email);
  const result = {
    zoom_user_id: zoomUserId,
    email,
    zoho_user_id: zohoUserId,
    source: "fresh",
  };

  if (zohoUserId && env.coastalsource_kv) {
    await env.coastalsource_kv.put(
      cacheKey,
      JSON.stringify({ zoom_user_id: zoomUserId, email, zoho_user_id: zohoUserId }),
      { expirationTtl: 60 * 60 * 24 * 30 }
    );
  }

  return result;
}

async function findZohoUserByEmail(env, email) {
  const token = await getZohoAccessToken(env);
  const target = email.toLowerCase();
  const perPage = 200;
  for (let page = 1; page <= 10; page++) {
    const zohoUrl =
      `https://www.zohoapis.com/crm/v2/users?type=AllUsers&page=${page}&per_page=${perPage}`;
    const data = await callZoho(env, token, zohoUrl);
    const users = Array.isArray(data?.users) ? data.users : [];
    const match = users.find((u) => (u?.email || "").toLowerCase() === target);
    if (match) return match.id;
    if (!data?.info?.more_records) return null;
  }
  return null;
}

async function verifyZoomSignature(request, rawBody, env) {
  if (!env.ZOOM_WEBHOOK_SECRET) {
    return { ok: false, reason: "ZOOM_WEBHOOK_SECRET not configured" };
  }
  const sigHeader = request.headers.get("x-zm-signature");
  const ts = request.headers.get("x-zm-request-timestamp");
  if (!sigHeader || !ts) {
    return { ok: false, reason: "missing signature headers" };
  }

  // Reject timestamps older than 5 minutes to limit replay window.
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() / 1000 - tsNum) > 300) {
    return { ok: false, reason: "timestamp out of range" };
  }

  const message = `v0:${ts}:${rawBody}`;
  const expected = `v0=${await hmacSha256Hex(env.ZOOM_WEBHOOK_SECRET, message)}`;

  if (!timingSafeEqualStr(sigHeader, expected)) {
    return { ok: false, reason: "signature mismatch" };
  }
  return { ok: true };
}

function timingSafeEqualStr(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function hmacSha256Hex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function handleWebhooksRecent(request, env) {
  if (!env.coastalsource_kv) {
    return json({ error: "KV not bound" }, 500);
  }

  const list = await env.coastalsource_kv.list({ prefix: "webhook:", limit: 100 });
  const keys = list.keys.map((k) => k.name).sort().reverse().slice(0, 20);

  const records = await Promise.all(
    keys.map((k) => env.coastalsource_kv.get(k, { type: "json" }))
  );

  return json({ count: records.length, webhooks: records.filter(Boolean) });
}

async function handleWebhookGet(env, id) {
  if (!env.coastalsource_kv) return json({ error: "KV not bound" }, 500);
  const record = await env.coastalsource_kv.get(`webhook:${id}`, { type: "json" });
  if (!record) return json({ error: "Not Found" }, 404);
  return json(record);
}

async function handleWebhookDelete(env, id) {
  if (!env.coastalsource_kv) return json({ error: "KV not bound" }, 500);
  await env.coastalsource_kv.delete(`webhook:${id}`);
  return json({ ok: true, deleted: id });
}

/* -----------------------------
 * Route Handlers: Leads
 * ----------------------------- */

async function handleLeads(request, env, ctx, url) {
  const email = url.searchParams.get("email");
  const phone = url.searchParams.get("phone");
  const leadId = url.searchParams.get("leadId");

  const accessToken = await getZohoAccessToken(env);

  let zohoUrl;
  if (leadId) {
    zohoUrl = `https://www.zohoapis.com/crm/v2/Leads/${encodeURIComponent(leadId)}`;
  } else if (email || phone) {
    const parts = [];
    if (email) parts.push(`(Email:equals:${email})`);
    if (phone) parts.push(`(Phone:equals:${phone})`);
    const criteria = parts.length === 1 ? parts[0] : `(${parts.join("and")})`;
    zohoUrl =
      `https://www.zohoapis.com/crm/v2/Leads/search?criteria=` +
      encodeURIComponent(criteria);
  } else {
    zohoUrl = "https://www.zohoapis.com/crm/v2/Leads?per_page=5";
  }

  const zohoJson = await callZoho(env, accessToken, zohoUrl);

  const records = Array.isArray(zohoJson.data)
    ? zohoJson.data
    : zohoJson.data
      ? [zohoJson.data]
      : [];

  const leads = records.map((l) => ({
    id: l.id,
    name: [l.First_Name, l.Last_Name].filter(Boolean).join(" "),
    email: l.Email,
    company: l.Company,
    phone: l.Phone,
    status: l.Lead_Status,
    owner: l?.Owner?.name,
    modified_time: l.Modified_Time,
  }));

  return json({ leads, count: leads.length });
}

/* -----------------------------
 * Route Handlers: Account lookup by phone
 * ----------------------------- */

async function handleLookupByPhone(request, env, ctx, url) {
  const phoneRaw = url.searchParams.get("phone");
  if (!phoneRaw) return json({ error: "Missing query param", required: ["phone"] }, 400);
  return json(await lookupZohoByPhone(env, phoneRaw));
}

async function handleCreateContact(request, env, ctx, url) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const phone = body?.phone ? String(body.phone).trim() : null;
  if (!phone) {
    return json({ error: "Missing required field", required: ["phone"] }, 400);
  }

  const dedupe = body?.dedupe !== false; // default true
  const dryRun = body?.dry_run !== false; // default true — explicit opt-in for real writes

  let existing = null;
  if (dedupe) {
    try {
      const lookup = await lookupZohoByPhone(env, phone);
      if (lookup.found && lookup.match_type === "contact" && lookup.contact) {
        existing = lookup.contact;
      }
    } catch (err) {
      console.log("Dedupe lookup failed:", String(err?.message || err));
    }
  }

  if (existing) {
    return json({
      created: false,
      matched_existing: true,
      dry_run: dryRun,
      contact: existing,
    });
  }

  const record = {
    Last_Name: body.last_name || "Unknown Caller",
    Phone: phone,
    Lead_Source: body.lead_source || "Inbound Call",
  };
  if (body.first_name) record.First_Name = body.first_name;
  if (body.email) record.Email = body.email;
  if (body.description) {
    record.Description = body.description;
  } else if (body.engagement_id) {
    record.Description =
      `Auto-created from Zoom Contact Center engagement ${body.engagement_id} ` +
      `received ${new Date().toISOString()}`;
  }

  let ownerResolution = null;
  if (body.zoom_agent_user_id) {
    try {
      ownerResolution = await resolveZohoOwnerForZoomAgent(env, body.zoom_agent_user_id);
      if (ownerResolution?.zoho_user_id) {
        record.Owner = { id: ownerResolution.zoho_user_id };
      }
    } catch (err) {
      ownerResolution = {
        zoom_user_id: body.zoom_agent_user_id,
        zoho_user_id: null,
        error: String(err?.message || err),
        error_status: err?.status ?? null,
        error_details: err?.details ?? null,
      };
      console.log("Owner resolution failed in create-contact:", JSON.stringify(ownerResolution));
    }
  }

  const zohoPayload = { data: [record] };

  if (dryRun) {
    return json({
      created: false,
      dry_run: true,
      matched_existing: false,
      proposed_payload: {
        method: "POST",
        url: "https://www.zohoapis.com/crm/v2/Contacts",
        body: zohoPayload,
      },
      owner_resolution: ownerResolution,
    });
  }

  const token = await getZohoAccessToken(env);
  const zohoRes = await fetch("https://www.zohoapis.com/crm/v2/Contacts", {
    method: "POST",
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(zohoPayload),
  });
  const text = await zohoRes.text();
  let zohoJson = null;
  try {
    zohoJson = text ? JSON.parse(text) : null;
  } catch {
    zohoJson = { raw: text };
  }

  if (!zohoRes.ok) {
    return json(
      {
        created: false,
        dry_run: false,
        error: "Zoho create failed",
        zoho_status: zohoRes.status,
        zoho_response: zohoJson,
        proposed_payload: { body: zohoPayload },
      },
      502
    );
  }

  const first = zohoJson?.data?.[0];
  if (first?.status === "success" && first?.details?.id) {
    return json({
      created: true,
      dry_run: false,
      matched_existing: false,
      contact: {
        id: first.details.id,
        phone,
        first_name: record.First_Name || null,
        last_name: record.Last_Name,
        email: record.Email || null,
        owner_id: record.Owner?.id || null,
      },
      owner_resolution: ownerResolution,
      zoho_response: zohoJson,
    });
  }

  return json(
    {
      created: false,
      dry_run: false,
      error: "Unexpected Zoho response shape",
      zoho_response: zohoJson,
    },
    500
  );
}

async function lookupZohoByPhone(env, phoneRaw) {
  const accessToken = await getZohoAccessToken(env);

  const digits = String(phoneRaw).replace(/\D/g, "");
  const candidates = buildPhoneCandidates(digits);

  for (const p of candidates) {
    const contact = await tryFindContactByPhone(env, accessToken, p);
    if (contact) {
      const accountId = contact?.Account_Name?.id || null;
      let accountSummary = null;
      if (accountId) {
        accountSummary = await fetchAccountSummaryById(env, accessToken, accountId);
      }
      return {
        found: true,
        match_type: "contact",
        phone_normalized: p,
        contact: {
          id: contact.id,
          name: [contact.First_Name, contact.Last_Name].filter(Boolean).join(" "),
          email: contact.Email ?? null,
          phone: contact.Phone ?? null,
          mobile: contact.Mobile ?? null,
          rep: contact.Rep ?? null,
          account_id: accountId,
          account_name: contact?.Account_Name?.name ?? null,
          owner_name: contact?.Owner?.name ?? null,
          modified_time: contact.Modified_Time ?? null,
        },
        account: accountSummary,
      };
    }
  }

  for (const p of candidates) {
    const account = await tryFindAccountByPhone(env, accessToken, p);
    if (account) {
      return {
        found: true,
        match_type: "account",
        phone_normalized: p,
        contact: null,
        account: summarizeAccount(account),
      };
    }
  }

  return { found: false, match_type: null, contact: null, account: null };
}

async function tryFindContactByPhone(env, token, phoneCandidate) {
  const fieldsToTry = ["Phone", "Mobile", "Other_Phone"];

  for (const field of fieldsToTry) {
    const criteria = `(${field}:equals:${phoneCandidate})`;
    const zohoUrl =
      `https://www.zohoapis.com/crm/v2/Contacts/search?criteria=` +
      encodeURIComponent(criteria);

    try {
      const zohoJson = await callZoho(env, token, zohoUrl);
      if (Array.isArray(zohoJson.data) && zohoJson.data.length > 0) {
        return zohoJson.data[0];
      }
    } catch (err) {
      if (
        err?.details?.code === "INVALID_QUERY" &&
        err?.details?.details?.reason?.includes("field is not available for search")
      ) {
        continue;
      }
      throw err;
    }
  }

  return null;
}

async function tryFindAccountByPhone(env, token, phoneCandidate) {
  const criteria = `(Phone:equals:${phoneCandidate})`;
  const zohoUrl =
    `https://www.zohoapis.com/crm/v2/Accounts/search?criteria=` +
    encodeURIComponent(criteria);

  const zohoJson = await callZoho(env, token, zohoUrl);
  if (Array.isArray(zohoJson.data) && zohoJson.data.length > 0) {
    return zohoJson.data[0];
  }
  return null;
}

async function fetchAccountSummaryById(env, token, accountId) {
  const zohoUrl = `https://www.zohoapis.com/crm/v2/Accounts/${encodeURIComponent(accountId)}`;
  const zohoJson = await callZoho(env, token, zohoUrl);
  const record = Array.isArray(zohoJson.data) ? zohoJson.data[0] : zohoJson.data;
  if (!record) return null;
  return summarizeAccount(record);
}

function summarizeAccount(record) {
  return {
    id: record.id,
    account_name: record.Account_Name ?? null,
    website: record.Website ?? null,

    compass_id: record.Compass_ID ?? null,
    account_type: record.Account_Type ?? null,
    dealer_tier: record.Dealer_Tier ?? null,
    kam_owner: record.KAM_Owner ?? null,
    rep_firm: record.Rep_Firm ?? null,
    dealer_start_date: record.Dealer_Start_Date ?? null,

    owner_name: record?.Owner?.name ?? null,
    owner_email: record?.Owner?.email ?? null,
    phone: record.Phone ?? null,
    email_address: record.Email_Address ?? null,
    modified_time: record.Modified_Time ?? null,
  };
}

function buildZohoContactCreatePayload({ phone, engagementId, receivedAt, ownerId }) {
  const record = {
    Last_Name: "Unknown Caller",
    Phone: phone,
    Lead_Source: "Inbound Call",
    Description:
      `Auto-created from Zoom Contact Center engagement ${engagementId} ` +
      `received ${receivedAt}`,
  };
  if (ownerId) {
    record.Owner = { id: ownerId };
  }
  return {
    method: "POST",
    url: "https://www.zohoapis.com/crm/v2/Contacts",
    body: { data: [record] },
  };
}

async function handleAccountSummary(request, env, ctx, url) {
  const accountId = url.searchParams.get("accountId");
  const email = url.searchParams.get("email");
  const domainParam = url.searchParams.get("domain");
  const name = url.searchParams.get("name");

  const accessToken = await getZohoAccessToken(env);

  // derive domain from email if present
  let domain = domainParam;
  if (!domain && email && email.includes("@")) domain = email.split("@")[1]?.toLowerCase();

  let zohoUrl = null;

  if (accountId) {
    zohoUrl = `https://www.zohoapis.com/crm/v2/Accounts/${encodeURIComponent(accountId)}`;
  } else if (domain) {
    const criteria = `(Website:contains:${domain})`;
    zohoUrl =
      `https://www.zohoapis.com/crm/v2/Accounts/search?criteria=` +
      encodeURIComponent(criteria);
  } else if (name) {
    const criteria = `(Account_Name:contains:${name})`;
    zohoUrl =
      `https://www.zohoapis.com/crm/v2/Accounts/search?criteria=` +
      encodeURIComponent(criteria);
  } else {
    return json(
      { error: "Missing query param", required: ["accountId OR domain OR email OR name"] },
      400
    );
  }

  const zohoJson = await callZoho(env, accessToken, zohoUrl);

  // If search, pick first match; if direct GET, data may not be an array
  const record = Array.isArray(zohoJson.data)
    ? zohoJson.data[0]
    : zohoJson.data || null;

  if (!record) return json({ found: false, account: null });

  // Customer-required fields (API names validated from your sample payload)
  const summary = {
    id: record.id,
    account_name: record.Account_Name ?? null,
    website: record.Website ?? null,

    account_type: record.Account_Type ?? null,        // "Account Type"
    dealer_tier: record.Dealer_Tier ?? null,          // "Dealer Tier"
    kam_owner: record.KAM_Owner ?? null,              // "KAM Owner"
    rep_firm: record.Rep_Firm ?? null,                // "Rep Firm"
    dealer_start_date: record.Dealer_Start_Date ?? null, // "Dealer Start Date"

    // useful extras
    owner_name: record?.Owner?.name ?? null,
    owner_email: record?.Owner?.email ?? null,
    phone: record.Phone ?? null,
    email_address: record.Email_Address ?? null,
    modified_time: record.Modified_Time ?? null,
  };

  return json({ found: true, account: summary });
}

/* -----------------------------
 * Shared Helpers
 * ----------------------------- */

function requireApiKey(request, env) {
  const apiKey = request.headers.get("x-api-key");
  if (!apiKey || apiKey !== env.ZOOM_API_KEY) {
    return json({ error: "Unauthorized" }, 401);
  }
  return null;
}

function buildPhoneCandidates(digits) {
  // If you get a US 10-digit number, also try with leading 1
  const out = new Set();
  if (!digits) return [];

  // raw digits as-is
  out.add(digits);

  // If it’s 11 digits starting with 1, add 10-digit version too
  if (digits.length === 11 && digits.startsWith("1")) {
    out.add(digits.slice(1));
  }

  // If it’s 10 digits, add +1 version too
  if (digits.length === 10) {
    out.add("1" + digits);
  }

  return [...out];
}

async function callZoho(env, accessToken, zohoUrl) {
  const zohoRes = await fetch(zohoUrl, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
  });

  const text = await zohoRes.text();

  // Try to parse JSON, but don't crash if it's empty or HTML
  let zohoJson = null;
  try {
    zohoJson = text ? JSON.parse(text) : null;
  } catch {
    zohoJson = null;
  }

  if (!zohoRes.ok) {
    // If token is invalid/expired unexpectedly, clear cache then bubble error
    const maybeCode = zohoJson?.code;
    if (maybeCode === "INVALID_TOKEN" || zohoRes.status === 401) {
      await clearCachedToken(env);
    }

    const err = new Error("Zoho request failed");
    err.status = zohoRes.status;
    err.details = zohoJson ?? { raw: text?.slice(0, 2000) || null }; // include a snippet for debugging
    throw err;
  }

  // If Zoho replied OK but it's not JSON, still return something usable for debugging
  if (!zohoJson) {
    return { raw: text };
  }

  return zohoJson;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/**
 * Token caching strategy:
 * - Prefer KV if bound (coastalsource_kv)
 * - Fallback to in-memory per-isolate cache
 */
let memoryToken = null;
let memoryTokenExpMs = 0;

async function getZohoAccessToken(env) {
  const now = Date.now();

  if (env.coastalsource_kv) {
    const raw = await env.coastalsource_kv.get("zoho_token", { type: "json" });
    if (raw?.access_token && raw?.exp_ms && now < raw.exp_ms - 30_000) {
      return raw.access_token;
    }
  } else {
    if (memoryToken && now < memoryTokenExpMs - 30_000) return memoryToken;
  }

  const body = new URLSearchParams({
    refresh_token: env.ZOHO_REFRESH_TOKEN,
    client_id: env.ZOHO_CLIENT_ID,
    client_secret: env.ZOHO_CLIENT_SECRET,
    grant_type: "refresh_token",
  });

  const res = await fetch("https://accounts.zoho.com/oauth/v2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(`Zoho refresh failed: ${JSON.stringify(data)}`);
  }

  const expiresInSec = Number(data.expires_in) || 3600;
  const expMs = now + expiresInSec * 1000;

  if (env.coastalsource_kv) {
    await env.coastalsource_kv.put(
      "zoho_token",
      JSON.stringify({ access_token: data.access_token, exp_ms: expMs }),
      { expirationTtl: expiresInSec }
    );
  } else {
    memoryToken = data.access_token;
    memoryTokenExpMs = expMs;
  }

  return data.access_token;
}

async function clearCachedToken(env) {
  memoryToken = null;
  memoryTokenExpMs = 0;
  if (env.coastalsource_kv) {
    await env.coastalsource_kv.delete("zoho_token");
  }
}

/* -----------------------------
 * Zoom S2S OAuth + Contact Center API
 * ----------------------------- */

let zoomMemoryToken = null;
let zoomMemoryTokenExpMs = 0;

async function getZoomAccessToken(env) {
  const now = Date.now();

  if (env.coastalsource_kv) {
    const raw = await env.coastalsource_kv.get("zoom_token", { type: "json" });
    if (raw?.access_token && raw?.exp_ms && now < raw.exp_ms - 30_000) {
      return raw.access_token;
    }
  } else if (zoomMemoryToken && now < zoomMemoryTokenExpMs - 30_000) {
    return zoomMemoryToken;
  }

  if (!env.ZOOM_ACCOUNT_ID || !env.ZOOM_CLIENT_ID || !env.ZOOM_CLIENT_SECRET) {
    throw new Error("Zoom S2S OAuth credentials not configured");
  }

  const basic = btoa(`${env.ZOOM_CLIENT_ID}:${env.ZOOM_CLIENT_SECRET}`);
  const tokenUrl =
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=` +
    encodeURIComponent(env.ZOOM_ACCOUNT_ID);

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}` },
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(`Zoom token request failed: ${JSON.stringify(data)}`);
  }

  const expiresInSec = Number(data.expires_in) || 3600;
  const expMs = now + expiresInSec * 1000;

  if (env.coastalsource_kv) {
    await env.coastalsource_kv.put(
      "zoom_token",
      JSON.stringify({ access_token: data.access_token, exp_ms: expMs }),
      { expirationTtl: expiresInSec }
    );
  } else {
    zoomMemoryToken = data.access_token;
    zoomMemoryTokenExpMs = expMs;
  }

  return data.access_token;
}

async function fetchZoomEngagement(env, engagementId) {
  const token = await getZoomAccessToken(env);
  const zoomUrl =
    `https://api.zoom.us/v2/contact_center/engagements/` +
    encodeURIComponent(engagementId);

  const res = await fetch(zoomUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }

  if (!res.ok) {
    if (res.status === 401 && env.coastalsource_kv) {
      await env.coastalsource_kv.delete("zoom_token");
    }
    const err = new Error("Zoom engagement fetch failed");
    err.status = res.status;
    err.details = body;
    throw err;
  }

  return body;
}

/* -----------------------------
 * Popup page: screen-pop entry + create-contact form
 * ----------------------------- */

const ZOHO_SEARCH_URL_BASE =
  "https://crmplus.zoho.com/coastalsource/index.do/cxapp/crm/org728200559/search";

async function handlePopupRoutes(request, env, ctx, url) {
  if (url.pathname === "/popup" && request.method === "GET") {
    return handlePopupEntry(env, url);
  }
  if (url.pathname === "/popup/submit" && request.method === "POST") {
    return handlePopupSubmit(request, env);
  }
  return htmlResponse("<h1>Not Found</h1>", 404);
}

async function handlePopupEntry(env, url) {
  const phone = (url.searchParams.get("phone") || "").trim();
  const engagementId = (url.searchParams.get("engagement_id") || "").trim();

  if (!phone) {
    return htmlResponse("<h1>Missing phone parameter</h1>", 400);
  }

  let lookup;
  try {
    lookup = await lookupZohoByPhone(env, phone);
  } catch (err) {
    return htmlResponse(
      `<h1>Lookup failed</h1><pre>${escapeHtml(String(err?.message || err))}</pre>`,
      500
    );
  }

  if (lookup.found) {
    const searchword = lookup.account?.compass_id || phone;
    return Response.redirect(zohoSearchUrl(searchword), 302);
  }

  const expiresAt = Date.now() + 30 * 60 * 1000;
  const token = await generatePopupToken(env, phone, engagementId, expiresAt);
  return htmlResponse(renderCreateForm({ phone, engagementId, token, expiresAt }));
}

async function handlePopupSubmit(request, env) {
  const form = await request.formData();

  const phone = String(form.get("phone") || "").trim();
  const engagementId = String(form.get("engagement_id") || "").trim();
  const token = String(form.get("token") || "");
  const expiresAt = Number(form.get("expires_at") || "0");

  if (!phone || !token) {
    return htmlResponse("<h1>Missing required fields</h1>", 400);
  }

  const tokenValid = await verifyPopupToken(env, phone, engagementId, expiresAt, token);
  if (!tokenValid) {
    return htmlResponse(
      "<h1>Form expired</h1><p>Close this tab and reopen the contact popup to try again.</p>",
      403
    );
  }

  const firstName = String(form.get("first_name") || "").trim();
  const lastName = String(form.get("last_name") || "").trim() || "Unknown Caller";
  const email = String(form.get("email") || "").trim();
  const company = String(form.get("company") || "").trim();
  const notes = String(form.get("notes") || "").trim();

  // Dedupe — if someone else (webhook, another popup) already created this contact,
  // skip the write and go straight to the search page.
  try {
    const existing = await lookupZohoByPhone(env, phone);
    if (existing.found && existing.match_type === "contact") {
      const searchword = existing.account?.compass_id || phone;
      return Response.redirect(zohoSearchUrl(searchword), 302);
    }
  } catch (err) {
    console.log("Popup dedupe lookup failed:", String(err?.message || err));
  }

  const descParts = [];
  if (engagementId) {
    descParts.push(`Created from Zoom engagement ${engagementId} on ${new Date().toISOString()}`);
  }
  if (company) descParts.push(`Company: ${company}`);
  if (notes) descParts.push(`Notes: ${notes}`);

  const record = {
    Last_Name: lastName,
    Phone: phone,
    Lead_Source: "Inbound Call",
  };
  if (firstName) record.First_Name = firstName;
  if (email) record.Email = email;
  if (descParts.length) record.Description = descParts.join("\n");

  const zohoToken = await getZohoAccessToken(env);
  const zohoRes = await fetch("https://www.zohoapis.com/crm/v2/Contacts", {
    method: "POST",
    headers: {
      Authorization: `Zoho-oauthtoken ${zohoToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ data: [record] }),
  });
  const text = await zohoRes.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }

  if (!zohoRes.ok || body?.data?.[0]?.status !== "success") {
    return htmlResponse(
      `<h1>Zoho create failed</h1>
       <p>The contact was not created. Details below:</p>
       <pre>${escapeHtml(JSON.stringify(body, null, 2))}</pre>
       <p><a href="javascript:history.back()">Go back</a></p>`,
      502
    );
  }

  return Response.redirect(zohoSearchUrl(phone), 302);
}

function zohoSearchUrl(searchword) {
  return `${ZOHO_SEARCH_URL_BASE}?searchword=${encodeURIComponent(searchword)}&isRelevance=false`;
}

async function generatePopupToken(env, phone, engagementId, expiresAt) {
  if (!env.ZOOM_WEBHOOK_SECRET) {
    throw new Error("ZOOM_WEBHOOK_SECRET not configured");
  }
  return hmacSha256Hex(env.ZOOM_WEBHOOK_SECRET, `${phone}|${engagementId}|${expiresAt}`);
}

async function verifyPopupToken(env, phone, engagementId, expiresAt, token) {
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return false;
  if (!env.ZOOM_WEBHOOK_SECRET) return false;
  const expected = await hmacSha256Hex(
    env.ZOOM_WEBHOOK_SECRET,
    `${phone}|${engagementId}|${expiresAt}`
  );
  return timingSafeEqualStr(token, expected);
}

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function renderCreateForm({ phone, engagementId, token, expiresAt }) {
  const esc = escapeHtml;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Create Contact</title>
<style>
  body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; max-width: 540px; margin: 30px auto; padding: 0 20px; color: #222; }
  h1 { font-size: 20px; margin-bottom: 8px; }
  .info { background: #eef4fb; border: 1px solid #cfe0f3; padding: 12px 14px; border-radius: 6px; margin-bottom: 20px; font-size: 14px; }
  .info strong { color: #0050a0; }
  label { display: block; margin-top: 14px; font-weight: 600; font-size: 13px; color: #333; }
  input, textarea { width: 100%; padding: 8px 10px; margin-top: 4px; border: 1px solid #c0c4c9; border-radius: 4px; font-size: 14px; box-sizing: border-box; font-family: inherit; }
  input:focus, textarea:focus { outline: none; border-color: #0066cc; box-shadow: 0 0 0 2px rgba(0,102,204,0.15); }
  .row { display: flex; gap: 10px; }
  .row > div { flex: 1; }
  .actions { margin-top: 24px; }
  button { padding: 10px 18px; background: #0066cc; color: #fff; border: 0; border-radius: 4px; cursor: pointer; font-size: 14px; font-weight: 600; }
  button:hover { background: #0052a3; }
  button:disabled { background: #888; cursor: not-allowed; }
  .cancel { background: #e0e4e8; color: #333; margin-left: 8px; }
  .cancel:hover { background: #c8ccd0; }
</style>
</head>
<body>
  <h1>Create new contact</h1>
  <div class="info">
    No existing Zoho contact was found for <strong>${esc(phone)}</strong>.
    Fill in what you know and we'll create the contact now.
  </div>
  <form method="POST" action="/popup/submit">
    <input type="hidden" name="phone" value="${esc(phone)}">
    <input type="hidden" name="engagement_id" value="${esc(engagementId)}">
    <input type="hidden" name="token" value="${esc(token)}">
    <input type="hidden" name="expires_at" value="${esc(expiresAt)}">

    <div class="row">
      <div>
        <label for="first_name">First Name</label>
        <input id="first_name" name="first_name" autocomplete="given-name">
      </div>
      <div>
        <label for="last_name">Last Name</label>
        <input id="last_name" name="last_name" placeholder="Unknown Caller" autocomplete="family-name">
      </div>
    </div>

    <label for="email">Email</label>
    <input id="email" name="email" type="email" autocomplete="email">

    <label for="company">Company</label>
    <input id="company" name="company">

    <label for="notes">Notes</label>
    <textarea id="notes" name="notes" rows="3"></textarea>

    <div class="actions">
      <button type="submit" id="submit-btn">Create Contact</button>
      <button type="button" class="cancel" onclick="window.close()">Cancel</button>
    </div>
  </form>
  <script>
    document.querySelector('form').addEventListener('submit', function () {
      var btn = document.getElementById('submit-btn');
      btn.disabled = true;
      btn.textContent = 'Creating...';
    });
  </script>
</body>
</html>`;
}