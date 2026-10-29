# Horizon Home Media: Aryeo connector for Claude

One small program (a "Cloudflare Worker") that does two jobs:

1. **The connector.** It gives Claude a set of Aryeo tools (list orders, confirm, reschedule, and so on). Only your Google account (ksremedia@gmail.com) can sign in.
2. **The auto-confirm check.** Every 5 minutes, 7:00 AM to 9:00 PM New York time, it confirms new bookings at the client's preferred time, or flags them for you. **It starts switched OFF** and does nothing until you turn it on.

The Aryeo API key is never in this code or this repository. It lives only as a secret in your Cloudflare account.

---

## What the auto-confirm check does

Each run (only when switched on, and only 7:00 AM–9:00 PM New York time):

1. It reads your 10 newest orders: `GET /v1/orders?per_page=10&sort=-created_at&include=appointments`.
2. It looks for appointments that are **UNSCHEDULED** and have a **preferred_start_at**. Order **#1005** (the old test record) is always skipped.
3. For each one, oldest order first, it **confirms** with `PUT /v1/appointments/{id}/schedule`. The start is the preferred time, and the end is the start plus the shoot length. It only does this when all of these are true:
   - the preferred time is in the future;
   - the client picked an exact time, not just a day or "morning/afternoon";
   - it knows how long the shoot is (from the appointment, or failing that, the products on the order);
   - the time doesn't overlap any **SCHEDULED** appointment. It checks every appointment in Aryeo, paging through all of them, not just the 10 newest.
4. Otherwise it **flags** the booking as needing manual review. A clash is flagged as "Scheduling conflict, needs manual review", with both orders' numbers, addresses, client names and times.
5. It never sends a client notification.
6. It remembers every booking it has confirmed or flagged, so none is ever handled twice. If Aryeo is having a temporary problem, nothing is recorded, and the next run tries again.

There are no emails. To see what it did, ask Claude something like *"What has the auto-confirm check done today?"*

## The tools Claude gets

| Tool | What it does | Changes anything? |
|---|---|---|
| `list_orders` | Newest orders with client, address and appointments | No |
| `get_order` | One order in full (by number, e.g. 1042), including a map-pin check | No |
| `list_upcoming_appointments` | Every upcoming appointment, paged through all of them | No |
| `list_products` | Products and variants (IDs, prices, durations) | No |
| `aryeo_lookup` | Read-only look-up of any other Aryeo page (e.g. customers) | No |
| `auto_confirm_status` | Is the check on? When did it last run? What did it confirm or flag? | No |
| `preview_auto_confirm` | Shows what the check *would* do right now, and changes nothing | No |
| `set_auto_confirm` | Turns the check on or off | The switch only |
| `confirm_appointment` | Confirms one booking, using exactly the check's rules | Yes |
| `create_order` | Order, then product (quantity 1), then appointment. It checks the address and map pin, and for clashes, first | Yes |
| `reschedule_appointment` | Moves an appointment, then reads it back to make sure | Yes |
| `cancel_appointment` | Cancels with `{}`, then reads it back to make sure | Yes |
| `mark_order_paid_offline` | Records a check payment in USD (cents), dated today unless told otherwise | Yes |

Notifications to clients happen only when you ask:
- Reschedule and cancel send `notify_customer: true` only when you ask for it. It goes in that one call, because Aryeo can't send it later.
- New orders are created with `notify: false` unless you ask.

There is no code at all for deleting orders, refunds, price edits or customer edits.

---

## Setup, step by step

You'll need about 30 minutes. Steps marked *(me)* are things Claude does for you.

### 1. Put the code on GitHub (done)
The code lives in this repository, `ksremedia-spec/MCL-Aryeo`. It's public, which is fine for security: there are no keys or passwords in it, and sign-in protects everything. Every change pushed to `main` deploys automatically once step 2 is done.

### 2. Connect the repository to Cloudflare (first deploy)
1. In the Cloudflare dashboard, go to **Workers & Pages → Create application → Import a repository** (it may just say **GitHub**). Authorize GitHub and pick `mcl-aryeo`.
2. The project name must be exactly **`mcl-aryeo`**. Leave the build command empty, and leave the deploy command as `npx wrangler deploy`.
3. Click **Save and Deploy** and wait for the build to finish. Cloudflare creates the two storage areas by itself.
4. Write down the Worker's address. It looks like `https://mcl-aryeo.YOUR-NAME.workers.dev`. Opening it in a browser shows a short "private Claude connector" page.

The schedule (`*/5 0-2,11-23 * * *`) now shows under the Worker's **Settings → Triggers**. That's expected: the check is still **OFF**, so each run stops right away without looking at Aryeo.

### 3. Create the Google sign-in
1. Go to https://console.cloud.google.com/ and create a project, e.g. "Horizon Aryeo Connector".
2. Open **Google Auth Platform** (https://console.cloud.google.com/auth/overview) and click **Get started**:
   - App name "Horizon Aryeo Connector", support email ksremedia@gmail.com.
   - Audience **External**, contact email ksremedia@gmail.com.
3. Under **Audience → Test users**, add **ksremedia@gmail.com**. Leave the app in **Testing**: only test users can sign in, which is an extra lock.
4. Under **Clients → Create client**:
   - Type **Web application**.
   - Under **Authorized redirect URIs**, add `https://mcl-aryeo.YOUR-NAME.workers.dev/callback`, using your address from step 2.
   - Click **Create**, then copy the **Client ID** and **Client secret**.

### 4. Add the three secrets in Cloudflare
In Cloudflare, open the Worker and go to **Settings → Variables and Secrets → Add**. Choose type **Secret** for each one:

| Name | Value |
|---|---|
| `ARYEO_API_KEY` | Your Aryeo API key (in Aryeo, from your group's developer/API settings) |
| `GOOGLE_CLIENT_ID` | From step 3 |
| `GOOGLE_CLIENT_SECRET` | From step 3 |

Click **Deploy** to save. Secrets survive every later deploy, and nobody (including Claude) can read them back.

### 5. Add the connector in Claude
1. In claude.ai, go to **Customize → Connectors → Add custom connector**.
2. Name: `Horizon Aryeo`. URL: `https://mcl-aryeo.YOUR-NAME.workers.dev/mcp`.
3. Authentication: **Sign in now**. OAuth client: **Use Claude's published identity**.
4. Click **Add**, then sign in with Google as **ksremedia@gmail.com**.
   - If sign-in fails, remove the connector and add it again with **Register automatically** instead.
5. Optional but recommended: in **Customize → Connectors → Horizon Aryeo**, leave the tools that change things on "ask every time". Then Claude asks before confirming, rescheduling, cancelling, creating or recording payments.
6. In a chat, turn it on from **+ → Connectors**.

### 6. Read-only test on your real account
Ask Claude, in a chat with the connector on:
- "List my 10 newest Aryeo orders."
- "List my upcoming appointments."
- "Preview the auto-confirm check."
- "What's the auto-confirm status?"

None of these change anything. Send the answers (or anything that looks wrong) to Claude in this project. *(me)* I'll adjust any field names that differ from what the code expects. Nothing that changes a booking runs until you say so.

### 7. Turn the check on (when you're ready)
1. Turn off your old auto-confirm system first, so bookings aren't confirmed twice.
2. Ask Claude: **"Turn on the auto-confirm check."**
3. To stop it at any time, ask: **"Turn off the auto-confirm check."**
   - Emergency stop without Claude: Cloudflare → the Worker → **Settings → Triggers** → delete the cron schedule. The next deploy puts the schedule back, but the switch stays where you left it.

---

## Verified vs. assumed

**Verified (October 28, 2026), against the current docs and by tests:**
- Claude's connector requirements: the sign-in handshake, the "published identity" method and the callback URL. Everything was tested end to end with Google and Aryeo stood in by fakes.
- Cloudflare's schedules are UTC-only. The 7 AM–9 PM rule was tested across the Nov 1, 2026 and Mar 14, 2027 clock changes.
- The real Workers runtime (run locally) serves the sign-in pages, refuses apps other than Claude, and runs the scheduled check against a pretend Aryeo. That pretend Aryeo was confirmed to receive the API key, `Accept: application/json` and the User-Agent.

**Assumed from your notes and Aryeo's 2021 SDKs.** Aryeo's current docs and API couldn't be reached from the build environment. These get checked by the read-only test in step 6:
- `PUT /appointments/{id}/schedule`, `POST /order-items`, `POST /appointments/store`, `POST /orders/{id}/payments`, and the `UNSCHEDULED`/`SCHEDULED` statuses.
- `GET /addresses/{id}` (used by `create_order` to check the address first) and `GET /appointments/{id}` (with a fallback to searching the full list).
- Field names: `duration` (minutes), `preference_type`, `street_number`, `street_name`, `latitude`, `longitude`, `customer`, `total_amount`, `include=order` on appointments (with a fallback without it).
- `notify: false` on new orders keeps Aryeo from emailing the client.
- The independent geocoder is the free US Census Bureau geocoder. A pin more than 300 m away is treated as a likely mis-pin.

## Webhooks (for later)
Aryeo appears to offer webhooks. This comes from search snippets of its "Setting Up Webhooks" page, which I couldn't open:
- Aryeo posts JSON to your URL with a `Signature` header (HMAC-SHA256 with a secret you choose).
- It retries after 10 seconds and again after 100 seconds.
- Webhook management in the web app is "feature-flagged", so you may need to ask Aryeo support to enable it.
- Zapier's Aryeo app shows "Order Created" and "Appointment Scheduled" events.

The suggested shape, if we use them: a webhook triggers the same check within seconds of a new order, and the 5-minute check stays on as a safety net.

---

## For developers

- `src/index.ts`: entry point. OAuth provider (`@cloudflare/workers-oauth-provider`) around the MCP handler (`agents/mcp/server`, Streamable HTTP at `/mcp`), plus the `scheduled` handler.
- `src/auth.ts`: consent page, Google upstream sign-in (PKCE), allow-list of one email and of Claude's callback URLs.
- `src/autoconfirm.ts`: the rules. `src/tools.ts`: the MCP tools. `src/aryeo.ts`: API client and response-shape handling.
- `src/store.ts`: KV state (switch, handled list, activity log, last run). `src/time.ts`: New York time helpers.
- `npm test` runs the test suite (vitest), and `npm run type-check` runs the TypeScript check.
- Local run: put fake values in `.dev.vars` (gitignored) and run `npx wrangler dev --test-scheduled`. `ARYEO_BASE_URL` can point at a mock server for testing; never set it in production.
