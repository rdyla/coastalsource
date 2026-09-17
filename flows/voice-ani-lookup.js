// Zoom CC flow script — voice queues (ANI lookup).
//
// Flow scripts live only in the Zoom flow designer, so like the worker they
// have no version history unless kept here; see HANDOFF's deploy-state note
// for why that matters on this project.
//
// Two things changed on 2026-09-17:
//
//  1. The API key is read from a flow variable instead of being hardcoded.
//     Set global_custom.Custom.x-api-key in the Variable widget to the current
//     ZOOM_API_KEY. NEVER paste the key back into this file — it is a public
//     repo and the previously committed key had to be rotated because of it.
//  2. Contact variables are written with the global_custom.Custom. prefix.
//     They used to be written bare (crm_name), which is why agents saw the
//     company but never the caller's name: bare names don't land in the
//     namespace the screen pop reads. Confirmed fixed in production.

async function main () {
  try {
    // 1. Get caller phone
    var phone = var_get()["global_system.Engagement.ANI"];

    // API key from a flow variable. Pull it into a local first so a missing or
    // misnamed variable fails with a clear message instead of a confusing 401.
    var apiKey = var_get()["global_custom.Custom.x-api-key"];
    if (!apiKey) {
      throw new Error("api key variable is empty - check the custom variable name");
    }

    // 2. Build request URL
    var url = "https://coastalsource.itcontact-521.workers.dev/zoho/lookup-by-phone?phone=" + encodeURIComponent(phone);

    // 3. Call your middleware
    var response = await req.get(url, {
      headers: {
        "x-api-key": apiKey
      }
    });

    var data = response.data;

    // 4. Core flags
    global_var_set("global_custom.Custom.crm_found", data.found ? "true" : "false");
    global_var_set("global_custom.Custom.crm_match_type", data.match_type || "");

    if (data.found) {

      // CONTACT
      if (data.contact) {
        global_var_set("global_custom.Custom.crm_contact_id", data.contact.id || "");
        global_var_set("global_custom.Custom.crm_name", data.contact.name || "");
        global_var_set("global_custom.Custom.crm_email", data.contact.email || "");
        global_var_set("global_custom.Custom.crm_phone", data.contact.phone || "");
        global_var_set("global_custom.Custom.crm_rep", data.contact.rep || "");
      }

      // ACCOUNT
      if (data.account) {
        global_var_set("global_custom.Custom.crm_compass_id", data.account.compass_id || "");
        global_var_set("global_custom.Custom.crm_account_name", data.account.account_name || "");
        global_var_set("global_custom.Custom.crm_account_type", data.account.account_type || "");
        global_var_set("global_custom.Custom.crm_dealer_tier", data.account.dealer_tier || "");
        global_var_set("global_custom.Custom.crm_kam_owner", data.account.kam_owner || "");
        global_var_set("global_custom.Custom.crm_dealer_start_date", data.account.dealer_start_date || "");
      } else if (data.contact && data.contact.account_name) {
        // Account-summary fetch can come back empty even when the contact
        // carries the account name — don't leave the agent with a blank company.
        global_var_set("global_custom.Custom.crm_account_name", data.contact.account_name || "");
      }
    }

    // POPUP SEARCH VALUE — compass_id if available, else phone
    var searchVal = "";
    if (data.account && data.account.compass_id) {
      searchVal = data.account.compass_id;
    } else {
      searchVal = phone;
    }
    global_var_set("global_custom.Custom.crm_search_value", searchVal);
    log.info("Zoho lookup success: " + JSON.stringify(data));

  } catch (err) {
    global_var_set("global_custom.Custom.crm_found", "false");
    global_var_set("global_custom.Custom.crm_error", err.message || "unknown error");

    log.error("Zoho lookup failed: " + (err.message || JSON.stringify(err)));
  }
}
