# WyCode Market v1.0.9

Private source-code marketplace designed for Vercel. The public catalog reads products from Firestore (the same collection used by WyCode Studio). Paid source files remain private in Google Drive.

## Flow
1. Customer selects an active product and enters checkout details.
2. Backend creates an order and starts a Flutterwave v4 Orchestrator direct charge.
3. Card fields are encrypted with AES-256-GCM before they are sent to Flutterwave; WyCode does not persist card details.
4. Customer follows the Flutterwave authorization/redirect step when one is returned.
5. Flutterwave webhook is verified against the raw request body and the charge is re-queried before an order is marked paid.
6. Customer return page also re-queries the charge as a backup.
7. A short-lived HMAC download token is issued only for a verified paid order.
8. `/api/download` validates the token, checks the Drive file is inside the configured private folder (including nested subfolders), then streams the file through the server. No raw Drive URL is exposed.

## Environment variables
Set these in Vercel. Never put these secrets in `VITE_*` variables.

### Flutterwave v4
- `FLW_CLIENT_ID` — Flutterwave v4 client ID.
- `FLW_CLIENT_SECRET` — Flutterwave v4 client secret.
- `FLW_ENCRYPTION_KEY` — Flutterwave card-encryption key. It must decode from base64 to exactly 32 bytes for AES-256-GCM.
- `FLW_WEBHOOK_SECRET` — webhook secret hash configured in Flutterwave.
- `FLW_ENVIRONMENT` — `sandbox` while testing, `production` for live.

### App
- `APP_URL` — deployed Market URL, e.g. `https://market.example.com`.
- `DOWNLOAD_TOKEN_SECRET` — random 32+ character secret used to sign 15-minute download tokens.

### Google Drive
- `GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON` — entire Google service-account JSON. Share the private source folder with its `client_email`.
- `GOOGLE_DRIVE_FOLDER_ID` — private Drive folder ID.

### Firebase Admin / Firestore
- `FIREBASE_SERVICE_ACCOUNT_JSON` — optional separate Firebase Admin credential. If omitted, the Drive service-account JSON is reused. The selected service account must have Firestore access.

## Firestore
WyCode Studio creates documents in `products`. Market expects:
`name`, `description`, `status` (`active` or `published`), `price`, `currency`, `category`, `version`, `demoUrl`, `coverUrl`, `requirements`, `license`, and `driveFileId`.

Orders are written by the server into `orders`.

## Flutterwave webhook
Configure this endpoint in the Flutterwave dashboard:
`https://YOUR-MARKET-DOMAIN/api/webhook`

Set the same random webhook secret in `FLW_WEBHOOK_SECRET`. The endpoint verifies the exact raw request bytes with HMAC-SHA256 and then re-queries the charge before delivering value. Flutterwave recommends both signature verification and re-querying critical transaction data.

## Google Drive delivery
The server uses the Drive API to retrieve private blob content with `files.get` + `alt=media`, after checking download capability and the configured folder ancestry.

## Important payment note
This build uses Flutterwave v4 OAuth 2.0 and the v4 Orchestrator/direct-charge flow. Flutterwave's current v4 card documentation requires card fields to be encrypted with AES-256 and sent as encrypted fields, so `FLW_ENCRYPTION_KEY` is now required for card checkout.

Do not log or persist card numbers, CVV, expiry values, or decrypted card payloads. Complete any payment/compliance requirements applicable to your Flutterwave account before going live.

## Security
- Flutterwave client secret and encryption key stay server-side.
- Drive credentials stay server-side.
- Raw Drive URLs are never returned to buyers.
- Download links are HMAC-signed and expire after 15 minutes.
- Download endpoint verifies order payment state and Drive folder ancestry.
- Webhook signature is checked against the raw request body.
- Webhook and return verification re-query the Flutterwave charge before marking an order paid.
- Flutterwave idempotency keys use the required alphanumeric format.

## Deploy
Install dependencies and run `npm run build`, then deploy to Vercel. The `api/*.js` files become Vercel serverless functions.

### Vercel variables to restore
Add the following as **Server-only** Vercel environment variables for the environments you use (Preview/Production as appropriate):

```text
FLW_CLIENT_ID
FLW_CLIENT_SECRET
FLW_ENCRYPTION_KEY
FLW_WEBHOOK_SECRET
FLW_ENVIRONMENT
APP_URL
DOWNLOAD_TOKEN_SECRET
GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON
GOOGLE_DRIVE_FOLDER_ID
FIREBASE_SERVICE_ACCOUNT_JSON   # optional if reusing the Drive service account
```

Never paste the actual secret values into chat or commit them to Git.


## Production smoke test
Verify legal accordions, outside-touch/Escape dismissal, invalid-input alerts, a completed purchase, and that the product sales count and Top Sales ranking update only after payment verification.



### Pro payment
Pro access is sold separately from product purchases through the same Flutterwave v4 integration. The fixed prices are **$16 USD** or **₦17,500 NGN**. A Pro order is created in Firestore, paid through the v4 Orchestrator/direct-charge flow, and the customer is marked `pro: true` / `plan: "pro"` only after the charge is re-queried and its status, amount, currency, and reference are verified.

The Pro checkout uses the same server-only `FLW_CLIENT_ID`, `FLW_CLIENT_SECRET`, `FLW_ENCRYPTION_KEY`, and `FLW_WEBHOOK_SECRET` variables. No separate payment credentials are required.

### Free Pro testing
Set server-only `PRO_FREE_TEST_MODE=true` on a Vercel Preview/testing environment to activate Pro for free. In this mode no Flutterwave charge is created; the backend grants `pro: true` / `plan: "pro"` and records a `free-test` Pro order. The UI automatically shows a clear TEST MODE notice. **Disable `PRO_FREE_TEST_MODE` before enabling live Pro payments.**

## Pro purchase recovery

The marketplace includes an optional Pro-only purchase recovery flow. A Pro customer enters the email used for purchases, receives a one-time code, and after verification receives an email containing secure download links for all completed purchases associated with that email. Recovery links expire after 24 hours.

Recovery email delivery uses Resend over the server-side API; no email API key is exposed to the browser. Configure:
- `RESEND_API_KEY` — server-only Resend API key.
- `RECOVERY_FROM_EMAIL` — verified sender address/domain in Resend.
- The same Resend settings are used for automatic purchase receipts after a payment is server-verified. Receipt delivery failure never changes a verified order back to unpaid; the customer can use free purchase recovery to obtain a fresh download link.
- `PRO_RECOVERY_EMAILS` — optional comma-separated Pro email allowlist for testing/manual Pro access.

A customer document may also be marked `pro: true` or `plan: "pro"` in Firestore. This keeps the feature locked by default until your Pro billing/entitlement system is connected. `DOWNLOAD_TOKEN_SECRET` must remain configured because it signs the recovery links.
