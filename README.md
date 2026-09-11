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
`name`, `description`, `status` (`active` or `published`), `price`, `currency`, `category`, `version`, `demoUrl`, `coverUrl`, `requirements`, `license`, and `driveFileId`. Optional rating fields are `ratingAverage`, `ratingCount`, and `ratingSum`. Verified buyers can submit a star rating and written review through the Market. Review JSON files are stored in Google Drive; aggregate rating fields remain in Firestore for fast catalog display.

Orders are written by the server into `orders`.

## Flutterwave webhook
Configure this endpoint in the Flutterwave dashboard:
`https://YOUR-MARKET-DOMAIN/api/webhook`

Set the same random webhook secret in `FLW_WEBHOOK_SECRET`. The endpoint verifies the exact raw request bytes with HMAC-SHA256 and then re-queries the charge before delivering value. Flutterwave recommends both signature verification and re-querying critical transaction data.

## Product ratings
Ratings use the existing Firestore database rather than Google Drive because ratings are structured records, not files. A rating is accepted only when the submitted order exists, is marked paid, and belongs to the product. One review claim is kept per successful order, so a purchase can have exactly one review. The buyer can edit that same review later without increasing the rating count; a separate successful purchase gets its own review entitlement. No new storage provider or environment variable is required.

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






## Buyer reviews
The Market now has a dedicated Reviews page. Buyers receive an anonymous Firebase identity and submit reviews only for paid orders. After a successful purchase, a durable review entitlement is created server-side so the buyer can review later even after the short-lived download token expires. Each successful order gets exactly one review claim; the buyer can edit that review later, but cannot create a second review for the same order. If the same product is purchased again, that new order receives its own review entitlement. Reviews are stored as individual JSON files in Google Drive under `GOOGLE_DRIVE_REVIEWS_FOLDER_ID`; if that variable is blank, the server creates a `WyCode Reviews` subfolder under `GOOGLE_DRIVE_FOLDER_ID`. The Drive service account therefore needs write access to the configured parent/reviews folder. Enable **Anonymous** sign-in in Firebase Authentication and set the public web API key as `VITE_FIREBASE_API_KEY`. The anonymous identity is not displayed publicly; review records retain an anonymous reviewer UID plus the verified order ID for abuse control.
