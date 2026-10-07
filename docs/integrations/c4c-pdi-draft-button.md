# "Draft with Ask C4S" — SAP C4C PDI walkthrough

Adds a button to the SAP C4C ServiceRequest screen labelled **"Draft with Ask C4S"**. One click → Ask C4S generates a Work Description and writes it back to the field on the open ticket.

**Audience**: C4C administrator with Cloud Applications Studio (PDI) access.
**Effort**: ~1 day for first-time wiring, ~1 hour if you've added a Custom Action + Communication Arrangement before.
**Result**: FSE/coordinator opens any ServiceRequest → clicks one button → field is populated with an LLM-drafted description tailored to that ticket's symptom, equipment, and recent notes.

---

## What you'll build

```
┌──────────────────────────────┐         POST /api/integrations/c4c/
│ ServiceRequest TI (UI)       │      draft-work-description
│                              │  ┌─────────────────────────────────────┐
│  [Draft with Ask C4S]  ◀────┼──┤ Custom Action (ABSL)                │
│                              │  │   1. Build request from ticket UUID │
│  Work Description: ▾▾▾▾▾▾▾▾  │  │   2. Call Web Service Reference     │
│                              │  │   3. Write response.text into       │
└──────────────────────────────┘  │      this.WorkDescription           │
                                  └──────────────────┬──────────────────┘
                                                     │
                                            HTTPS    │  Bearer auth
                                                     ▼
                                  ┌─────────────────────────────────────┐
                                  │ Ask C4S shim                        │
                                  │   /api/integrations/c4c/            │
                                  │     draft-work-description          │
                                  │   - Reads canonical ticket          │
                                  │   - Pulls last 3 notes              │
                                  │   - Calls Claude with FSE prompt    │
                                  │   - Returns { text, style, model }  │
                                  └─────────────────────────────────────┘
```

## Prerequisites

- [ ] Cloud Applications Studio installed and connected to the target tenant
- [ ] You have the **AdministratorRole** business role in C4C
- [ ] Ask C4S is reachable from the C4C tenant over HTTPS (public DNS or VPN-resolved)
- [ ] A valid bearer token (see step 1 below)
- [ ] The endpoint `POST /api/integrations/c4c/draft-work-description` is live on Ask C4S (test with `curl` first)

## Endpoint contract (for reference)

```http
POST /api/integrations/c4c/draft-work-description
Authorization: Bearer <token>
Content-Type: application/json

{
  "objectId": "00163E532B501ED8A69548F79EC74D31",
  "style": "concise"
}
```

Response on success:
```json
{
  "ok": true,
  "text": "Replace non-functional Turbo Cooling fan on TSQ 8000...",
  "style": "concise",
  "provider": "anthropic",
  "model": "claude-sonnet-4-5",
  "inputTokens": 487,
  "outputTokens": 78
}
```

Response on error: `{ "ok": false, "error": "..." }` with HTTP 400 / 401 / 502 depending on cause.

---

## Step 1 — Generate a bearer token

The Ask C4S server (running on your own infra) gates `/api/integrations/*` behind the same sign-in as everything else. Before personal accounts exist, the shared password issues a token:

```bash
curl -X POST https://askc4s.example.com/api/internal/auth \
  -H "Content-Type: application/json" \
  -d '{"password":"<value of ASKC4S_INTERNAL_PASSWORD>"}'
```

Response:
```json
{ "ok": true, "token": "fed04fde921c4699ac148b4df15b8714" }
```

The token is valid for 24 hours, then needs renewal. For a production C4C integration you have three options:

| Pattern | Pros | Cons |
|---|---|---|
| **A. Long-lived token** stored as a Communication Arrangement secret | Simplest. No renewal logic in C4C. | Need to rotate manually every N days. |
| **B. C4C ABSL fetches a fresh token before each call** | Always fresh. Survives Ask C4S restarts. | Two HTTPS round-trips per button click. ~+800 ms latency. |
| **C. Azure AD client-credentials** (same as the KB connector) | Standard enterprise auth. No shared secret. | Most setup. Needs an Entra app + Ask C4S side accepting Azure-issued tokens. |

This walkthrough uses **Pattern A** for clarity. To upgrade to B or C later, only the ABSL action body changes — everything else stays the same.

---

## Step 2 — Communication System & Arrangement in C4C

In SAP C4C → **Administrator → Communication Systems → New**:

| Field | Value |
|---|---|
| ID | `ASKC4S_AI` |
| Description | `Ask C4S` |
| Host Name | `askc4s.example.com` *(your Ask C4S host)* |
| System Access Type | `Internet` |
| System Type | `External` |

Save & activate.

Then **Administrator → Communication Arrangements → New**:

| Field | Value |
|---|---|
| Communication Scenario | (created in step 4 below — return here after step 4) |
| Communication System | `ASKC4S_AI` |
| Authentication Method | **HTTP Basic** *(we'll override with Bearer in ABSL — see step 5)* OR **No Authentication** |
| User Name | (anything — overridden in ABSL) |
| Password | (anything — overridden in ABSL) |

> **Why "No Authentication" in the arrangement?** C4C's standard arrangement UI only knows about Basic, OAuth-Client, and SAML bearer. Our Ask C4S bearer header is set explicitly in the ABSL script, so we ask C4C not to add an `Authorization` header for us.

---

## Step 3 — Create the PDI solution

In Cloud Applications Studio:

1. **File → New → Solution**
2. Name: `AskC4SIntegration`
3. Type: `Customer Specific Solution`
4. Deployment: development tenant first

Right-click the solution → **Add → External Web Service Integration**:

- Name: `AskC4SDraftWorkDescription`
- Service Type: **REST**
- URL: `https://askc4s.example.com/api/integrations/c4c/draft-work-description`
- Method: `POST`
- Content-Type: `application/json`

If your C4C release doesn't surface REST as a service type (older releases), skip the External Web Service step and use the ABSL `WebServiceUtilities.ExecuteRESTService` API directly — sample in step 5.

---

## Step 4 — Communication Scenario

Right-click the solution → **Add → Communication Scenario**.

- Name: `AskC4SScenario`
- Direction: **Outbound**
- Service Interface: `AskC4SDraftWorkDescription` (the External Web Service from step 3)

Activate.

Now go back to the Communication Arrangement (step 2) and pick this scenario.

---

## Step 5 — The ABSL Custom Action

Right-click `BusinessObject → ServiceRequest → Extend` to create an extension on the `ServiceRequest` BO.

Add a **Custom Action** named `DraftWorkDescriptionWithAskC4S`.

### Action body (ABSL)

```absl
import ABSL;
import AP.Common.GDT as apCommonGDT;

// =====================================================================
// Build the request body.
// =====================================================================
var requestBody : ElementsOfAskC4SDraftRequest;
requestBody.objectId = this.UUID.content.ToString();
requestBody.style    = "concise";    // or "detailed" / "checklist"

// =====================================================================
// Issue the call. Two patterns depending on your release:
// =====================================================================

// --- Pattern 5a: REST via WebServiceUtilities (current C4C releases) ---
var headers : collectionof HttpHeader;
var auth : HttpHeader;
auth.Name  = "Authorization";
auth.Value = "Bearer <PASTE_ASKC4S_TOKEN_HERE>";   // see step 6 for rotation
headers.Add(auth);

var contentType : HttpHeader;
contentType.Name  = "Content-Type";
contentType.Value = "application/json";
headers.Add(contentType);

var bodyJson = JSON.Serialize(requestBody);

var response = WebServiceUtilities.ExecuteRESTService(
    "https://askc4s.example.com/api/integrations/c4c/draft-work-description",
    "POST",
    headers,
    bodyJson
);

// --- Pattern 5b: Via the Web Service Reference (older releases) ---
// If you used the External Web Service Integration from step 3, the
// scenario plumbing is more elaborate. Reach out — happy to send a
// reference snippet.

// =====================================================================
// Parse the JSON response and write into the field.
// =====================================================================
if (response.IsSet() && response.StatusCode = 200) {
    var parsed = JSON.Parse(response.Body);
    if (parsed.ok = "true") {
        // C4C field is named "ServiceRequestDescription" on some
        // releases — adjust to match your tenant.
        this.ServiceRequestDescription = parsed.text;
    } else {
        // Surface the error to the user — adjust to your taste.
        raise AskC4SDraftFailed.Create("E", parsed.error);
    }
} else {
    raise AskC4SDraftFailed.Create("E",
        "Ask C4S returned HTTP " + response.StatusCode.ToString());
}
```

> The exact field name on your tenant might be `Description`, `ServiceRequestDescription`, `WorkDescription` (KUT extension), or similar. Open the entity in the data model and confirm before pasting.

> If your release doesn't have `WebServiceUtilities.ExecuteRESTService`, the equivalent older pattern uses a generated Web Service Reference proxy — let me know which release you're on and I'll send the right snippet.

### Add a message type

To raise readable errors, add a Message in the solution:

- Name: `AskC4SDraftFailed`
- Code: `E`
- Text: `Ask C4S draft failed: &PARAM1&`
- Parameter 1: `Reason` (String)

---

## Step 6 — Token storage (where the bearer lives)

Storing the bearer as a literal in ABSL works for a dev tenant but is poor practice for production. Three better options:

### Option A: Custom Business Configuration Object

1. Add a `Business Configuration Object` to the solution named `AskC4SSettings`
2. One field: `AskC4SBearerToken : Text`
3. Add a config tile to Business Configuration that lets admins paste a new token
4. ABSL reads `AskC4SSettings.AllInstances.GetFirst().AskC4SBearerToken` instead of the hard-coded string

### Option B: Fetch on demand

ABSL action makes TWO HTTPS calls:
1. First call: `POST https://askc4s.example.com/api/internal/auth` with the Ask C4S password from a config object → returns a fresh 24h token
2. Second call: the actual draft call with that token

Cleaner posture (no long-lived token in C4C), but doubles latency.

### Option C: Azure AD bearer

If your Entra setup is mature, configure the C4C Communication Arrangement to use `OAuth 2.0 Client Credentials` with Entra. Then on Ask C4S, accept `Authorization: Bearer <entra-token>` and validate against the Entra JWKS. Same posture as the existing KB connector.

For now: paste the token in ABSL, rotate every 24h with a calendar reminder. Upgrade later.

---

## Step 7 — Wire the button on the UI

Right-click `ServiceRequest → User Interface → Quick View Floorplan` (QV) or `Thing-Inspector Floorplan` (TI) → **Extend**.

In the UI Designer:

1. Drag a **Button** onto the toolbar of the relevant screen — for FSEs the TI is most useful
2. Properties:
   - Label: `Draft with Ask C4S`
   - Icon: `BO_New_Process` (or your preference)
   - Event handler: bind to `DraftWorkDescriptionWithAskC4S` (the action from step 5)
3. Save & activate

Optionally, add **three buttons** for the three styles (`concise` / `detailed` / `checklist`) bound to three separate actions — most teams find this useful for variety.

---

## Step 8 — Activate the solution

1. In Cloud Applications Studio → right-click solution → **Activate**
2. Deploy to your dev tenant first
3. Open any ServiceRequest in C4C → confirm the new button shows up
4. Click it — within ~3 seconds the Work Description field should populate

---

## Step 9 — Verify end-to-end

| Test | Expected |
|---|---|
| Open a ServiceRequest with NO existing notes → click button | Ask C4S drafts from just the ticket header (product, serial, priority); ~200 chars |
| Open a ticket with detailed customer notes → click button | Draft references the customer's words, the specific symptom, and any part codes mentioned |
| Click button on a ticket with `WorkDescription` already filled | Field is overwritten (expected — the action is "Draft", not "Append"). Consider adding a confirmation prompt in ABSL if this surprises users. |
| Disconnect Ask C4S → click button | C4C raises `AskC4SDraftFailed: Ask C4S returned HTTP 502` (or similar) — no silent failure |
| Bad/expired token → click button | C4C raises `AskC4SDraftFailed: Unauthorized.` — admin rotates token |

---

## Troubleshooting

**Button doesn't appear**
- Solution wasn't activated, or wasn't deployed to the tenant you're viewing. Check Cloud Applications Studio → Solution Explorer → status column.

**Button appears but does nothing**
- Open browser DevTools while clicking. Look for the outbound POST to Ask C4S. If absent, the ABSL action isn't firing — usually a bind error in the UI Designer.

**Outbound call goes out but gets HTTP 401**
- Token expired or invalid. POST the password to `/api/internal/auth` again, copy the new token into ABSL, re-activate the solution.

**HTTP 502 with `LLM returned no text`**
- Ask C4S reached Claude but Claude's response was empty. Usually a hard rate-limit. Wait 60s and retry.

**HTTP 400 with `objectId is required`**
- ABSL didn't serialize `requestBody.objectId` correctly. Check the JSON in the outbound payload — should look exactly like `{"objectId":"00163...","style":"concise"}`.

**Draft populates a different field**
- The field name on your tenant differs from `ServiceRequestDescription`. Open the entity model and confirm. Common alternatives: `Description`, `Note`, `WorkDescription` (KUT extension).

**Draft is generic / not specific to the ticket**
- The ticket has no notes and only minimal product/serial info. Add notes via "Add Internal Comment" → re-draft. The model uses note text heavily for context.

---

## Production cutover checklist

- [ ] Token rotation cadence documented (calendar reminder every 23h, or upgrade to Option B/C above)
- [ ] Communication Arrangement points at production Ask C4S host, not dev
- [ ] Outbound HTTPS allowed from C4C to Ask C4S on port 443 (open with your network team if not)
- [ ] Ask C4S side has `ASKC4S_INTERNAL_PASSWORD` set in `.env` (re-enable if you disabled it temporarily)
- [ ] Test the end-to-end flow on a non-production ticket first
- [ ] Roll out to a single team before all users — watch the server log for `c4c_draft_work_description` errors
- [ ] Add to user-facing release notes: "New 'Draft with Ask C4S' button on Service Request — uses Ask C4S to draft a Work Description from ticket context"

---

## Extending the same pattern

This integration is the template for any future "AI-draft" button. To add e.g. "Draft Customer-Facing Email":

1. Add a new endpoint on Ask C4S: `POST /api/integrations/c4c/draft-customer-email` (clone `c4c-draft.ts`, swap the system prompt)
2. Add a new External Web Service Integration in the same PDI solution
3. Add a new Custom Action that calls it and writes into a different field
4. Add a new button on the UI

Same pattern, same auth, same metrics surface. ~2 hours per new field once you've done this one.

---

## Questions / blockers

- Endpoint not responding? → ping the Ask C4S admin (server may be down or in a tenant without `ASKC4S_INTERNAL_PASSWORD` set)
- ABSL doesn't compile against your release? → tell the Ask C4S team which release (e.g. 2402, 2405, 2408) so they can send the right snippet
- Want to add `detailed` and `checklist` style buttons → see step 7's optional note
