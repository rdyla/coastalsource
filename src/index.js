export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Only allow /zoho/* routes
    if (!url.pathname.startsWith("/zoho/")) {
      return json({ error: "Not Found" }, 404);
    }

    // Only allow GET for now
    if (request.method !== "GET") {
      return json({ error: "Method Not Allowed" }, 405);
    }

    // API key auth (applies to all /zoho/* routes)
    const authErr = requireApiKey(request, env);
    if (authErr) return authErr;

    // Router table
    const routes = {
      "/zoho/leads": handleLeads,
      "/zoho/account-summary": handleAccountSummary,
      "/zoho/lookup-by-phone": handleLookupByPhone,
      // add more here:
      // "/zoho/contacts": handleContacts,
      // "/zoho/lookup": handleLookup,
    };

    const handler = routes[url.pathname];
    if (!handler) return json({ error: "Not Found" }, 404);

    try {
      return await handler(request, env, ctx, url);
    } catch (err) {
      if (err?.details && err?.status) {
        return json({ error: "Zoho request failed", details: err.details }, err.status);
      }
      return json({ error: "Worker error", message: String(err?.message || err) }, 500);
    }
  },
};

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

  const accessToken = await getZohoAccessToken(env);

  // Normalize: keep digits only
  const digits = phoneRaw.replace(/\D/g, "");
  const candidates = buildPhoneCandidates(digits);

  // 1) Try Contacts first (most reliable for ANI -> person)
  // We'll try multiple phone fields to improve hit rate.
  for (const p of candidates) {
    const contact = await tryFindContactByPhone(accessToken, p);
    if (contact) {
      // If contact links to an account, fetch account summary
      const accountId = contact?.Account_Name?.id || null;

      let accountSummary = null;
      if (accountId) {
        accountSummary = await fetchAccountSummaryById(accessToken, accountId);
      }

      return json({
        found: true,
        match_type: "contact",
        phone_normalized: p,
        contact: {
          id: contact.id,
          name: [contact.First_Name, contact.Last_Name].filter(Boolean).join(" "),
          email: contact.Email ?? null,
          phone: contact.Phone ?? null,
          mobile: contact.Mobile ?? null,
          account_id: accountId,
          account_name: contact?.Account_Name?.name ?? null,
          owner_name: contact?.Owner?.name ?? null,
          modified_time: contact.Modified_Time ?? null,
        },
        account: accountSummary,
      });
    }
  }

  // 2) Fall back to Accounts by Phone
  for (const p of candidates) {
    const account = await tryFindAccountByPhone(accessToken, p);
    if (account) {
      return json({
        found: true,
        match_type: "account",
        phone_normalized: p,
        contact: null,
        account: summarizeAccount(account),
      });
    }
  }

  return json({ found: false, match_type: null, contact: null, account: null });

  /* ---- inner helpers that can use env via closure ---- */

async function tryFindContactByPhone(token, phoneCandidate) {
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
      // If field isn't searchable, skip it and continue
      if (
        err?.details?.code === "INVALID_QUERY" &&
        err?.details?.details?.reason?.includes("field is not available for search")
      ) {
        continue;
      }
      // Anything else is a real error
      throw err;
    }
  }

  return null;
}

  async function tryFindAccountByPhone(token, phoneCandidate) {
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

/* -----------------------------
 * Route Handlers: Account summary by ID
 * ----------------------------- */

  async function fetchAccountSummaryById(token, accountId) {
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

      // customer-requested fields
      account_type: record.Account_Type ?? null,
      dealer_tier: record.Dealer_Tier ?? null,
      kam_owner: record.KAM_Owner ?? null,
      rep_firm: record.Rep_Firm ?? null,
      dealer_start_date: record.Dealer_Start_Date ?? null,

      // useful extras
      owner_name: record?.Owner?.name ?? null,
      owner_email: record?.Owner?.email ?? null,
      phone: record.Phone ?? null,
      email_address: record.Email_Address ?? null,
      modified_time: record.Modified_Time ?? null,
    };
  }
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