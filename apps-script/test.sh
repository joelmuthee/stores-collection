#!/bin/bash
# Test the deployed Apps Script endpoints
# Usage: WEB_APP_URL=https://script.google.com/macros/s/YOUR_ID/exec bash apps-script/test.sh

URL="${WEB_APP_URL:-https://script.google.com/macros/s/YOUR_ID/exec}"

echo "Testing: $URL"
echo ""

echo "--- Health check ---"
curl -sL "$URL" | python3 -m json.tool

echo ""
echo "--- getDailySummary ---"
curl -sL "$URL?action=getDailySummary" | python3 -m json.tool

echo ""
echo "--- getStaff ---"
curl -sL "$URL?action=getStaff" | python3 -m json.tool

echo ""
echo "--- getProductSuggestions: 'wire mesh' ---"
curl -sL -X POST "$URL" \
  -H "Content-Type: application/json" \
  -d '{"action":"getProductSuggestions","query":"wire mesh"}' | python3 -m json.tool

echo ""
echo "--- findByTrnxRef (non-existent) ---"
curl -sL -X POST "$URL" \
  -H "Content-Type: application/json" \
  -d '{"action":"findByTrnxRef","trnx_ref":"TEST-001"}' | python3 -m json.tool

echo ""
echo "--- saveScan (printed receipt) ---"
curl -sL -X POST "$URL" \
  -H "Content-Type: application/json" \
  -d '{
    "action": "saveScan",
    "stores_employee": "Employee",
    "status": "Collected",
    "drive_image_link": "https://drive.google.com/test",
    "scan": {
      "receipt_type": "printed",
      "document_label": "DUPLICATE",
      "manual_marking": "816",
      "trnx_ref": "TEST-001",
      "salesperson": "MAURINE",
      "date": "29-04-2026",
      "time": "10:05",
      "items": [{"line":1,"description":"1x1x18g","qty":1,"unit_price":530,"amount":530}],
      "total": 530,
      "status": "paid",
      "payment_method": "Cash",
      "confidence": {"trnx_ref":"medium","total":"high","items":"medium"}
    }
  }' | python3 -m json.tool

echo ""
echo "--- saveScan duplicate check ---"
curl -sL -X POST "$URL" \
  -H "Content-Type: application/json" \
  -d '{"action":"saveScan","stores_employee":"Employee","scan":{"receipt_type":"printed","trnx_ref":"TEST-001","items":[]}}' | python3 -m json.tool

echo ""
echo "--- addAlias ---"
curl -sL -X POST "$URL" \
  -H "Content-Type: application/json" \
  -d '{"action":"addAlias","alias":"52pcs wiremesh","canonical":"Wire Mesh H/G","notes":"Test alias"}' | python3 -m json.tool

echo ""
echo "Done."
