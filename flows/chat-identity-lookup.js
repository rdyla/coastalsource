// Zoom CC flow script — Customer Service WebChat (hbHFsRuzRo6PkHq_y9dh6Q)
//
// Chat counterpart of the voice ANI lookup. Two differences that matter:
//
//  1. There is no ANI. The customer's email comes from the pre-chat capture,
//     read here out of the global variable crm_email.
//  2. It calls /zoom/chat-identity rather than /zoho/lookup-by-phone. That
//     endpoint STORES the identity against the engagement (KV, 24h) as well as
//     returning the Zoho match, and the storing is what lets the disposition
//     webhook open a Desk ticket afterwards. A plain /zoho/lookup-by-email call
//     returns the same data but retains nothing, so chat would still not
//     create cases.
//
// The response is deliberately the same shape as /zoho/lookup-by-phone, so the
// variable mapping below is unchanged from the voice script.

async function main () {
  try {
    var vars = var_get();

    // 1. Email collected pre-chat. Read it BEFORE anything writes to it.
    var email = vars["crm_email"] || vars["global_custom.Custom.crm_email"] || "";

    // 2. Engagement id. Confirm the exact name for your org — if none of these
    //    resolve, the log line below prints every variable that is available.
    var engagementId =
      vars["global_system.Engagement.EngagementID"] ||
      vars["global_system.Engagement.EngagementId"] ||
      vars["global_system.Engagement.ID"] ||
      vars["global_system.Engagement.engagement_id"] ||
      "";

    if (!engagementId) {
      log.error("No engagement id found. Available vars: " + JSON.stringify(Object.keys(vars)));
    }
    if (!email) {
      log.error("No crm_email set — pre-chat capture did not populate it.");
      global_var_set("crm_found", "false");
      global_var_set("crm_error", "no email collected");
      return;
    }

    // 3. Capture + lookup in one call. GET is used so no req.post is needed.
    var url = "https://coastalsource.itcontact-521.workers.dev/zoom/chat-identity"
      + "?e=" + encodeURIComponent(engagementId)
      + "&email=" + encodeURIComponent(email);

    var response = await req.get(url, {
      headers: {
        "x-api-key": "gg7UDcZwRWG_SzdggJrPIayoKdYdJAmTy7pATtjL7f4"
      }
    });

    var data = response.data;

    // 4. Core flags — identical to the voice script from here down.
    global_var_set("crm_found", data.found ? "true" : "false");
    global_var_set("crm_match_type", data.match_type || "");

    if (data.found) {
      // CONTACT
      if (data.contact) {
        global_var_set("crm_contact_id", data.contact.id || "");
        global_var_set("crm_name", data.contact.name || "");
        // NOT crm_email — that holds the collected address and is this
        // script's input. Overwriting it would destroy the input on a
        // re-run and make the failure look like "no email collected".
        global_var_set("crm_contact_email", data.contact.email || "");
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

    // 5. Popup search value — compass_id if available, else the email
    //    (the voice script falls back to the phone, which chat has not got).
    var searchVal = "";
    if (data.account && data.account.compass_id) {
      searchVal = data.account.compass_id;
    } else {
      searchVal = email;
    }
    global_var_set("global_custom.Custom.crm_search_value", searchVal);

    // data.stored === true means the identity was saved against the
    // engagement, which is what lets the disposition webhook open the ticket.
    log.info("Chat identity stored=" + data.stored + " found=" + data.found
      + " engagement=" + engagementId);

  } catch (err) {
    global_var_set("crm_found", "false");
    global_var_set("crm_error", err.message || "unknown error");
    log.error("Chat identity lookup failed: " + (err.message || JSON.stringify(err)));
  }
}
