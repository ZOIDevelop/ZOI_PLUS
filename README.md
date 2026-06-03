# ZOI PLUS E-commerce

Storefront for ZOI PLUS with two primary flows:

- `Shop now`: product catalog, cart and checkout.
- `Request an automatic quote`: lead capture for sourcing or custom creation.

## Inventory

The inventory source is Google Sheets. Create a sheet named `Productos` with these columns:

```text
sku,nombre,categoria,tags,descripcion,precio,stock,foto_url,visible,orden
```

Use `tags` separated by commas, for example:

```text
new,gift,premium
```

Images should live in an external image host such as Cloudinary. Paste the public image URL into `foto_url`. The site always displays product images in a square format.

## Local setup

1. Copy `.env.example` to `.env`.
2. Add either `GOOGLE_SHEET_CSV_URL` or `GOOGLE_SHEET_ID`.
3. Add `N8N_ORDER_WEBHOOK_URL` and `N8N_QUOTE_WEBHOOK_URL` when n8n is ready.
4. Optionally add `PAYMENT_CHECKOUT_URL` as a temporary payment link while the final payment provider is not ready.
5. PayPal fallback is configured to `PAYPAL_RECEIVER_EMAIL=info@zoi.ec`.
6. Add `GOOGLE_CLIENT_ID` to enable real Sign in with Google.
7. Run:

```bash
npm run dev
```

Then open:

```text
http://localhost:4173
```

If Google Sheets or n8n are not configured, the app uses sample products and simulates successful submissions.

## Temporary local backups

Orders and quote requests are backed up before n8n is called. The server writes temporary CSV files in `data/backups/`:

- `orders.csv`
- `quotes.csv`

These files can be opened in Excel and keep the full request in `payload_json`. Rows expire after 48 hours and are cleaned automatically on server startup and before each new submission. Backup CSV files are ignored by Git so customer data is not committed accidentally.

## Google Sheets options

Preferred simple option:

- In Google Sheets, publish the `Productos` tab as CSV.
- Paste the CSV URL into `GOOGLE_SHEET_CSV_URL`.

Alternative public sheet option:

- Paste the sheet ID into `GOOGLE_SHEET_ID`.
- Set `GOOGLE_SHEET_GID` to the tab gid, usually `0`.

## n8n payloads

Orders are sent to `POST /api/orders`, then forwarded to `N8N_ORDER_WEBHOOK_URL`.

For payments, n8n should create or retrieve a payment checkout and return one of these fields:

```json
{
  "payment_url": "https://..."
}
```

Accepted aliases are `paymentUrl`, `checkout_url`, `checkoutUrl`, or `url`. The storefront shows that link as the secure payment action.

Quotes are sent to `POST /api/quotes`, then forwarded to `N8N_QUOTE_WEBHOOK_URL`.

The server adds:

```json
{
  "id": "ORDER-...",
  "source": "zoi-plus-ecommerce",
  "receivedAt": "..."
}
```

Stock should be discounted by the n8n workflow only after payment is confirmed.

## PayPal

The current PayPal button uses a simple PayPal payment flow with `info@zoi.ec` as receiver and the cart subtotal as the payment amount. For a production-grade PayPal integration, use the current PayPal JavaScript SDK with a REST Client ID connected to the receiving PayPal business account.

## Google Sign-In

The storefront supports Google Identity Services. Add a Google OAuth Web Client ID to `GOOGLE_CLIENT_ID` and restart the server. Until that value exists, the local page shows a development sign-in button so the cart can be tested as a registered user.

Cart storage is user-aware:

- Guest cart: `zoi-cart:guest`
- Signed-in cart: `zoi-cart:<google-sub-id>`

When a guest signs in, the guest cart is merged into the signed-in cart.
