// Zoom CC flow script — voice queues (ANI lookup).
//
// Recorded here as deployed on 2026-08-29. Flow scripts live only in the Zoom
// flow designer, so like the worker they have no version history unless kept
// here; see HANDOFF's deploy-state note for why that matters on this project.
//
// Known wart, left as-is because downstream steps may reference these names:
// contact variables are set unprefixed (crm_name) while account variables use
// the global_custom.Custom. prefix.

async function main () {
  try {
    // 1. Get caller phone
    var phone = var_get()["global_system.Engagement.ANI"];

    // 2. Build request URL
    var url = "https://coastalsource.itcontact-521.workers.dev/zoho/lookup-by-phone?phone=" + encodeURIComponent(phone);

    // 3. Call your middleware
    var response = await req.get(url, {
      headers: {
        "x-api-key": "gg7UDcZwRWG_SzdggJrPIayoKdYdJAmTy7pATtjL7f4"
      }
    });

    var data = response.data;

    // 4. Core flags
    global_var_set("crm_found", data.found ? "true" : "false");
    global_var_set("crm_match_type", data.match_type || "");

    if (data.found) {

      // CONTACT
      if (data.contact) {
        global_var_set("crm_contact_id", data.contact.id || "");
        global_var_set("crm_name", data.contact.name || "");
        global_var_set("crm_email", data.contact.email || "");
        global_var_set("crm_phone", data.contact.phone || "");
        global_var_set("crm_rep", data.contact.rep || "");
        global_var_set("crm_account_name", data.contact.account_name || "");
      }

      // ACCOUNT
      if (data.account) {
        global_var_set("global_custom.Custom.crm_compass_id", data.account.compass_id || "");
        global_var_set("global_custom.Custom.crm_account_name", data.account.account_name || "");
        global_var_set("global_custom.Custom.crm_account_type", data.account.account_type || "");
        global_var_set("global_custom.Custom.crm_dealer_tier", data.account.dealer_tier || "");
        global_var_set("global_custom.Custom.crm_kam_owner", data.account.kam_owner || "");
        global_var_set("global_custom.Custom.crm_dealer_start_date", data.account.dealer_start_date || "");
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
    global_var_set("crm_found", "false");
    global_var_set("crm_error", err.message || "unknown error");

    log.error("Zoho lookup failed: " + (err.message || JSON.stringify(err)));
  }
}
