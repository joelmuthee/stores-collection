export const PRINTED_RECEIPT_PROMPT = `You are extracting data from a printed receipt issued by Oloolua Hardware Stores in Kenya. The POS is Urovo. Receipts may be labelled "ORIGINAL" or "DUPLICATE" at the top.

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
  "payment_method": "Cash" | "Mpesa" | "Bank" | "other",
  "confidence": {
    "trnx_ref": "high" | "medium" | "low",
    "total": "high" | "medium" | "low",
    "items": "high" | "medium" | "low"
  }
}

Rules:
- Read decimal numbers carefully — Urovo prints "530.0" meaning 530.
- "KE" in the receipt means KSh (Kenyan Shilling). Strip it from numbers.
- Time is HH:MM in 24-hour format. If the minutes value reads greater than 59, you have misread a digit — look again.
- If a field is unreadable, set it to null and lower its confidence score.
- Return ONLY the JSON object, no preamble or explanation.`;

export const HANDWRITTEN_NOTE_PROMPT = `You are extracting data from a handwritten note from Oloolua Hardware Stores in Kenya. These are item lists for goods to be collected from the stores. They are usually stamped with the Oloolua Hardware Stores rubber stamp.

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
- Chainlink rolls are measured in feet — typical sizes are 4ft, 5ft, 6ft, 8ft. A single digit before "ft" is the full height measurement, not tens of feet (e.g., "5rolls chainlink 5ft" means five-foot-high rolls, not fifty-foot).
- Quantities can be: pcs, rolls, kg, pc, length

Rules:
- Each line is usually one item: [qty][unit] [description]
- Items often wrap to a second line — combine wrapped lines into one item.
- If a fraction is written as "11/4", interpret as 1¼.
- Return ONLY the JSON object, no preamble or explanation.`;
