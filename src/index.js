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
    "GET /zoho/desk/agents": handleDeskAgentsProbe,
  };

  const handler = routes[`${request.method} ${url.pathname}`];
  if (handler) return handler(request, env, ctx, url);

  const contactMatch = url.pathname.match(/^\/zoho\/contact\/([^/]+)$/);
  if (contactMatch && request.method === "GET") {
    return handleContactById(env, decodeURIComponent(contactMatch[1]));
  }

  return json({ error: "Not Found" }, 404);
}

// Debug aid for the Full_Name change in handleLookupByPhone — returns the old
// and new name derivations side by side for one contact so they can be
// compared against what Zoho actually holds. Safe to delete once the fix has
// been confirmed in production.
async function handleContactById(env, id) {
  const token = await getZohoAccessToken(env);
  const zohoUrl = `https://www.zohoapis.com/crm/v2/Contacts/${encodeURIComponent(id)}`;
  const data = await callZoho(env, token, zohoUrl);
  const rec = Array.isArray(data?.data) ? data.data[0] : data?.data;
  if (!rec) return json({ found: false, id });

  const composed = [rec.First_Name, rec.Last_Name].filter(Boolean).join(" ");
  return json({
    found: true,
    id: rec.id,
    Full_Name: rec.Full_Name ?? null,
    First_Name: rec.First_Name ?? null,
    Last_Name: rec.Last_Name ?? null,
    Salutation: rec.Salutation ?? null,
    Phone: rec.Phone ?? null,
    Mobile: rec.Mobile ?? null,
    name_old_logic: composed || null, // what the worker returned BEFORE the fix
    name_new_logic: rec.Full_Name || composed || null, // AFTER the fix
  });
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

  // Manual alert-channel smoke test. Bypasses the cooldown so it always sends.
  if (url.pathname === "/zoom/alert-test" && request.method === "GET") {
    const result = await maybeSendAlert(env, {
      type: "test",
      summary: "Test alert — ignore",
      details: {
        note: "Manual test from /zoom/alert-test",
        at: new Date().toISOString(),
      },
      force: true,
    });
    return json({ ok: true, ...result });
  }

  const idMatch = url.pathname.match(/^\/zoom\/webhooks\/([^/]+)$/);
  if (idMatch) {
    const id = decodeURIComponent(idMatch[1]);
    if (request.method === "GET") return handleWebhookGet(env, id);
    if (request.method === "DELETE") return handleWebhookDelete(env, id);
  }

  const engagementProbeMatch = url.pathname.match(
    /^\/zoom\/engagement\/([^/]+)\/probe$/
  );
  if (engagementProbeMatch && request.method === "GET") {
    const engagementId = decodeURIComponent(engagementProbeMatch[1]);
    return handleEngagementProbe(env, engagementId);
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

async function handleEngagementProbe(env, engagementId) {
  const token = await getZoomAccessToken(env);
  const encoded = encodeURIComponent(engagementId);
  const base = "https://api.zoom.us/v2/contact_center";

  const paths = [
    `/engagements/${encoded}`,
    `/engagements/${encoded}?include=notes,disposition`,
    `/engagements/${encoded}/notes`,
    `/engagements/${encoded}/disposition`,
    `/engagements/${encoded}/dispositions`,
    `/engagements/${encoded}/transcript`,
    `/engagements/${encoded}/transcripts`,
    `/engagements/${encoded}/recordings`,
    `/engagements/${encoded}/feedbacks`,
    `/engagements/${encoded}/tags`,
  ];

  const results = {};
  for (const p of paths) {
    try {
      const res = await fetch(base + p, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const text = await res.text();
      let body = null;
      try {
        body = text ? JSON.parse(text) : text;
      } catch {
        body = text;
      }
      results[p] = { status: res.status, body };
    } catch (err) {
      results[p] = { error: String(err?.message || err) };
    }
  }
  return json(results);
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
  const isDispositionEvent =
    eventName === "contact_center.engagement_disposition_added" && engagementId;

  let duplicateOf = null;
  if (isDispositionEvent && env.coastalsource_kv) {
    duplicateOf = await env.coastalsource_kv.get(`engagement_seen:${engagementId}`);
  }

  let engagementDetails = null;
  let engagementFetchError = null;
  let phoneLookupResult = null;
  let ownerResolution = null;
  let zohoCreatePayload = null;
  let deskContactFound = null;
  let deskTicketPayload = null;
  let deskTicketError = null;
  let deskTicketDispatched = false;
  let deskTicketId = null;

  if (isDispositionEvent && !duplicateOf) {
    // Claim this engagement immediately so a racing concurrent webhook
    // overwrites this key and the later ownership re-check kicks it out.
    if (env.coastalsource_kv) {
      await env.coastalsource_kv.put(`engagement_seen:${engagementId}`, id, {
        expirationTtl: 60 * 60 * 24 * 7,
      });
    }

    try {
      engagementDetails = await fetchZoomEngagement(env, engagementId);
    } catch (err) {
      engagementFetchError = String(err?.message || err);
      console.log("Zoom engagement fetch failed:", engagementFetchError);
    }

    // Disposition-added fires the moment the agent picks a disposition during
    // wrap-up; the wrap-up note is often saved a beat later. Wait briefly and
    // re-fetch — keep whichever response has more notes (Zoom returns them in
    // chronological order). Single re-fetch covers the typical wrap-up window.
    if (engagementDetails) {
      await new Promise((r) => setTimeout(r, 10000));
      try {
        const refreshed = await fetchZoomEngagement(env, engagementId);
        const before = engagementDetails.notes?.length || 0;
        const after = refreshed?.notes?.length || 0;
        if (refreshed && after > before) {
          console.log(`Wrap-up note appeared after re-fetch (${before} -> ${after})`);
          engagementDetails = refreshed;
        }
      } catch (err) {
        console.log("Engagement re-fetch failed:", String(err?.message || err));
      }
    }

    // Resolve the "current" context for THIS event based on the webhook
    // payload. For transferred calls engagementDetails.queues[0] is the
    // initial queue, not the queue where the disposition was actually set —
    // so we move the webhook's queue/agent/flow/disposition to [0] in each
    // array. All downstream code that reads [0] then sees the final-state
    // values and routes accordingly.
    engagementDetails = resolveEngagementContext(engagementDetails, parsedBody?.payload?.object);

    const callerPhone = engagementDetails?.consumers?.[0]?.consumer_number || null;
    if (callerPhone) {
      try {
        phoneLookupResult = await lookupZohoByPhone(env, callerPhone);
      } catch (err) {
        console.log("Zoho phone lookup failed:", String(err?.message || err));
      }

      // Resolve the Zoom agent to Zoho identities (CRM user + Desk agent) once,
      // regardless of whether we end up creating a contact or a ticket — both
      // paths benefit from the mapping and we cache the result for 30 days.
      const agentUserId = extractPrimaryAgentId(engagementDetails);
      if (agentUserId) {
        try {
          ownerResolution = await resolveZohoOwnerForZoomAgent(env, agentUserId);
        } catch (err) {
          ownerResolution = {
            zoom_user_id: agentUserId,
            zoho_user_id: null,
            zoho_desk_user_id: null,
            error: String(err?.message || err),
            error_status: err?.status ?? null,
            error_details: err?.details ?? null,
          };
          console.log("Owner resolution failed:", JSON.stringify(ownerResolution));
        }
      }

      if (phoneLookupResult && !phoneLookupResult.found) {
        zohoCreatePayload = buildZohoContactCreatePayload({
          phone: callerPhone,
          engagementId,
          receivedAt,
          ownerId: ownerResolution?.zoho_user_id || null,
        });
      }

      // Skip Desk ticket entirely if the agent didn't set a disposition.
      const hasDisposition =
        Array.isArray(engagementDetails?.dispositions) &&
        engagementDetails.dispositions.length > 0;

      if (!hasDisposition) {
        deskTicketError = "no disposition set — ticket creation skipped";
      } else {
        const departmentId = pickDeskDepartmentId(env, engagementDetails);
        const primaryDispName =
          engagementDetails?.dispositions?.[0]?.disposition_name || null;
        const inquiryField = buildInquiryTypeCustomField(engagementDetails);

        if (shouldSkipTicket(primaryDispName)) {
          deskTicketError = `disposition '${primaryDispName}' — ticket creation intentionally skipped`;
        } else if (!departmentId) {
          deskTicketError = "no department mapping for queue/flow";
        } else if (!inquiryField) {
          deskTicketError = `no inquiry type mapping for disposition: ${primaryDispName}`;
        } else {
          try {
            const zohoToken = await getZohoAccessToken(env);
            deskContactFound = await findZohoDeskContactByPhone(env, zohoToken, callerPhone);
            deskTicketPayload = buildDeskTicketPayload({
              phone: callerPhone,
              engagementDetails,
              phoneLookup: phoneLookupResult,
              deskContact: deskContactFound,
              departmentId,
              assigneeId: ownerResolution?.zoho_desk_user_id || null,
            });
          } catch (err) {
            deskTicketError = String(err?.message || err);
            console.log("Desk ticket payload build failed:", deskTicketError);
          }
        }
      }
    }

    // Dispatch the Desk ticket if enabled and we still own this engagement
    // (a racing duplicate webhook may have overwritten the seen-key after us).
    if (
      deskTicketPayload &&
      env.DESK_AUTO_CREATE_TICKETS === "true"
    ) {
      let ownsDispatch = true;
      if (env.coastalsource_kv) {
        const currentOwner = await env.coastalsource_kv.get(
          `engagement_seen:${engagementId}`
        );
        if (currentOwner && currentOwner !== id) {
          ownsDispatch = false;
          deskTicketError = `dispatch skipped — another webhook (${currentOwner}) owns this engagement`;
          console.log(deskTicketError);
        }
      }

      if (ownsDispatch) {
        try {
          const zohoToken = await getZohoAccessToken(env);
          const result = await callZohoDesk(env, zohoToken, "/tickets", {
            method: "POST",
            body: deskTicketPayload.body,
          });
          deskTicketId = result?.id || null;
          deskTicketDispatched = true;
          console.log("Desk ticket created:", deskTicketId);
        } catch (err) {
          deskTicketDispatched = false;
          const errBody = err?.details ? ` | ${JSON.stringify(err.details)}` : "";
          deskTicketError = `${String(err?.message || err)}${errBody}`;
          console.log("Desk ticket dispatch failed:", deskTicketError);
        }
      }
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
    desk_contact_found: deskContactFound
      ? { id: deskContactFound.id, firstName: deskContactFound.firstName, lastName: deskContactFound.lastName, email: deskContactFound.email, phone: deskContactFound.phone }
      : null,
    desk_ticket_payload: deskTicketPayload,
    desk_ticket_error: deskTicketError,
    desk_ticket_dispatched: deskTicketDispatched,
    desk_ticket_id: deskTicketId,
  };

  console.log("Zoom webhook processed:", JSON.stringify(record));

  if (env.coastalsource_kv) {
    await env.coastalsource_kv.put(`webhook:${id}`, JSON.stringify(record), {
      expirationTtl: 60 * 60 * 24 * 7,
    });
  }

  if (isDispositionEvent && !duplicateOf) {
    const wp = parsedBody?.payload?.object || {};
    const common = {
      engagement_id: engagementId,
      received_at: receivedAt,
      queue: wp.queue_name || engagementDetails?.queues?.[0]?.queue_name || "-",
      disposition:
        wp.disposition_name ||
        engagementDetails?.dispositions?.[0]?.disposition_name ||
        "-",
      webhook_record: `${path} (id ${id})`,
    };

    if (engagementFetchError) {
      await maybeSendAlert(env, {
        type: "zoom_fetch",
        summary: "Zoom engagement fetch is failing — tickets are NOT being created",
        details: { ...common, error: engagementFetchError },
      });
    } else if (
      deskTicketPayload &&
      env.DESK_AUTO_CREATE_TICKETS === "true" &&
      !deskTicketDispatched &&
      deskTicketError &&
      !deskTicketError.startsWith("dispatch skipped")
    ) {
      await maybeSendAlert(env, {
        type: "desk_dispatch",
        summary: "Zoho Desk ticket dispatch failed",
        details: { ...common, error: deskTicketError },
      });
    }
  }
}

// Fan an alert out to whichever channels are configured, with a per-type
// cooldown in KV so a sustained outage doesn't mail out on every call.
// `force: true` bypasses the cooldown (used by /zoom/alert-test).
async function maybeSendAlert(env, { type, summary, details, force = false }) {
  const cooldownSec = Number(env.ALERT_COOLDOWN_SECONDS) || 3600;
  const cooldownKey = `alert_cooldown:${type}`;

  if (!force && env.coastalsource_kv) {
    const recent = await env.coastalsource_kv.get(cooldownKey);
    if (recent) {
      console.log(`Alert '${type}' suppressed (cooldown active since ${recent})`);
      return { sent: false, suppressed: true };
    }
  }

  const channels = [];
  if (env.ALERT_ZOOM_WEBHOOK_URL) {
    channels.push({ name: "zoom_chat", run: sendZoomChatAlert(env, summary, details) });
  }
  if (env.ALERT_RESEND_API_KEY && env.ALERT_EMAIL_TO) {
    channels.push({ name: "resend_email", run: sendResendEmailAlert(env, summary, details) });
  }
  if (channels.length === 0) {
    console.log(`Alert '${type}' not sent — no alert channel configured`);
    return { sent: false, unconfigured: true };
  }

  const settled = await Promise.allSettled(channels.map((c) => c.run));
  const results = settled.map((r, i) => ({
    channel: channels[i].name,
    ok: r.status === "fulfilled",
    error: r.status === "rejected" ? String(r.reason?.message || r.reason) : null,
  }));
  const sent = results.some((r) => r.ok);
  for (const r of results) {
    if (!r.ok) console.log(`Alert '${type}' channel '${r.channel}' failed:`, r.error);
  }

  // Only start the cooldown once something actually went out, so a broken
  // channel doesn't silently suppress the next hour of alerts.
  if (sent && !force && env.coastalsource_kv) {
    await env.coastalsource_kv.put(cooldownKey, new Date().toISOString(), {
      expirationTtl: cooldownSec,
    });
  }

  return { sent, results };
}

async function sendZoomChatAlert(env, summary, details) {
  const detailLines = Object.entries(details)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  const text = `⚠️ Coastal Source Worker — ${summary}\n\n${detailLines}`;

  const u = new URL(env.ALERT_ZOOM_WEBHOOK_URL);
  u.searchParams.set("format", "message");
  const headers = { "Content-Type": "text/plain" };
  if (env.ALERT_ZOOM_WEBHOOK_SECRET) {
    headers.Authorization = env.ALERT_ZOOM_WEBHOOK_SECRET;
  }

  const res = await fetch(u.toString(), { method: "POST", headers, body: text });
  if (!res.ok) throw new Error(`Zoom chat alert failed: ${res.status} ${await res.text()}`);
}

async function sendResendEmailAlert(env, summary, details) {
  const from =
    env.ALERT_EMAIL_FROM || "Coastal Source Worker <noreply@notifications.packetfusion.com>";
  const to = env.ALERT_EMAIL_TO.split(",").map((a) => a.trim()).filter(Boolean);
  const textBody = Object.entries(details)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  const htmlBody = Object.entries(details)
    .map(([k, v]) => `<b>${escapeHtml(k)}:</b> ${escapeHtml(String(v))}`)
    .join("<br>");

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.ALERT_RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to,
      subject: `⚠️ Coastal Source Worker: ${summary}`,
      text: `${summary}\n\n${textBody}`,
      html: `<p><b>${escapeHtml(summary)}</b></p>${htmlBody}`,
    }),
  });
  if (!res.ok) {
    throw new Error(`Resend send failed: ${res.status} ${await res.text()}`);
  }
}

// Reorders engagementDetails arrays so the webhook payload's queue, flow,
// agent, and disposition end up at index [0]. The transfer scenario is the
// reason this exists: engagement.queues[0] is whichever queue the call
// originally came in on, but the disposition_added webhook tells us which
// queue the FINAL agent set the disposition from. Existing downstream code
// reads [0] for routing decisions, so this lets us fix transfer routing
// without rewriting every call site.
function resolveEngagementContext(engagementDetails, webhookPayloadObject) {
  if (!webhookPayloadObject) return engagementDetails;
  const base = engagementDetails ? { ...engagementDetails } : {};
  const wp = webhookPayloadObject;

  const moveToFront = (arr, predicate, fallback) => {
    const list = Array.isArray(arr) ? arr : [];
    const existing = list.find(predicate);
    const head = existing || fallback;
    if (!head) return list;
    const others = list.filter((item) => !predicate(item));
    return [head, ...others];
  };

  if (wp.queue_name) {
    base.queues = moveToFront(
      base.queues,
      (q) => q?.queue_name === wp.queue_name,
      {
        queue_id: wp.queue_id || null,
        queue_name: wp.queue_name,
        cc_queue_id: wp.cc_queue_id || null,
      }
    );
  }
  if (wp.flow_name) {
    base.flows = moveToFront(
      base.flows,
      (f) => f?.flow_name === wp.flow_name,
      { flow_id: wp.flow_id || null, flow_name: wp.flow_name }
    );
  }
  if (wp.user_id) {
    base.agents = moveToFront(
      base.agents,
      (a) => a?.user_id === wp.user_id,
      { user_id: wp.user_id, display_name: wp.user_display_name || wp.user_id }
    );
  }
  if (wp.disposition_id && wp.disposition_name) {
    base.dispositions = moveToFront(
      base.dispositions,
      (d) => d?.disposition_id === wp.disposition_id,
      { disposition_id: wp.disposition_id, disposition_name: wp.disposition_name }
    );
  }
  return base;
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
    // Honor the cache only if it has both keys (CRM and Desk lookups attempted).
    // Older cache entries that predate Desk-agent resolution are missing
    // zoho_desk_user_id entirely; force a refresh in that case.
    if (cached && "zoho_user_id" in cached && "zoho_desk_user_id" in cached) {
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
    return {
      zoom_user_id: zoomUserId,
      email: null,
      zoho_user_id: null,
      zoho_desk_user_id: null,
      error: "Zoom user has no email",
    };
  }

  // Resolve CRM user and Desk agent in parallel — separate user pools per product.
  // Capture each lookup's outcome (id or error) so the result record surfaces
  // why a lookup failed instead of silently going null.
  const zohoToken = await getZohoAccessToken(env);
  const wrap = (p) =>
    p.then((id) => ({ ok: true, id })).catch((e) => ({ ok: false, error: e }));

  const [crmRes, deskRes] = await Promise.all([
    wrap(findZohoUserByEmail(env, email)),
    wrap(findZohoDeskAgentByEmail(env, zohoToken, email)),
  ]);

  const zohoUserId = crmRes.ok ? crmRes.id : null;
  const zohoDeskUserId = deskRes.ok ? deskRes.id : null;
  const deskAgentLookupError = deskRes.ok
    ? null
    : {
        message: String(deskRes.error?.message || deskRes.error),
        status: deskRes.error?.status ?? null,
        details: deskRes.error?.details ?? null,
      };

  if (deskAgentLookupError) {
    console.log("Desk agent lookup failed:", JSON.stringify(deskAgentLookupError));
  }

  const result = {
    zoom_user_id: zoomUserId,
    email,
    zoho_user_id: zohoUserId,
    zoho_desk_user_id: zohoDeskUserId,
    desk_agent_lookup_error: deskAgentLookupError,
    source: "fresh",
  };

  // Only cache when neither lookup errored — we want to retry on transient
  // permission issues rather than freeze a bad result for 30 days.
  const noErrors = crmRes.ok && deskRes.ok;
  if (noErrors && (zohoUserId || zohoDeskUserId) && env.coastalsource_kv) {
    await env.coastalsource_kv.put(
      cacheKey,
      JSON.stringify({
        zoom_user_id: zoomUserId,
        email,
        zoho_user_id: zohoUserId,
        zoho_desk_user_id: zohoDeskUserId,
      }),
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

async function handleDeskAgentsProbe(request, env, ctx, url) {
  const email = (url.searchParams.get("email") || "").trim().toLowerCase();
  const accessToken = await getZohoAccessToken(env);
  try {
    const data = await callZohoDesk(env, accessToken, `/agents?from=0&limit=100`);
    const agents = Array.isArray(data?.data) ? data.data : [];
    const match = email
      ? agents.find(
          (a) => (a?.emailId || a?.email || "").toLowerCase() === email
        ) || null
      : null;
    return json({
      ok: true,
      count: agents.length,
      first_5: agents.slice(0, 5).map((a) => ({
        id: a.id,
        emailId: a.emailId ?? null,
        email: a.email ?? null,
        firstName: a.firstName ?? null,
        lastName: a.lastName ?? null,
      })),
      match,
    });
  } catch (err) {
    return json(
      {
        ok: false,
        status: err?.status ?? null,
        error: String(err?.message || err),
        details: err?.details ?? null,
      },
      200
    );
  }
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
          // Prefer Zoho's own Full_Name — it accounts for salutation and
          // middle names that First+Last drops.
          name:
            contact.Full_Name ||
            [contact.First_Name, contact.Last_Name].filter(Boolean).join(" ") ||
            null,
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
    encodeURIComponent(engagementId) +
    `?include=notes,disposition`;

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
 * Zoho Desk helpers
 * ----------------------------- */

async function callZohoDesk(env, accessToken, path, options = {}) {
  if (!env.ZOHO_DESK_ORG_ID) throw new Error("ZOHO_DESK_ORG_ID not configured");
  const url = `https://desk.zoho.com/api/v1${path}`;
  const res = await fetch(url, {
    method: options.method || "GET",
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      orgId: String(env.ZOHO_DESK_ORG_ID),
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const err = new Error("Zoho Desk request failed");
    err.status = res.status;
    err.details = json ?? { raw: text?.slice(0, 500) || null };
    throw err;
  }
  return json ?? { raw: text };
}

async function findZohoDeskAgentByEmail(env, accessToken, email) {
  const target = String(email || "").toLowerCase();
  if (!target) return null;
  // Desk pagination uses from/limit (not page/per_page like CRM). Errors
  // bubble up so resolveZohoOwnerForZoomAgent can capture them in the
  // ownerResolution record (helpful for diagnosing scope/permission issues).
  const limit = 100;
  for (let from = 0; from < 1000; from += limit) {
    const data = await callZohoDesk(env, accessToken, `/agents?from=${from}&limit=${limit}`);
    const agents = Array.isArray(data?.data) ? data.data : [];
    const match = agents.find(
      (a) => (a?.emailId || a?.email || "").toLowerCase() === target
    );
    if (match?.id) return match.id;
    if (agents.length < limit) return null; // last page
  }
  return null;
}

async function findZohoDeskContactByPhone(env, accessToken, phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return null;

  const attempts = new Set([phone, digits]);
  if (digits.length === 11 && digits.startsWith("1")) attempts.add(digits.slice(1));
  if (digits.length === 10) attempts.add("1" + digits);

  for (const attempt of attempts) {
    try {
      const data = await callZohoDesk(
        env,
        accessToken,
        `/contacts/search?phone=${encodeURIComponent(attempt)}`
      );
      if (Array.isArray(data?.data) && data.data.length > 0) return data.data[0];
    } catch (err) {
      console.log(`Desk contact search (${attempt}) failed:`, String(err?.message || err));
    }
  }
  return null;
}

function splitName(fullName) {
  const parts = String(fullName || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: "", lastName: "Unknown Caller" };
  if (parts.length === 1) return { firstName: "", lastName: parts[0] };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

function buildUserDisplayNameMap(engagementDetails) {
  const map = {};
  if (Array.isArray(engagementDetails?.agents)) {
    for (const a of engagementDetails.agents) {
      if (a?.user_id) map[a.user_id] = a.display_name || a.user_display_name || a.user_id;
    }
  }
  if (Array.isArray(engagementDetails?.events)) {
    for (const e of engagementDetails.events) {
      if (e?.user_id && !map[e.user_id]) {
        map[e.user_id] = e.user_display_name || e.user_id;
      }
    }
  }
  return map;
}

function pickDeskDepartmentId(env, engagementDetails) {
  // Use queue_name only — it follows transfers, flow_name doesn't. A call
  // that enters via "Technical Support_Voice" flow but ends up in the
  // Customer Service queue belongs to CS.
  const queueName = (engagementDetails?.queues?.[0]?.queue_name || "").toLowerCase();

  if (queueName.includes("technical") && env.ZOHO_DESK_DEPARTMENT_TECHNICAL_SUPPORT) {
    return env.ZOHO_DESK_DEPARTMENT_TECHNICAL_SUPPORT;
  }
  if (queueName.includes("customer") && env.ZOHO_DESK_DEPARTMENT_CUSTOMER_SERVICE) {
    return env.ZOHO_DESK_DEPARTMENT_CUSTOMER_SERVICE;
  }
  return env.ZOHO_DESK_DEFAULT_DEPARTMENT_ID || null;
}

// Zoom disposition_name → cf_inquiry_type_2 picklist value. Picklist values
// must match Desk exactly (Desk validates) — including the en-dash characters.
// Customer Service queue dispositions only for now; Tech Support to follow.
const DESK_INQUIRY_TYPE_MAP = {
  "Dealer Relations": "Dealer Relations",
  "Escalations": "Escalations – Customer Service and Warehouse",
  "Order Management": "Order and Shipping – Warehouse and Shipping",
  "Order Management & Shipping": "Order and Shipping – Warehouse and Shipping",
  "Product/Account Support": "Product/Service Support – Customer Service",
  "Returns/Exchanges": "Returns/Exchanges – Warehouse and Shipping",
  "Rollover": "Rollover",
  "Set-up or diagnostics": "Setup or diagnostics - Tech Support",
};

// Dispositions that explicitly mean "do not create a ticket" — agents pick
// these when the call was resolved on the spot or doesn't warrant follow-up.
// Match case-insensitively so "no ticket needed" / "No Ticket Needed" / etc.
// all skip cleanly.
const SKIP_TICKET_DISPOSITIONS = new Set(["no ticket needed"]);

function shouldSkipTicket(dispositionName) {
  if (!dispositionName) return false;
  return SKIP_TICKET_DISPOSITIONS.has(String(dispositionName).toLowerCase().trim());
}

function mapDispositionToInquiryType(dispositionName) {
  if (!dispositionName) return null;
  if (DESK_INQUIRY_TYPE_MAP[dispositionName]) return DESK_INQUIRY_TYPE_MAP[dispositionName];
  // Case-insensitive fallback in case Zoom ever capitalizes differently
  const target = String(dispositionName).toLowerCase().trim();
  for (const key of Object.keys(DESK_INQUIRY_TYPE_MAP)) {
    if (key.toLowerCase() === target) return DESK_INQUIRY_TYPE_MAP[key];
  }
  return null;
}

// Parse structured agent notes of the form
//   "Title: ... Note: ... Ticketstatus: closed"
// Returns { title?, note?, status? } with whatever fields were present, or
// null when no recognizable labels are found. Tolerates case variations,
// alternate label names ("Notes:", "Status:", "Ticket Status:"), and trims
// the trailing period agents tend to type between fields.
function parseStructuredNote(noteText) {
  if (!noteText) return null;
  const text = String(noteText);
  const lowerText = text.toLowerCase();

  const labelDefs = [
    { key: "title", prefixes: ["title:", "subject:"] },
    { key: "note", prefixes: ["notes:", "note:"] },
    { key: "status", prefixes: ["ticketstatus:", "ticket status:", "status:"] },
  ];

  const positions = [];
  for (const def of labelDefs) {
    for (const prefix of def.prefixes) {
      const idx = lowerText.indexOf(prefix);
      if (idx >= 0) {
        positions.push({ key: def.key, start: idx, contentStart: idx + prefix.length });
        break; // only count one prefix per key
      }
    }
  }
  if (positions.length === 0) return null;

  positions.sort((a, b) => a.start - b.start);
  const result = {};
  for (let i = 0; i < positions.length; i++) {
    const pos = positions[i];
    const next = positions[i + 1];
    const end = next ? next.start : text.length;
    let content = text.slice(pos.contentStart, end).trim();
    if (content.endsWith(".")) content = content.slice(0, -1).trim();
    if (content) result[pos.key] = content;
  }
  return Object.keys(result).length > 0 ? result : null;
}

// Picklist on the Desk side is "Open", "Escalated", "Closed". Match
// case-insensitively and return the canonical value, or null if the agent
// typed something we don't recognize (we default to Open in that case).
function normalizeDeskStatus(rawStatus) {
  if (!rawStatus) return null;
  const valid = ["Open", "Escalated", "Closed"];
  const target = String(rawStatus).toLowerCase().trim();
  for (const v of valid) {
    if (v.toLowerCase() === target) return v;
  }
  return null;
}

// Pick the right Desk custom-field + value for the call's inquiry type based
// on which Zoom queue handled it. Customer Service uses cf_inquiry_type_2
// with a translation table; Tech Support uses cf_inquiry_type_tech_support
// with the disposition_name as the picklist value verbatim.
function buildInquiryTypeCustomField(engagementDetails) {
  const dispositionName =
    engagementDetails?.dispositions?.[0]?.disposition_name || null;
  if (!dispositionName) return null;

  // Match on queue_name only — see pickDeskDepartmentId for rationale.
  const queueName = (engagementDetails?.queues?.[0]?.queue_name || "").toLowerCase();

  if (queueName.includes("technical")) {
    return { fieldName: "cf_inquiry_type_tech_support", value: dispositionName };
  }
  if (queueName.includes("customer")) {
    const mapped = mapDispositionToInquiryType(dispositionName);
    if (!mapped) return null;
    return { fieldName: "cf_inquiry_type_2", value: mapped };
  }
  return null;
}

function buildDeskTicketPayload({
  phone,
  engagementDetails,
  phoneLookup,
  deskContact,
  departmentId,
  assigneeId,
}) {
  const contactName = phoneLookup?.contact?.name || "Unknown Caller";
  const agent = engagementDetails?.agents?.[0];
  const queue = engagementDetails?.queues?.[0];

  const dispositions = Array.isArray(engagementDetails?.dispositions)
    ? engagementDetails.dispositions
    : [];
  const dispositionNames = dispositions
    .map((d) => d?.disposition_name)
    .filter(Boolean)
    .join(", ");

  const rawNotes = Array.isArray(engagementDetails?.notes) ? engagementDetails.notes : [];

  // Sort notes chronologically — the agent may write a structured note
  // during the call AND a separate one during wrap-up. The wrap-up note
  // is the authoritative summary, so its Title/Status overrides win.
  const notes = [...rawNotes].sort((a, b) =>
    String(a?.last_modified_time || "").localeCompare(String(b?.last_modified_time || ""))
  );

  let titleOverride = null;
  let statusOverride = null;
  for (const n of notes) {
    const parsed = parseStructuredNote(n?.note);
    if (parsed?.title) titleOverride = parsed.title;
    if (parsed?.status) {
      const normalized = normalizeDeskStatus(parsed.status);
      if (normalized) statusOverride = normalized;
    }
  }

  let subject;
  if (titleOverride) {
    subject = titleOverride;
  } else {
    subject = dispositionNames || "Inbound call";
    // Use the latest note's text as the excerpt so the subject reflects
    // the wrap-up summary when no explicit Title was given.
    const fallbackNote = notes[notes.length - 1]?.note;
    if (fallbackNote) {
      const text = String(fallbackNote).trim();
      const excerpt = text.length > 80 ? text.slice(0, 77) + "..." : text;
      subject = `${subject} — ${excerpt}`;
    }
  }

  const overrideStatus = statusOverride;

  // Description: Zoho Desk renders this field as HTML, so use <br> for line breaks
  // and escape user-supplied values to prevent any HTML injection.
  const lines = [];
  lines.push(`<b>Engagement ID:</b> ${escapeHtml(engagementDetails?.engagement_id ?? "-")}`);
  lines.push(`<b>Phone:</b> ${escapeHtml(phone)}`);
  lines.push(`<b>Direction:</b> ${escapeHtml(engagementDetails?.direction ?? "-")}`);
  if (agent) lines.push(`<b>Agent:</b> ${escapeHtml(agent.display_name || "-")}`);
  if (queue) lines.push(`<b>Queue:</b> ${escapeHtml(queue.queue_name)}`);
  if (dispositionNames) lines.push(`<b>Disposition:</b> ${escapeHtml(dispositionNames)}`);
  lines.push(`<b>Start:</b> ${escapeHtml(engagementDetails?.start_time ?? "-")}`);
  lines.push(`<b>End:</b> ${escapeHtml(engagementDetails?.end_time ?? "-")}`);
  lines.push(`<b>Talk duration:</b> ${escapeHtml(String(engagementDetails?.talk_duration ?? "-"))}s`);
  lines.push(`<b>Handling duration:</b> ${escapeHtml(String(engagementDetails?.handling_duration ?? "-"))}s`);

  if (notes.length > 0) {
    const userMap = buildUserDisplayNameMap(engagementDetails);
    const noteLines = [];
    for (const n of notes) {
      const author = userMap[n.user_id] || n.user_id || "Unknown";
      const ts = n.last_modified_time ? `, ${n.last_modified_time}` : "";
      // For structured notes, show only the parsed Note value (not the
      // Title/Status labels). Skip lines that have nothing to show after
      // parsing — Title and Status went to ticket fields instead.
      const parsed = parseStructuredNote(n.note);
      const displayText = parsed ? parsed.note : n.note;
      if (displayText) {
        noteLines.push(`- ${escapeHtml(displayText)} (${escapeHtml(author)}${escapeHtml(ts)})`);
      }
    }
    if (noteLines.length > 0) {
      lines.push("");
      lines.push("<b>Agent notes:</b>");
      lines.push(...noteLines);
    }
  }

  const ticket = {
    subject,
    description: lines.join("<br>"),
    departmentId: String(departmentId),
    channel: "Phone",
    phone,
    priority: "Medium",
    status: overrideStatus || "Open",
  };

  if (assigneeId) {
    ticket.assigneeId = String(assigneeId);
  }

  // Map the disposition to the right Inquiry Type custom field for the
  // queue (Customer Service uses cf_inquiry_type_2 with a translation
  // table; Tech Support uses cf_inquiry_type_tech_support verbatim).
  const inquiryField = buildInquiryTypeCustomField(engagementDetails);
  if (inquiryField) {
    ticket.cf = { [inquiryField.fieldName]: inquiryField.value };
  }

  // Email: prefer the CRM contact's email (matches the customer's spec),
  // fall back to whatever the Desk contact lookup surfaced.
  const emailFromCrm = phoneLookup?.contact?.email || null;
  const emailFromDesk = deskContact?.email || null;
  const ticketEmail = emailFromCrm || emailFromDesk;
  if (ticketEmail) {
    ticket.email = ticketEmail;
  }

  if (deskContact?.id) {
    ticket.contactId = String(deskContact.id);
    if (deskContact.accountId) {
      ticket.accountId = String(deskContact.accountId);
    }
  } else {
    const { firstName, lastName } = splitName(contactName);
    ticket.contact = {
      lastName: lastName || "Unknown Caller",
      phone,
    };
    if (firstName) ticket.contact.firstName = firstName;
    if (ticketEmail) ticket.contact.email = ticketEmail;
  }

  return {
    method: "POST",
    url: "https://desk.zoho.com/api/v1/tickets",
    headers: { orgId: "<from ZOHO_DESK_ORG_ID>" },
    body: ticket,
  };
}

/* -----------------------------
 * Popup page: screen-pop entry + create-contact form
 * ----------------------------- */

const ZOHO_CRM_PLUS_BASE =
  "https://crmplus.zoho.com/coastalsource/index.do/cxapp/crm/org728200559";
const ZOHO_SEARCH_URL_BASE = `${ZOHO_CRM_PLUS_BASE}/search`;

async function handlePopupRoutes(request, env, ctx, url) {
  if (url.pathname === "/popup" && request.method === "GET") {
    return handlePopupEntry(env, url);
  }
  if (url.pathname === "/popup/submit" && request.method === "POST") {
    return handlePopupSubmit(request, env);
  }
  if (url.pathname === "/popup/accounts/search" && request.method === "GET") {
    return handlePopupAccountsSearch(env, url);
  }
  return htmlResponse("<h1>Not Found</h1>", 404);
}

async function handlePopupAccountsSearch(env, url) {
  const q = (url.searchParams.get("q") || "").trim();
  const token = url.searchParams.get("token") || "";
  const phone = url.searchParams.get("phone") || "";
  const engagementId = url.searchParams.get("engagement_id") || "";
  const expiresAt = Number(url.searchParams.get("expires_at") || 0);

  if (q.length < 2) return json({ accounts: [] });

  const valid = await verifyPopupToken(env, phone, engagementId, expiresAt, token);
  if (!valid) return json({ error: "Unauthorized" }, 403);

  try {
    const accessToken = await getZohoAccessToken(env);
    // Zoho's criteria syntax treats parens and commas as structure, so a query
    // containing them (e.g. "(NJ) AMT Video") can't go through starts_with.
    // Fall back to a broad word search and narrow it client-side.
    const special = /[(),]/.test(q);
    let accounts;

    if (special) {
      const word = q.replace(/[(),]/g, " ").trim();
      const zohoUrl =
        `https://www.zohoapis.com/crm/v2/Accounts/search?word=` +
        encodeURIComponent(word) +
        `&per_page=200`;
      const data = await callZoho(env, accessToken, zohoUrl);
      const needle = q.toLowerCase();
      accounts = (Array.isArray(data?.data) ? data.data : [])
        .filter((a) => String(a.Account_Name || "").toLowerCase().includes(needle))
        .slice(0, 15)
        .map((a) => ({ id: a.id, name: a.Account_Name }));
    } else {
      const criteria = `(Account_Name:starts_with:${q})`;
      const zohoUrl =
        `https://www.zohoapis.com/crm/v2/Accounts/search?criteria=` +
        encodeURIComponent(criteria) +
        `&per_page=15`;
      const data = await callZoho(env, accessToken, zohoUrl);
      accounts = (Array.isArray(data?.data) ? data.data : []).map((a) => ({
        id: a.id,
        name: a.Account_Name,
      }));
    }

    return json({ accounts });
  } catch (err) {
    // No-match search throws in callZoho on non-OK Zoho responses. Return empty set.
    return json({ accounts: [] });
  }
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
    if (lookup.match_type === "contact" && lookup.contact?.id) {
      return Response.redirect(zohoContactDetailUrl(lookup.contact.id), 302);
    }
    if (lookup.match_type === "account" && lookup.account?.id) {
      return Response.redirect(zohoAccountDetailUrl(lookup.account.id), 302);
    }
    const searchword = lookup.account?.compass_id || normalizePhoneForSearch(phone);
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
  const accountId = String(form.get("account_id") || "").trim();
  const notes = String(form.get("notes") || "").trim();

  // Dedupe — if a contact already exists for this phone we'd rather surface
  // it than create a duplicate. Leads are free to proliferate so no lead dedupe.
  try {
    const existing = await lookupZohoByPhone(env, phone);
    if (existing.found && existing.match_type === "contact" && existing.contact?.id) {
      return Response.redirect(zohoContactDetailUrl(existing.contact.id), 302);
    }
  } catch (err) {
    console.log("Popup dedupe lookup failed:", String(err?.message || err));
  }

  const descParts = [];
  if (engagementId) {
    descParts.push(`Created from Zoom engagement ${engagementId} on ${new Date().toISOString()}`);
  }
  if (notes) descParts.push(`Notes: ${notes}`);

  // Branch: an account_id from the picker means we're adding a contact to an
  // existing account. No account means this is a net-new prospect — create a Lead
  // so it lands in the sales pipeline rather than hanging off no account.
  const targetModule = accountId ? "Contacts" : "Leads";

  const record = {
    Last_Name: lastName,
    Phone: phone,
    Lead_Source: "Inbound Call",
  };
  if (firstName) record.First_Name = firstName;
  if (email) record.Email = email;
  if (descParts.length) record.Description = descParts.join("\n");

  if (targetModule === "Contacts") {
    record.Account_Name = { id: accountId };
  } else {
    record.Company = company || "Unknown Company";
  }

  const zohoToken = await getZohoAccessToken(env);
  const zohoRes = await fetch(
    `https://www.zohoapis.com/crm/v2/${targetModule}`,
    {
      method: "POST",
      headers: {
        Authorization: `Zoho-oauthtoken ${zohoToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ data: [record] }),
    }
  );
  const text = await zohoRes.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }

  if (!zohoRes.ok || body?.data?.[0]?.status !== "success") {
    return htmlResponse(
      `<h1>Zoho ${escapeHtml(targetModule)} create failed</h1>
       <p>The record was not created. Details below:</p>
       <pre>${escapeHtml(JSON.stringify(body, null, 2))}</pre>
       <p><a href="javascript:history.back()">Go back</a></p>`,
      502
    );
  }

  const newId = body?.data?.[0]?.details?.id;
  if (newId) {
    return Response.redirect(
      targetModule === "Contacts"
        ? zohoContactDetailUrl(newId)
        : zohoLeadDetailUrl(newId),
      302
    );
  }
  return Response.redirect(zohoSearchUrl(normalizePhoneForSearch(phone)), 302);
}

function zohoSearchUrl(searchword) {
  return `${ZOHO_SEARCH_URL_BASE}?searchword=${encodeURIComponent(searchword)}&isRelevance=false`;
}

function zohoContactDetailUrl(contactId) {
  return `${ZOHO_CRM_PLUS_BASE}/tab/Contacts/${encodeURIComponent(contactId)}`;
}

function zohoAccountDetailUrl(accountId) {
  return `${ZOHO_CRM_PLUS_BASE}/tab/Accounts/${encodeURIComponent(accountId)}`;
}

function zohoLeadDetailUrl(leadId) {
  return `${ZOHO_CRM_PLUS_BASE}/tab/Leads/${encodeURIComponent(leadId)}`;
}

function normalizePhoneForSearch(phoneRaw) {
  const digits = String(phoneRaw || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
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
<title>Create Contact or Lead</title>
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
  .account-picker { position: relative; }
  .suggestions { position: absolute; top: 100%; left: 0; right: 0; background: #fff; border: 1px solid #c0c4c9; border-radius: 4px; max-height: 200px; overflow-y: auto; margin-top: 2px; z-index: 10; box-shadow: 0 4px 8px rgba(0,0,0,0.08); }
  .suggestion { padding: 8px 10px; cursor: pointer; font-size: 14px; }
  .suggestion:hover { background: #eef4fb; }
  .account-picker.selected input { background: #e6f4ea; border-color: #6bbf80; }
  .hint { font-size: 12px; color: #666; margin-top: 6px; }
  #target-indicator { font-size: 12px; font-weight: 600; margin-top: 6px; color: #0066cc; }
  #target-indicator.lead { color: #a25900; }
</style>
</head>
<body>
  <h1>Create new contact or lead</h1>
  <div class="info">
    No existing Zoho contact was found for <strong>${esc(phone)}</strong>.
    Pick an existing account below to add a <strong>Contact</strong>, or leave the
    account blank (optionally entering a company name) to create a <strong>Lead</strong>.
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

    <label for="account_search">Account / Company</label>
    <div class="account-picker" id="account_picker">
      <input id="account_search" name="company" autocomplete="off" placeholder="Type to search existing accounts">
      <input type="hidden" name="account_id" id="account_id_hidden">
      <div id="account_suggestions" class="suggestions" hidden></div>
    </div>
    <div class="hint">Pick from the dropdown to add this person as a contact on an existing account. Leave blank or type a company name (no match) to create a lead instead.</div>
    <div id="target-indicator" class="lead">Target: Lead</div>

    <label for="notes">Notes</label>
    <textarea id="notes" name="notes" rows="3"></textarea>

    <div class="actions">
      <button type="submit" id="submit-btn">Create</button>
      <button type="button" class="cancel" onclick="window.close()">Cancel</button>
    </div>
  </form>
  <script>
    (function () {
      var PHONE = ${JSON.stringify(phone)};
      var ENGAGEMENT_ID = ${JSON.stringify(engagementId)};
      var TOKEN = ${JSON.stringify(token)};
      var EXPIRES_AT = ${JSON.stringify(String(expiresAt))};

      var picker = document.getElementById('account_picker');
      var searchInput = document.getElementById('account_search');
      var accountIdHidden = document.getElementById('account_id_hidden');
      var suggestions = document.getElementById('account_suggestions');
      var targetIndicator = document.getElementById('target-indicator');
      var submitBtn = document.getElementById('submit-btn');

      function updateTarget() {
        if (accountIdHidden.value) {
          targetIndicator.textContent = 'Target: Contact on selected account';
          targetIndicator.classList.remove('lead');
          submitBtn.textContent = 'Create Contact';
        } else {
          targetIndicator.textContent = 'Target: Lead';
          targetIndicator.classList.add('lead');
          submitBtn.textContent = 'Create Lead';
        }
      }

      function clearSuggestions() {
        suggestions.innerHTML = '';
        suggestions.hidden = true;
      }

      function renderSuggestions(accounts) {
        suggestions.innerHTML = '';
        if (!accounts.length) {
          var empty = document.createElement('div');
          empty.className = 'suggestion';
          empty.style.color = '#888';
          empty.style.cursor = 'default';
          empty.textContent = 'No match — will create a Lead';
          suggestions.appendChild(empty);
        } else {
          accounts.forEach(function (a) {
            var div = document.createElement('div');
            div.className = 'suggestion';
            div.textContent = a.name;
            div.addEventListener('mousedown', function (e) {
              // mousedown to fire before blur
              e.preventDefault();
              searchInput.value = a.name;
              accountIdHidden.value = a.id;
              picker.classList.add('selected');
              clearSuggestions();
              updateTarget();
            });
            suggestions.appendChild(div);
          });
        }
        suggestions.hidden = false;
      }

      var debounceTimer;
      searchInput.addEventListener('input', function () {
        accountIdHidden.value = '';
        picker.classList.remove('selected');
        updateTarget();
        clearTimeout(debounceTimer);
        var q = searchInput.value.trim();
        if (q.length < 2) { clearSuggestions(); return; }
        debounceTimer = setTimeout(function () { searchAccounts(q); }, 250);
      });

      searchInput.addEventListener('blur', function () {
        setTimeout(clearSuggestions, 150);
      });

      function searchAccounts(q) {
        var params = new URLSearchParams({
          q: q, token: TOKEN, phone: PHONE,
          engagement_id: ENGAGEMENT_ID, expires_at: EXPIRES_AT
        });
        fetch('/popup/accounts/search?' + params.toString())
          .then(function (r) { return r.json(); })
          .then(function (data) { renderSuggestions(data.accounts || []); })
          .catch(function (err) { console.error('account search failed', err); });
      }

      document.querySelector('form').addEventListener('submit', function () {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Creating...';
      });

      updateTarget();
    })();
  </script>
</body>
</html>`;
}