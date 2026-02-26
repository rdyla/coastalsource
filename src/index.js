export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Only allow GET /zoho/leads
    if (request.method !== "GET" || url.pathname !== "/zoho/leads") {
      return json({ error: "Not Found" }, 404);
    }

    // API key auth from Zoom connector
    const apiKey = request.headers.get("x-api-key");
    if (!apiKey || apiKey !== env.ZOOM_API_KEY) {
      return json({ error: "Unauthorized" }, 401);
    }

    // Example query param: ?email=someone@company.com
    const email = url.searchParams.get("email");
    const phone = url.searchParams.get("phone");
    const leadId = url.searchParams.get("leadId");

    try {
      const accessToken = await getZohoAccessToken(env);

      // Build Zoho URL
      let zohoUrl;

      if (leadId) {
        zohoUrl = `https://www.zohoapis.com/crm/v2/Leads/${encodeURIComponent(leadId)}`;
      } else if (email || phone) {
        // Zoho criteria syntax
        // Example: (Email:equals:test@example.com)
        const parts = [];
        if (email) parts.push(`(Email:equals:${email})`);
        if (phone) parts.push(`(Phone:equals:${phone})`);

        // If both provided, AND them
        const criteria =
          parts.length === 1 ? parts[0] : `(${parts.join("and")})`;

        zohoUrl =
          `https://www.zohoapis.com/crm/v2/Leads/search?criteria=` +
          encodeURIComponent(criteria);
      } else {
        // Fallback: small list just to prove connectivity
        zohoUrl = "https://www.zohoapis.com/crm/v2/Leads?per_page=5";
      }

      const zohoRes = await fetch(zohoUrl, {
        headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
      });

      const zohoJson = await zohoRes.json();

      if (!zohoRes.ok) {
        // If token is invalid/expired unexpectedly, clear cache and bubble error
        if (zohoJson?.code === "INVALID_TOKEN" || zohoRes.status === 401) {
          await clearCachedToken(env);
        }
        return json({ error: "Zoho request failed", details: zohoJson }, zohoRes.status);
      }

      // Normalize response to a compact shape for Expert Assist
      const records = Array.isArray(zohoJson.data) ? zohoJson.data : (zohoJson.data ? [zohoJson.data] : []);
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
    } catch (err) {
      return json({ error: "Worker error", message: String(err?.message || err) }, 500);
    }
  },
};

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
 * - Prefer KV if bound (TOKEN_KV)
 * - Fallback to in-memory per-isolate cache
 */

let memoryToken = null;
let memoryTokenExpMs = 0;

async function getZohoAccessToken(env) {
  const now = Date.now();

  // 1) KV cache (shared across isolates)
  if (env.coastalsource_kv) {
    const raw = await env.coastalsource_kv.get("zoho_token", { type: "json" });
    if (raw?.access_token && raw?.exp_ms && now < raw.exp_ms - 30_000) {
      return raw.access_token;
    }
  } else {
    // 2) In-memory cache (per isolate)
    if (memoryToken && now < memoryTokenExpMs - 30_000) return memoryToken;
  }

  // Refresh via Zoho OAuth
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

  // Zoho sometimes omits expires_in on refresh. Assume 1 hour if missing.
  const expiresInSec = Number(data.expires_in) || 3600;
  const expMs = now + expiresInSec * 1000;

  if (env.coastalsource_kv) {
    await env.coastalsource_kv.put("zoho_token", JSON.stringify({ access_token: data.access_token, exp_ms: expMs }), {
      expirationTtl: expiresInSec,
    });
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
