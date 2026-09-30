# WyCode Market

Mobile-first source-code marketplace with the seller Studio inside the Market menu.

## Seller storage
Sellers submit a Google Drive file URL or file ID. The source archive is not uploaded to WyCode storage. Public product responses deliberately exclude the source URL/file ID; only a verified purchase token can reach `/api/download`, which redirects to the seller-owned Drive file.

Each seller also supplies a Drive folder ID for review JSON. The configured Google service account must have access to that folder.

## Plans
- Free: up to 5 listings during the first 30 days after first publishing; $10-$30 price range.
- Pro: $10/month or $99/year; 10 listings per 30-day period; $10-$100 range; visibility and Studio access.
- Pro+: $20/month or $120/year; 20 listings per 30-day period; $10-$200 range; visibility and Studio access.
- The first 10 seller accounts receive suggested placement.

Free sellers can still enter Studio and manage their initial five-listing period; paid tiers add visibility and higher limits.

## Moderation and appeals
One authenticated buyer account can report a seller account once. Reasons are stored for review, but only the number of unique reports determines the automatic threshold. At 50 reports, the seller is permanently banned, published products are removed from the public catalog, the seller balance is preserved, and withdrawals are locked.

A banned seller can submit exactly one appeal. The Admin app can approve or reject it. Approval restores the seller and the previous product status; rejection leaves the ban in place and disables further appeals. Appeal decisions queue Gmail messages and send an FCM notification when the seller has enabled notifications.

## Marketplace
Admin-only Special Sales labels appear as a `SPECIAL SALES` category and product sticker. Sellers cannot control this label from Studio.

## Payments
Buyer payments and seller-plan payments are verified server-side with Flutterwave v4. Sellers retain the listed sale amount in the marketplace ledger. Payout requests use Flutterwave transfer capability and record the provider's actual status.

## Environment
See `.env.example`. Never put server secrets in Vite/client variables. `VITE_FIREBASE_VAPID_KEY` is public.


## Hardened marketplace flow
- Buyers use Firebase Anonymous Auth; completed orders are bound to the anonymous UID.
- Checkout, payment verification, authorization and download require that buyer UID.
- Only a verified buyer of the exact product can submit one review per product and one seller report per seller.
- Seller balances are credited only after server-side Flutterwave verification.
- Automatic seller payouts release USD balance in $50 thresholds when valid bank details exist; provider status is recorded as submitted/pending/failed.
- Seller source archives remain in seller-controlled Google Drive. Static code audits read the ZIP and store only audit metadata/errors.

## Vercel deployment
This project is intentionally consolidated to one `/api/index.js` Vercel Function so it stays within Vercel Hobby's function-count limit while preserving `/api/products`, `/api/seller`, `/api/checkout`, etc. through rewrites. Deploy from this directory as the Vercel Root Directory; do not set a nested root.

### Vercel project settings
- Root Directory: repository root (`./`)
- Framework Preset: Vite
- Build Command: `npm run build`
- Output Directory: `dist`
- Install Command: `npm install --no-audit --no-fund`
- Do not put this project inside a `market/` subfolder in the Vercel Root Directory.
- The API is intentionally a single catch-all Function at `api/[...route].js`; route implementations live under `server/` and are not separate Vercel Functions.

## Environment variables
See `.env.example`. Flutterwave credentials are server-side only. Configure `FLW_WEBHOOK_SECRET` with the secret hash already used by the Wytelab Flutterwave merchant webhook. The WyCode Market webhook endpoint is `/api/webhook`.

## Payment verification
WyCode records an order before charging, uses Flutterwave v4 idempotency, verifies charge status/amount/currency/reference before granting access, validates the Flutterwave webhook HMAC signature, records webhook events for idempotency, and keeps a direct verification fallback for pending payments.
