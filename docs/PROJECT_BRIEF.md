# Oloolua Stores Collection System — Project Brief

## Context

Oloolua Hardware Stores is a hardware shop in Ngong Hills, Kenya. The shop (where customers are served and pay) is physically separate from the stores (where customers collect their goods). Currently, customers receive a duplicate receipt or handwritten note at the shop, walk to the stores, and an employee manually copies the contents into a paper counter book before releasing the goods.

This project replaces that counter book with a digital system. The stores employee scans the receipt or note with their smartphone, the system extracts the data using AI vision, the employee confirms it on-screen, and it gets saved to Google Sheets.

## Goals

1. Eliminate the manual counter-book transcription
2. Give the business owner visibility into operations he's never had: pending collections, salesperson performance, top customers, product velocity, daily reconciliation
3. Build an auditable digital record (every scan stores the original image)

## Two document types to handle

### A. Printed receipts (Urovo POS)

Issued at the shop. Two variants: "ORIGINAL" and "DUPLICATE". Layout is consistent. Sample fields:
- Document label (ORIGINAL/DUPLICATE)
- Trnx Ref (unique transaction number — gold for deduplication)
- Salesperson name
- Date and time
- Line items: description, qty, unit price, amount
- Balance, Discount, Total
- Payment method
- Status

Sometimes has a handwritten manual marking on top (e.g., "INVOICE/8403", "816"). Capture this separately.

**OCR accuracy in testing: ~98%.** Reliable.

### B. Handwritten notes

Issued for items that don't go through the POS. Written on whatever paper is handy (sometimes torn notepad sheets, sometimes branded supplier pads like DuraCoat). Stamped with the Oloolua Hardware Stores rubber stamp. Fields:
- Customer name (top of note, e.g., "Gabriel", "MULI", "MR Mwangi")
- Item list with quantity + description (e.g., "52pcs wire mesh H/G", "3 rolls chainlink 6ft")
- Date (often from the stamp, e.g., "13/12/25")
- Salesperson signature (often "Maurine")
- Oloolua Hardware Stores stamp

**OCR accuracy in testing: ~85-90%.** Workable with employee confirmation step.

## Architecture

### Stack
- **Frontend:** Progressive Web App (PWA) — works on any smartphone, installs to home screen, no Play Store needed
- **OCR:** Anthropic Claude API (vision-capable model) for both printed receipts and handwritten notes
- **Backend:** Google Apps Script attached to a Google Sheet
- **Storage:** Google Drive for original receipt images, Google Sheets for structured data

### Data flow
1. Employee opens PWA on phone → taps "Scan Receipt" or "Scan Note"
2. Camera captures image
3. Image uploaded to Google Drive (folder for that month/day)
4. Image base64 sent to Claude API with the appropriate extraction prompt
5. Returned JSON pre-fills a confirmation form
6. Employee reviews, taps to correct any field, picks items from product dropdown if needed
7. On Save → Apps Script writes row to today's tab in the current month's Sheet, with the Drive image link

## Google Sheets structure

### Workbook organization
- One workbook per month: e.g., "Oloolua Collections - April 2026"
- Inside each workbook:
  - One tab per day: "01-04-2026", "02-04-2026", etc. (auto-created on first scan of the day)
  - Tab: "Summary" (auto-aggregates the month)
  - Tab: "Products" (canonical product catalog, self-updating)
  - Tab: "Aliases" (maps shorthand notations to canonical names)
  - Tab: "Customers" (auto-built from handwritten note customer names)
  - Tab: "Staff" (salesperson + stores employee list)

### Daily tab columns

| Column | Description |
|---|---|
| Timestamp | When the scan was saved |
| Receipt Type | "Printed" or "Handwritten" |
| Document Label | "ORIGINAL", "DUPLICATE", or "Note" |
| Trnx Ref | For printed receipts |
| Manual Marking | Handwritten markings on receipts (e.g., "INVOICE/8403") |
| Customer Name | For handwritten notes; null for printed |
| Salesperson | From receipt/signature |
| Stores Employee | Who scanned it (logged in user) |
| Sale Date | When the sale was originally made |
| Sale Time | If on receipt |
| Collection Time | Same as Timestamp (when scanned at stores) |
| Time Gap (mins) | Calculated: Collection Time - Sale Time |
| Item Count | Number of line items |
| Items (JSON) | Full item list as JSON for detail |
| Item Summary | Human-readable summary, e.g., "Cement Nyumba x18, grout grey 1kg x12" |
| Total Amount | KSh, for printed receipts; null for handwritten |
| Status | "Collected" / "Pending" / "Partial" |
| Drive Image Link | URL to original image in Drive |
| Notes | Free text for stores employee |
| Flag | Any anomaly: "Duplicate Trnx", "Amount Mismatch", "Low OCR Confidence" |

### Products tab columns

| Column | Description |
|---|---|
| Canonical Name | The standard name for this product |
| Category | Steel sections, Cement, Wire products, Roofing, Plumbing, Reinforcement, Fasteners, Other |
| First Seen | Date first sold |
| Times Sold | Counter |
| Last Sold | Date last sold |
| Typical Price | Most common unit price (auto-updates) |
| Common Unit | pcs, rolls, kg, etc. |
| Active | Yes/No (manual flag for discontinued items) |

### Aliases tab columns

| Column | Description |
|---|---|
| Alias | The variation as written (e.g., "1¼ x 1¼ x 16g", "wiremesh #19") |
| Canonical Name | Maps to Products tab (e.g., "40x40x1.5mm Square Tube", "Wire Mesh H/G") |
| Notes | Optional context |

## Domain knowledge (seed data)

### Wire mesh gauge codes
- H/G = Heavy Gauge
- M/G = Medium Gauge
- L/G = Light Gauge

### Steel sections — dual notation
Imperial (gauge) and metric (mm) are equivalent. Examples:
- 1¼ x 1¼ x 16g ↔ 40x40x1.5mm
- 1½ x 1½ x 16g ↔ 50x50x1.5mm
- 1 x 1 x 18g ↔ 25x25x1.2mm (verify with owner)

Recommend metric as the canonical form (unambiguous).

### Common product categories at Oloolua
- Cement (Cement Nyumba, Simba, etc.) — sold by 50kg bag
- Grout — sold per kg
- Steel sections: Square Tube (RHS), Flat Bar (FB or "fluat"), Angle Iron, Round Bar
- Wire products: Wire Mesh (H/G, M/G, L/G), Chain Link (by foot: 5ft, 6ft), Binding Wire (by roll), BRC
- Roofing: Clear Sheets (by metre: 2.5m, 3m), IT5 sheets, Ridges (by gauge), Roofing Nails (by kg)
- Plumbing: PVC pipes (by inch: 2", 4", 6"), Bends, Tees, Plugs, Floor Traps, Metal Clips
- Reinforcement: D-bars (D-8, D-10, D-12, D-16, D-20, D-25)
- Fasteners: Nails (by size in inches and weight in kg)

### Salespeople observed in samples
Maurine, Irene. (List will grow — Staff tab handles this.)

## OCR prompts

### Prompt for printed Urovo receipts

```
You are extracting data from a printed receipt issued by Oloolua Hardware Stores in Kenya. The POS is Urovo. Receipts may be labelled "ORIGINAL" or "DUPLICATE" at the top.

Return a JSON object with this exact structure:
{
  "receipt_type": "printed",
  "document_label": "ORIGINAL" | "DUPLICATE",
  "manual_marking": "any handwritten text on the receipt, e.g. 'INVOICE/8403' or null",
  "trnx_ref": "the Trnx Ref number as a string",
  "salesperson": "name as printed",
  "narration": "narration field or N/A",
  "date": "DD-MM-YYYY",
  "time": "HH:MM",
  "items": [
    {"line": 1, "description": "...", "qty": number, "unit_price": number, "amount": number}
  ],
  "balance": number,
  "discount": number,
  "total": number,
  "status": "paid" | "unpaid" | "partial",
  "payment_method": "Cash" | "Mpesa" | "Bank" | other,
  "confidence": {
    "trnx_ref": "high" | "medium" | "low",
    "total": "high" | "medium" | "low",
    "items": "high" | "medium" | "low"
  }
}

Rules:
- Read decimal numbers carefully — Urovo prints "530.0" meaning 530.
- "KE" in the receipt is "KSh" (Kenyan Shilling).
- If a field is unreadable, set it to null and lower its confidence score.
- Return ONLY the JSON object, no preamble.
```

### Prompt for handwritten notes

```
You are extracting data from a handwritten note from Oloolua Hardware Stores in Kenya. These are item lists for goods to be collected. They are usually stamped with the Oloolua Hardware Stores rubber stamp.

Return a JSON object with this exact structure:
{
  "receipt_type": "handwritten",
  "customer_name": "name at top of note, or null",
  "date": "DD/MM/YY format from the stamp or written date, or null",
  "salesperson": "signature name if legible, or null",
  "items": [
    {"qty": number, "unit": "pcs|rolls|kg|pc|null", "description": "as written"}
  ],
  "confidence": {
    "customer_name": "high" | "medium" | "low",
    "items": "high" | "medium" | "low"
  }
}

Hardware-specific shorthand to recognize:
- H/G = Heavy Gauge, M/G = Medium Gauge, L/G = Light Gauge (for wire mesh)
- D-8, D-12, D-16, D-20, D-25 = reinforcement bars by diameter in mm
- G30, G28, G32 = sheet metal gauge for ridges
- 1¼, 1½, ¾, ⅜ — fractions are inch measurements for steel sections
- "fluat" usually means "flat bar"
- 2", 4", 6" — inch measurements for pipes
- "chainlink" and "chain link" are the same product
- Quantities can be: pcs, rolls, kg, pc, length

Rules:
- Each line is usually one item: [qty][unit] [description]
- Items often wrap to a second line — combine wrapped lines into one item.
- If a fraction is written as "11/4", interpret as 1¼.
- Return ONLY the JSON object, no preamble.
```

## Apps Script endpoints needed

The PWA calls Apps Script via doPost. Endpoints:

1. `saveScan` — Receives confirmed scan data + Drive image link, writes to today's tab. Auto-creates the tab if it doesn't exist. Updates Products tab. Checks for duplicate Trnx Ref.

2. `getProductSuggestions` — Receives a fuzzy query string, returns top 5 matching canonical products from Products tab + Aliases.

3. `addAlias` — Adds a new alias mapping when employee confirms a non-matching item is actually an existing product.

4. `getDailySummary` — Returns today's stats for the dashboard view.

5. `getMonthSummary` — Returns this month's stats.

6. `findByTrnxRef` — Checks if a Trnx Ref already exists (duplicate scan detection).

## PWA features (priority order)

### Phase 1 — MVP (week 1-2)
- Login (simple staff selector — no passwords for MVP, just pick your name)
- Scan Receipt button → camera → preview → confirm form → save
- Scan Note button → camera → preview → confirm form → save
- Today's list view (recent scans, status)
- Pending collections count badge

### Phase 2 — Operational features (week 3)
- Search/filter today's scans
- Mark as collected/pending
- Edit a previous scan (within same day)
- Daily reconciliation view (totals)

### Phase 3 — Owner dashboard (week 4)
- Salesperson leaderboard
- Top customers
- Product velocity
- Time-of-day patterns
- Pending collections aging report

## Build sequence for Claude Code

1. **Set up the Sheets backend first.** Create the workbook template, write the Apps Script with all endpoints, deploy as web app, test with curl/Postman.

2. **Build a CLI prototype to test the OCR.** Node.js script that takes an image path, calls Claude API with the right prompt, returns JSON. Use the 5 sample images in `samples/` to validate.

3. **Build the PWA.** React + Vite is fine. Camera capture via `getUserMedia` or a file input with `capture="environment"`. Calls the Apps Script web app for saves.

4. **Deploy the PWA.** Cloudflare Pages is free and Joel already uses Cloudflare. Custom domain: `stores.essenceautomations.com` or similar.

## Constraints and notes

- **No POS integration.** Owner has decided to scan receipts directly, not pull from POS database.
- **Offline tolerance is nice-to-have, not required for MVP.** Shop has decent connectivity.
- **The system must handle the alias-learning workflow gracefully** — when an unknown item is scanned, the employee should be able to either tag it as a new canonical product OR map it as an alias of an existing one. This is critical for keeping the Products tab clean.
- **Image storage** — every scan saves the original image to Drive in `Oloolua Collections/{Year}/{Month}/{Day}/{trnx_ref or timestamp}.jpg`.
- **Confidence-driven UI** — fields with "low" confidence from the OCR should be visually highlighted on the confirmation screen so the employee pays extra attention.

## Out of scope (for now)

- Customer-facing notifications (SMS receipts, "ready for collection" alerts) — would route through GHL later
- Inventory/stock tracking (just transaction log for now)
- Multi-shop support (single location)
- Price history / cost analysis

## Success criteria

- Stores employee can process a scan in under 30 seconds (vs. 3-5 minutes manual copying)
- 95%+ of scans require zero or minor correction
- Owner can see at a glance: today's sales, pending collections, top salesperson, top customer
- Zero lost transactions vs. counter book
