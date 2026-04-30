// ============================================================
// Oloolua Hardware Stores — Collection System Backend
// Google Apps Script — standalone project
// ============================================================
// Deploy: Deploy → New deployment
//   Type: Web app
//   Execute as: Me
//   Who has access: Anyone
// ============================================================

// Spreadsheet ID — update if you recreate the sheet
const SPREADSHEET_ID = '1b0YP4BfiPYAtN-zH6VkLWE0Uo-eI-MGQFSNad1JYFhg';

function getSheet() {
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

// Run setupSheet() ONCE after creating the spreadsheet to
// initialise all permanent tabs and seed the staff list.

// ============================================================
// COLUMN DEFINITIONS
// ============================================================

const DAILY_HEADERS = [
  'Timestamp', 'Receipt Type', 'Trnx Ref',
  'Manual Marking', 'Customer Name', 'Salesperson', 'Stores Employee',
  'Sale Date', 'Sale Time', 'Collection Time', 'Time Gap (mins)',
  'Item Count', 'Item Summary', 'Total Amount',
  'Status', 'Drive Image Link', 'Notes', 'Flag',
];

const PRODUCTS_HEADERS = [
  'Canonical Name', 'Category', 'First Seen', 'Times Sold',
  'Last Sold', 'Typical Price', 'Common Unit', 'Active',
];

const ALIASES_HEADERS = ['Alias', 'Canonical Name', 'Notes'];

const CUSTOMERS_HEADERS = ['Customer Name', 'First Seen', 'Last Seen', 'Times Seen'];

const STAFF_HEADERS = ['Name', 'Role', 'Active'];

// ============================================================
// ENTRY POINTS
// ============================================================

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    const action = payload.action;
    let result;

    switch (action) {
      case 'ocr':                result = runOcr(payload);                 break;
      case 'saveScan':           result = saveScan(payload);               break;
      case 'uploadImage':        result = uploadImage(payload);            break;
      case 'getProductSuggestions': result = getProductSuggestions(payload); break;
      case 'addAlias':           result = addAlias(payload);               break;
      case 'getDailySummary':    result = getDailySummary(payload);        break;
      case 'getMonthSummary':    result = getMonthSummary(payload);        break;
      case 'findByTrnxRef':      result = findByTrnxRef(payload);          break;
      case 'getStaff':           result = getStaff();                      break;
      case 'getPendingCollections': result = getPendingCollections();      break;
      case 'markCollected':      result = markCollected(payload);          break;
      default:
        result = { ok: false, error: 'Unknown action: ' + action };
    }

    return jsonResponse(result);
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message, stack: err.stack });
  }
}

// doGet for quick health-check / testing from browser
function doGet(e) {
  const action = e.parameter.action;
  if (action === 'getDailySummary')  return jsonResponse(getDailySummary(e.parameter));
  if (action === 'getMonthSummary')  return jsonResponse(getMonthSummary(e.parameter));
  if (action === 'getStaff')         return jsonResponse(getStaff());
  if (action === 'getPendingCollections') return jsonResponse(getPendingCollections());
  if (action === 'addStaff') {
    addStaffIfMissing(e.parameter.name, e.parameter.role || 'Salesperson');
    return jsonResponse({ ok: true, added: e.parameter.name });
  }
  return jsonResponse({ ok: true, message: 'Oloolua Collection System is running.' });
}

// ============================================================
// runOcr — calls Claude Vision API via UrlFetchApp
// ============================================================
// Payload: { image: base64string, mediaType: 'image/jpeg'|'image/png', type: 'printed'|'handwritten' }
// Returns: { ok: true, scan: { ...extracted fields } }

const PRINTED_PROMPT = `You are extracting data from a printed receipt issued by Oloolua Hardware Stores in Kenya. The POS is Urovo. Receipts may be labelled "ORIGINAL" or "DUPLICATE" at the top.

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

const HANDWRITTEN_PROMPT = `You are extracting data from a handwritten note from Oloolua Hardware Stores in Kenya. These are item lists for goods to be collected from the stores. They are usually stamped with the Oloolua Hardware Stores rubber stamp.

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
- Chainlink rolls are measured in feet — typical sizes are 4ft, 5ft, 6ft, 8ft. A single digit before "ft" is the full height measurement, not tens of feet.
- Quantities can be: pcs, rolls, kg, pc, length

Rules:
- Each line is usually one item: [qty][unit] [description]
- Items often wrap to a second line — combine wrapped lines into one item.
- If a fraction is written as "11/4", interpret as 1¼.
- Notes may be in MULTIPLE COLUMNS. Read the LEFT column top-to-bottom completely, then the RIGHT column top-to-bottom. Do not interleave.
- Items at the very top edge of the page (e.g. handwritten in margins or above the printed border) MUST be captured.
- A red tick or strikethrough mark drawn over the items is a customer signature/marking — IGNORE it, do not let it cause you to skip items.
- Before returning, COUNT every item line you've extracted and verify it matches the number of bullet points or dashes on the original note. If your count is lower, re-scan for missed items, especially in cramped or wrapped lines.
- Return ONLY the JSON object, no preamble or explanation.`;

function runOcr(payload) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) return { ok: false, error: 'ANTHROPIC_API_KEY not set in Script Properties' };

  const prompt = payload.type === 'printed' ? PRINTED_PROMPT : HANDWRITTEN_PROMPT;
  const mediaType = payload.mediaType || 'image/jpeg';

  const body = {
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: payload.image } },
        { type: 'text', text: prompt }
      ]
    }]
  };

  const response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });

  if (response.getResponseCode() !== 200) {
    return { ok: false, error: 'Claude API error: ' + response.getContentText() };
  }

  const raw = JSON.parse(response.getContentText()).content[0].text.trim();
  const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
  const scan = JSON.parse(cleaned);

  // Save image to Drive in the same call so the PWA doesn't have to upload it twice.
  let drive_image_link = null;
  try {
    const up = uploadImage({
      image_base64: payload.image,
      mime_type: mediaType,
      trnx_ref: scan.trnx_ref,
      date: scan.date,
    });
    if (up?.ok) drive_image_link = up.drive_link;
  } catch (_) { /* non-fatal */ }

  // Sanitise impossible time values
  if (scan.time) {
    const parts = scan.time.split(':').map(Number);
    if (isNaN(parts[0]) || isNaN(parts[1]) || parts[0] > 23 || parts[1] > 59) {
      scan.time = null;
      scan.confidence = { ...scan.confidence, time: 'low' };
    }
  }

  const ss = getSheet();

  // For handwritten notes, snap salesperson to the closest known staff name
  if (payload.type === 'handwritten' && scan.salesperson) {
    const matched = fuzzyMatchStaff(scan.salesperson, ss);
    if (matched) scan.salesperson = matched;
  }

  // If customer_name is actually a staff member, move it to salesperson
  if (scan.customer_name) {
    const staffMatch = fuzzyMatchStaff(scan.customer_name, ss);
    if (staffMatch) {
      if (!scan.salesperson) scan.salesperson = staffMatch;
      scan.customer_name = null;
    }
  }

  return { ok: true, scan, drive_image_link };
}

// ============================================================
// saveScan
// ============================================================
// Payload:
//   scan: { receipt_type, document_label, manual_marking, trnx_ref,
//           salesperson, customer_name, date, time, items, total,
//           status, payment_method, confidence }
//   stores_employee: string
//   drive_image_link: string (optional — fill after uploadImage)
//   notes: string (optional)

function saveScan(payload) {
  const ss = getSheet();
  const scan = payload.scan;
  const now = new Date();

  // Duplicate check for printed receipts (skip if force=true, e.g. partial pickup)
  if (scan.trnx_ref && !payload.force) {
    const dupe = checkDuplicateTrnxRef(ss, scan.trnx_ref);
    if (dupe) {
      return {
        ok: false,
        duplicate: true,
        error: 'Duplicate Trnx Ref: ' + scan.trnx_ref,
        existing_row: dupe,
      };
    }
  }

  // Duplicate check for Pending handwritten notes (same customer in last 24h)
  if (payload.status === 'Pending' && scan.customer_name && !payload.force) {
    const dupe = checkDuplicatePendingByCustomer(ss, scan.customer_name, now);
    if (dupe) {
      return {
        ok: false,
        duplicate: true,
        error: 'Already authorized for ' + scan.customer_name + ' ' + dupe.minutesAgo + ' min ago',
        existing_row: { sheet: dupe.sheetName, row: dupe.rowNum },
      };
    }
  }

  // Compute pickup number for partial pickups
  let statusValue = payload.status || 'Collected';
  if (payload.status === 'Partial' && scan.trnx_ref) {
    const pickupNum = countTrnxRefOccurrences(ss, scan.trnx_ref) + 1;
    statusValue = 'Partial #' + pickupNum;
  }
  const isPending = statusValue === 'Pending';

  const dailyTab = getOrCreateMonthTab(ss, now);
  const saleDate = scan.date || null;
  const saleTime = scan.time || null;

  // Time gap in minutes
  let timeGap = null;
  if (saleDate && saleTime) {
    try {
      const [d, m, y] = saleDate.split('-').map(Number);
      const [h, min] = saleTime.split(':').map(Number);
      const saleDateTime = new Date(y, m - 1, d, h, min);
      timeGap = Math.round((now - saleDateTime) / 60000);
      if (timeGap < 0 || timeGap > 43200) timeGap = null; // sanity: ignore if >30 days or negative
    } catch (_) { /* leave null */ }
  }

  const items = scan.items || [];
  const itemSummary = buildItemSummary(items, scan.receipt_type);

  // Build flags
  const flags = [];
  if (scan.confidence) {
    if (scan.confidence.trnx_ref === 'low')  flags.push('Low OCR Confidence (trnx_ref)');
    if (scan.confidence.items === 'low')     flags.push('Low OCR Confidence (items)');
    if (scan.confidence.total === 'low')     flags.push('Low OCR Confidence (total)');
  }

  const row = [
    now.toISOString(),                          // A: Timestamp
    scan.receipt_type || '',                    // B: Receipt Type
    scan.trnx_ref || '',                        // C: Trnx Ref
    scan.manual_marking || '',                  // D: Manual Marking
    scan.customer_name || '',                   // E: Customer Name
    scan.salesperson || '',                     // F: Salesperson
    isPending ? '' : (payload.stores_employee || ''),  // G: Stores Employee
    saleDate || '',                             // H: Sale Date
    saleTime || '',                             // I: Sale Time
    isPending ? '' : now.toISOString(),         // J: Collection Time
    isPending ? '' : (timeGap !== null ? timeGap : ''), // K: Time Gap (mins)
    items.length,                               // L: Item Count
    itemSummary,                                // M: Item Summary
    scan.total !== undefined ? scan.total : '', // N: Total Amount
    statusValue,                                 // O: Status
    payload.drive_image_link || '',             // P: Drive Image Link
    payload.notes || '',                        // Q: Notes
    flags.join('; '),                           // R: Flag
  ];

  dailyTab.appendRow(row);
  const savedRow = dailyTab.getLastRow();
  const sheetUrl = ss.getUrl() + '#gid=' + dailyTab.getSheetId() + '&range=A' + savedRow;

  // Update Products catalog
  updateProductsCatalog(ss, items, saleDate || Utilities.formatDate(now, Session.getScriptTimeZone(), 'dd-MM-yyyy'));

  // Update Customers tab for handwritten notes
  if (scan.customer_name) {
    updateCustomers(ss, scan.customer_name, now);
  }

  if (statusValue === 'Pending') invalidatePendingCache();

  return { ok: true, saved: true, flags, sheetUrl, sheetName: dailyTab.getName() };
}

// ============================================================
// uploadImage
// ============================================================
// Payload:
//   image_base64: string (base64 encoded image)
//   mime_type: 'image/jpeg' | 'image/png'
//   date: 'DD-MM-YYYY' (for folder path)
//   trnx_ref: string (for filename, optional)

function uploadImage(payload) {
  const base64Data = payload.image_base64;
  const mimeType = payload.mime_type || 'image/jpeg';
  const date = payload.date || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd-MM-yyyy');
  const trnxRef = payload.trnx_ref;

  const [d, m, y] = date.split('-');
  const year = y || new Date().getFullYear();
  const monthName = getMonthName(parseInt(m));
  const dayStr = d + '-' + m + '-' + y;

  // Get or create folder: Oloolua Collections / Year / Month / Day
  const rootFolder = getOrCreateFolder('Oloolua Collections');
  const yearFolder = getOrCreateFolder(String(year), rootFolder);
  const monthFolder = getOrCreateFolder(monthName + ' ' + year, yearFolder);
  const dayFolder = getOrCreateFolder(dayStr, monthFolder);

  const filename = (trnxRef || new Date().getTime()) + (mimeType === 'image/png' ? '.png' : '.jpg');
  const blob = Utilities.newBlob(Utilities.base64Decode(base64Data), mimeType, filename);
  const file = dayFolder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  return {
    ok: true,
    drive_link: 'https://drive.google.com/file/d/' + file.getId() + '/view',
    file_id: file.getId(),
  };
}

// ============================================================
// getProductSuggestions
// ============================================================
// Payload: { query: string }
// Returns top 5 matching canonical products + aliases

function getProductSuggestions(payload) {
  const query = (payload.query || '').toLowerCase().trim();
  if (!query) return { ok: true, suggestions: [] };

  const ss = getSheet();
  const scores = {};

  // Search Products tab
  const productSheet = ss.getSheetByName('Products');
  if (productSheet && productSheet.getLastRow() > 1) {
    const data = productSheet.getRange(2, 1, productSheet.getLastRow() - 1, 2).getValues();
    data.forEach(([name, category]) => {
      if (!name) return;
      const score = fuzzyScore(query, String(name).toLowerCase());
      if (score > 0) {
        scores[name] = { name, category: category || '', score, source: 'product' };
      }
    });
  }

  // Search Aliases tab — promote to canonical name on match
  const aliasSheet = ss.getSheetByName('Aliases');
  if (aliasSheet && aliasSheet.getLastRow() > 1) {
    const data = aliasSheet.getRange(2, 1, aliasSheet.getLastRow() - 1, 2).getValues();
    data.forEach(([alias, canonical]) => {
      if (!alias || !canonical) return;
      const score = fuzzyScore(query, String(alias).toLowerCase());
      if (score > 0 && (!scores[canonical] || scores[canonical].score < score)) {
        scores[canonical] = { name: canonical, alias, score, source: 'alias' };
      }
    });
  }

  const suggestions = Object.values(scores)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  return { ok: true, suggestions };
}

// ============================================================
// addAlias
// ============================================================
// Payload: { alias: string, canonical: string, notes: string }

function addAlias(payload) {
  const { alias, canonical, notes } = payload;
  if (!alias || !canonical) return { ok: false, error: 'alias and canonical are required' };

  const ss = getSheet();
  const sheet = ss.getSheetByName('Aliases');

  // Check if alias already exists
  if (sheet.getLastRow() > 1) {
    const existing = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues().flat();
    if (existing.some(a => String(a).toLowerCase() === alias.toLowerCase())) {
      return { ok: false, error: 'Alias already exists: ' + alias };
    }
  }

  sheet.appendRow([alias, canonical, notes || '']);
  return { ok: true, added: { alias, canonical } };
}

// ============================================================
// getDailySummary
// ============================================================

function getDailySummary(payload) {
  const ss = getSheet();
  const tz = Session.getScriptTimeZone();
  const today = payload && payload.date
    ? payload.date
    : Utilities.formatDate(new Date(), tz, 'dd-MM-yyyy');

  // Find the monthly tab that contains this day
  const [d, m, y] = today.split('-');
  const dateObj = new Date(parseInt(y), parseInt(m) - 1, parseInt(d));
  const monthTabName = Utilities.formatDate(dateObj, tz, 'MMMM yyyy');
  const sheet = ss.getSheetByName(monthTabName);

  if (!sheet || sheet.getLastRow() <= 1) {
    return { ok: true, date: today, total_scans: 0, collected: 0, pending: 0, total_value: 0, salespersons: {}, items_by_category: {} };
  }

  const allData = sheet.getRange(2, 1, sheet.getLastRow() - 1, DAILY_HEADERS.length).getValues();
  // Filter to rows saved on the requested day
  const data = allData.filter(row => {
    if (!row[0]) return false;
    return Utilities.formatDate(new Date(row[0]), tz, 'dd-MM-yyyy') === today;
  });

  if (!data.length) {
    return { ok: true, date: today, total_scans: 0, collected: 0, pending: 0, total_value: 0, salespersons: {}, items_by_category: {} };
  }

  let totalValue = 0;
  let collected = 0;
  let pending = 0;
  const salespersons = {};
  const itemsByCategory = {};

  data.forEach(row => {
    const status = row[14];
    const total = parseFloat(row[13]) || 0;
    const salesperson = row[5];

    totalValue += total;
    if (status === 'Collected') collected++;
    else pending++;

    if (salesperson) salespersons[salesperson] = (salespersons[salesperson] || 0) + 1;
  });

  return {
    ok: true,
    date: today,
    total_scans: data.length,
    collected,
    pending,
    total_value: totalValue,
    salespersons,
    items_by_category: itemsByCategory,
  };
}

// ============================================================
// getMonthSummary
// ============================================================

function getMonthSummary(payload) {
  const ss = getSheet();
  const tz = Session.getScriptTimeZone();
  const now = new Date();
  const targetMonth = (payload && payload.month) ? parseInt(payload.month) : now.getMonth() + 1;
  const targetYear = (payload && payload.year) ? parseInt(payload.year) : now.getFullYear();

  const monthDate = new Date(targetYear, targetMonth - 1, 1);
  const monthTabName = Utilities.formatDate(monthDate, tz, 'MMMM yyyy');
  const sheet = ss.getSheetByName(monthTabName);

  if (!sheet || sheet.getLastRow() <= 1) {
    return { ok: true, month: targetMonth, year: targetYear, total_scans: 0, total_value: 0, collected: 0, pending: 0, salespersons: {}, top_customers: [], daily_breakdown: [] };
  }

  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, DAILY_HEADERS.length).getValues();

  let totalScans = 0;
  let totalValue = 0;
  let collected = 0;
  let pending = 0;
  const salespersons = {};
  const customers = {};
  const dailyMap = {};

  data.forEach(row => {
    if (!row[0]) return;
    const status = row[14];
    const total = parseFloat(row[13]) || 0;
    const sp = row[5];
    const cust = row[4];

    totalScans++;
    totalValue += total;
    if (status === 'Collected') collected++; else pending++;
    if (sp) salespersons[sp] = (salespersons[sp] || 0) + 1;
    if (cust) customers[cust] = (customers[cust] || 0) + 1;

    const dayKey = Utilities.formatDate(new Date(row[0]), tz, 'dd-MM-yyyy');
    if (!dailyMap[dayKey]) dailyMap[dayKey] = { date: dayKey, scans: 0, value: 0 };
    dailyMap[dayKey].scans++;
    dailyMap[dayKey].value += total;
  });

  const dailyBreakdown = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));

  return {
    ok: true,
    month: targetMonth,
    year: targetYear,
    total_scans: totalScans,
    total_value: totalValue,
    collected,
    pending,
    salespersons,
    top_customers: Object.entries(customers).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, count]) => ({ name, count })),
    daily_breakdown: dailyBreakdown,
  };
}

// ============================================================
// getPendingCollections — list all rows with Status === 'Pending'
// ============================================================
// Returns: { ok: true, pending: [{ sheetName, rowNum, timestamp, customer_name,
//            salesperson, item_summary, drive_image_link, sale_date, notes }] }

function getPendingCollections() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('pendingCollections');
  if (cached) return JSON.parse(cached);

  const ss = getSheet();
  const tz = Session.getScriptTimeZone();
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const candidateNames = [
    Utilities.formatDate(now, tz, 'MMMM yyyy'),
    Utilities.formatDate(prev, tz, 'MMMM yyyy'),
  ];

  const pending = [];
  for (const name of candidateNames) {
    const sheet = ss.getSheetByName(name);
    if (!sheet || sheet.getLastRow() <= 1) continue;
    const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, DAILY_HEADERS.length).getValues();
    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      if (row[14] !== 'Pending') continue;
      pending.push({
        sheetName: name,
        rowNum: i + 2,
        timestamp: row[0],
        receipt_type: row[1],
        trnx_ref: row[2],
        customer_name: row[4],
        salesperson: row[5],
        sale_date: row[7],
        item_summary: row[12],
        drive_image_link: row[15],
        notes: row[16],
      });
    }
  }
  pending.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));

  const result = { ok: true, pending };
  cache.put('pendingCollections', JSON.stringify(result), 30); // 30s cache
  return result;
}

// Bust the pending cache when records change
function invalidatePendingCache() {
  CacheService.getScriptCache().remove('pendingCollections');
}

// ============================================================
// markCollected — flip a Pending row to Collected
// ============================================================
// Payload: { sheetName, rowNum, stores_employee }

function markCollected(payload) {
  const { sheetName, rowNum, stores_employee } = payload;
  if (!sheetName || !rowNum) return { ok: false, error: 'sheetName and rowNum required' };
  const ss = getSheet();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return { ok: false, error: 'Sheet not found: ' + sheetName };
  const status = sheet.getRange(rowNum, 15).getValue();
  if (status !== 'Pending') return { ok: false, error: 'Row is not Pending (current status: ' + status + ')' };

  const now = new Date();
  const saleDate = sheet.getRange(rowNum, 8).getValue();
  const saleTime = sheet.getRange(rowNum, 9).getValue();

  // Compute time gap
  let timeGap = '';
  if (saleDate && saleTime) {
    try {
      const dateStr = String(saleDate);
      const [d, m, y] = (dateStr.includes('/') ? dateStr.split('/') : dateStr.split('-')).map(Number);
      const yr = y < 100 ? 2000 + y : y;
      const [h, min] = String(saleTime).split(':').map(Number);
      const saleDT = new Date(yr, m - 1, d, h, min);
      const gap = Math.round((now - saleDT) / 60000);
      if (gap >= 0 && gap <= 43200) timeGap = gap;
    } catch (_) { /* leave blank */ }
  }

  sheet.getRange(rowNum, 7).setValue(stores_employee || '');         // G: Stores Employee
  sheet.getRange(rowNum, 10).setValue(now.toISOString());            // J: Collection Time
  sheet.getRange(rowNum, 11).setValue(timeGap);                      // K: Time Gap
  sheet.getRange(rowNum, 15).setValue('Collected');                  // O: Status

  invalidatePendingCache();
  const sheetUrl = ss.getUrl() + '#gid=' + sheet.getSheetId() + '&range=A' + rowNum;
  return { ok: true, collected: true, sheetUrl, sheetName };
}

// ============================================================
// findByTrnxRef
// ============================================================

function findByTrnxRef(payload) {
  const trnxRef = payload.trnx_ref;
  if (!trnxRef) return { ok: false, error: 'trnx_ref is required' };
  const ss = getSheet();
  const result = checkDuplicateTrnxRef(ss, trnxRef);
  return result
    ? { ok: true, found: true, row: result }
    : { ok: true, found: false };
}

// ============================================================
// getStaff
// ============================================================

function getStaff() {
  const ss = getSheet();
  const sheet = ss.getSheetByName('Staff');
  if (!sheet || sheet.getLastRow() <= 1) return { ok: true, staff: [] };
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues();
  const staff = data
    .filter(r => r[0] && r[2] === true)
    .map(r => ({ name: r[0], role: r[1] }));
  return { ok: true, staff };
}

// ============================================================
// SHEET HELPERS
// ============================================================

function getOrCreateMonthTab(ss, date) {
  const tz = Session.getScriptTimeZone();
  const tabName = Utilities.formatDate(date, tz, 'MMMM yyyy'); // e.g. "April 2025"
  let sheet = ss.getSheetByName(tabName);
  if (!sheet) {
    sheet = ss.insertSheet(tabName);
    const header = sheet.getRange(1, 1, 1, DAILY_HEADERS.length);
    header.setValues([DAILY_HEADERS]);
    header.setFontWeight('bold');
    header.setBackground('#800000');
    header.setFontColor('#FFFFFF');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(14, 300); // Items JSON
    sheet.setColumnWidth(15, 250); // Item Summary
  }
  return sheet;
}

function checkDuplicateTrnxRef(ss, trnxRef) {
  const sheets = ss.getSheets();
  const pattern = /^[A-Za-z]+ \d{4}$/; // matches "April 2025", "May 2025", etc.
  for (const sheet of sheets) {
    if (!pattern.test(sheet.getName())) continue;
    if (sheet.getLastRow() <= 1) continue;
    const refs = sheet.getRange(2, 3, sheet.getLastRow() - 1, 1).getValues().flat();
    const idx = refs.indexOf(trnxRef);
    if (idx >= 0) {
      return { sheet: sheet.getName(), row: idx + 2 };
    }
  }
  return null;
}

// Returns the best-matching staff name for a given raw OCR string, or null if no confident match.
// Uses Levenshtein distance normalised by the longer string — accepts if similarity >= 0.65.
function fuzzyMatchStaff(raw, ss) {
  if (!raw) return null;
  const sheet = ss.getSheetByName('Staff');
  if (!sheet || sheet.getLastRow() <= 1) return null;
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues();
  const names = data.filter(r => r[0] && r[2] === true).map(r => String(r[0]).trim());
  if (!names.length) return null;

  const norm = s => s.toLowerCase().replace(/[^a-z']/g, '');
  const rawNorm = norm(raw);

  function levenshtein(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, (_, i) => [i]);
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++)
      for (let j = 1; j <= n; j++)
        dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1]
          : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    return dp[m][n];
  }

  let bestName = null, bestScore = 0;
  for (const name of names) {
    const nameNorm = norm(name);
    const dist = levenshtein(rawNorm, nameNorm);
    const maxLen = Math.max(rawNorm.length, nameNorm.length) || 1;
    const score = 1 - dist / maxLen;
    if (score > bestScore) { bestScore = score; bestName = name; }
  }
  return bestScore >= 0.65 ? bestName : null;
}

// Find a Pending row for this customer within the last 24h.
// Returns { sheetName, rowNum, minutesAgo } or null.
function checkDuplicatePendingByCustomer(ss, customerName, now) {
  const target = String(customerName).toLowerCase().trim();
  if (!target) return null;
  const cutoffMs = now.getTime() - 24 * 60 * 60 * 1000;
  const sheets = ss.getSheets();
  const pattern = /^[A-Za-z]+ \d{4}$/;
  for (const sheet of sheets) {
    if (!pattern.test(sheet.getName())) continue;
    if (sheet.getLastRow() <= 1) continue;
    const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, DAILY_HEADERS.length).getValues();
    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      if (row[14] !== 'Pending') continue;
      if (String(row[4]).toLowerCase().trim() !== target) continue;
      const ts = new Date(row[0]).getTime();
      if (isNaN(ts) || ts < cutoffMs) continue;
      return {
        sheetName: sheet.getName(),
        rowNum: i + 2,
        minutesAgo: Math.round((now.getTime() - ts) / 60000),
      };
    }
  }
  return null;
}

function countTrnxRefOccurrences(ss, trnxRef) {
  const sheets = ss.getSheets();
  const pattern = /^[A-Za-z]+ \d{4}$/;
  let count = 0;
  for (const sheet of sheets) {
    if (!pattern.test(sheet.getName())) continue;
    if (sheet.getLastRow() <= 1) continue;
    const refs = sheet.getRange(2, 3, sheet.getLastRow() - 1, 1).getValues().flat();
    count += refs.filter(r => r === trnxRef).length;
  }
  return count;
}

function updateProductsCatalog(ss, items, saleDate) {
  const sheet = ss.getSheetByName('Products');
  if (!sheet || !items.length) return;

  const lastRow = sheet.getLastRow();
  const existingData = lastRow > 1
    ? sheet.getRange(2, 1, lastRow - 1, PRODUCTS_HEADERS.length).getValues()
    : [];
  const nameIndex = existingData.reduce((acc, row, i) => {
    if (row[0]) acc[String(row[0]).toLowerCase()] = i;
    return acc;
  }, {});

  items.forEach(item => {
    const name = (item.description || '').trim();
    if (!name) return;
    const key = name.toLowerCase();

    if (nameIndex[key] !== undefined) {
      // Update existing: increment times sold, update last sold, update typical price
      const rowNum = nameIndex[key] + 2;
      const timesSold = parseInt(sheet.getRange(rowNum, 4).getValue()) || 0;
      sheet.getRange(rowNum, 4).setValue(timesSold + 1);
      sheet.getRange(rowNum, 5).setValue(saleDate);
      if (item.unit_price) sheet.getRange(rowNum, 6).setValue(item.unit_price);
    } else {
      // New product
      const category = categoriseItem(name);
      const unit = item.unit || guessUnit(name);
      sheet.appendRow([
        name, category, saleDate, 1, saleDate,
        item.unit_price || '', unit, true,
      ]);
      nameIndex[key] = sheet.getLastRow() - 2;
    }
  });
}

function updateCustomers(ss, customerName, date) {
  const sheet = ss.getSheetByName('Customers');
  if (!sheet) return;
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    const names = sheet.getRange(2, 1, lastRow - 1, 1).getValues().flat().map(n => String(n).toLowerCase());
    const idx = names.indexOf(customerName.toLowerCase());
    if (idx >= 0) {
      const rowNum = idx + 2;
      const count = parseInt(sheet.getRange(rowNum, 4).getValue()) || 0;
      sheet.getRange(rowNum, 3).setValue(Utilities.formatDate(date, Session.getScriptTimeZone(), 'dd-MM-yyyy'));
      sheet.getRange(rowNum, 4).setValue(count + 1);
      return;
    }
  }
  const dateStr = Utilities.formatDate(date, Session.getScriptTimeZone(), 'dd-MM-yyyy');
  sheet.appendRow([customerName, dateStr, dateStr, 1]);
}

function buildItemSummary(items, receiptType) {
  if (!items || !items.length) return '';
  return items.map(item => {
    const qty = item.qty || '';
    const unit = item.unit || (receiptType === 'printed' ? '' : '');
    const desc = item.description || '';
    return [qty, unit, desc].filter(Boolean).join(' ');
  }).join(', ');
}

// ============================================================
// FUZZY MATCHING
// ============================================================

function fuzzyScore(query, target) {
  if (!query || !target) return 0;
  if (target === query) return 100;
  if (target.includes(query)) return 80;
  if (query.includes(target)) return 60;
  // Check how many query words appear in target
  const words = query.split(/\s+/);
  const matched = words.filter(w => w.length > 1 && target.includes(w));
  if (matched.length > 0) return Math.round(40 * matched.length / words.length);
  // Check first 3 chars
  if (query.length >= 3 && target.startsWith(query.substring(0, 3))) return 20;
  return 0;
}

// ============================================================
// CATEGORISATION
// ============================================================

function categoriseItem(description) {
  const d = description.toLowerCase();
  if (/cement|simba|nyumba|bamburi/.test(d))                     return 'Cement';
  if (/grout/.test(d))                                           return 'Cement';
  if (/wire\s*mesh|wiremesh|brc/.test(d))                        return 'Wire products';
  if (/chain\s*link|chainlink/.test(d))                          return 'Wire products';
  if (/binding\s*wire/.test(d))                                  return 'Wire products';
  if (/d-\d+|rebar|reinforcement|deformed/.test(d))             return 'Reinforcement';
  if (/square\s*tube|rhs|angle\s*iron|flat\s*bar|fluat/.test(d)) return 'Steel sections';
  if (/\d+x\d+x\d+|1[¼½]x|1\.5|1x1/.test(d))                  return 'Steel sections';
  if (/ridge|clear\s*sheet|it5|roofing\s*nail/.test(d))         return 'Roofing';
  if (/pvc|pipe|bend|tee|plug|floor\s*trap|metal\s*clip/.test(d)) return 'Plumbing';
  if (/nail/.test(d))                                            return 'Fasteners';
  return 'Other';
}

function guessUnit(description) {
  const d = description.toLowerCase();
  if (/cement|bag/.test(d))                        return 'bags';
  if (/grout|kg/.test(d))                          return 'kg';
  if (/chain\s*link|wire\s*mesh|binding\s*wire/.test(d)) return 'rolls';
  if (/nail/.test(d))                              return 'kg';
  if (/pipe|tube|bar|d-\d+|ridge|sheet|iron/.test(d)) return 'pcs';
  return 'pcs';
}

// ============================================================
// DRIVE HELPERS
// ============================================================

function getOrCreateFolder(name, parent) {
  const source = parent || DriveApp;
  const folders = source.getFoldersByName(name);
  return folders.hasNext() ? folders.next() : source.createFolder(name);
}

function getMonthName(m) {
  return ['January','February','March','April','May','June',
          'July','August','September','October','November','December'][m - 1] || 'Unknown';
}

// ============================================================
// RESPONSE HELPER
// ============================================================

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// STAFF MIGRATIONS — run manually from the editor as needed
// ============================================================

function addStaffIfMissing(name, role) {
  const ss = getSheet();
  const sheet = ss.getSheetByName('Staff');
  if (!sheet) return;
  const data = sheet.getLastRow() > 1
    ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues().flat()
    : [];
  if (data.map(n => String(n).toLowerCase()).includes(name.toLowerCase())) return;
  sheet.appendRow([name, role, true]);
}

function migration_addMuteti() {
  addStaffIfMissing('Muteti', 'Salesperson');
}

function migration_addJoelSalesperson() {
  addStaffIfMissing('Joel', 'Salesperson');
}

// ============================================================
// ONE-TIME SETUP — run this manually once from the editor
// ============================================================

function setupSheet() {
  const ss = getSheet();

  function makeTab(name, headers, color) {
    let sheet = ss.getSheetByName(name);
    if (!sheet) sheet = ss.insertSheet(name);
    else sheet.clearContents();
    const headerRange = sheet.getRange(1, 1, 1, headers.length);
    headerRange.setValues([headers]);
    headerRange.setFontWeight('bold');
    headerRange.setBackground(color || '#800000');
    headerRange.setFontColor('#FFFFFF');
    sheet.setFrozenRows(1);
    return sheet;
  }

  makeTab('Products',  PRODUCTS_HEADERS,  '#800000');
  makeTab('Aliases',   ALIASES_HEADERS,   '#4B0000');
  makeTab('Customers', CUSTOMERS_HEADERS, '#4B0000');
  makeTab('Staff',     STAFF_HEADERS,     '#4B0000');

  // Seed Staff tab
  const staffSheet = ss.getSheetByName('Staff');
  staffSheet.getRange(2, 1, 6, 3).setValues([
    ['Maurine',  'Salesperson', true],
    ['Irene',    'Salesperson', true],
    ['Eunice',   'Salesperson', true],
    ["King'ori", 'Salesperson', true],
    ['Muteti',   'Salesperson', true],
    ['Joel',     'Salesperson', true],
    ['Employee', 'Stores',      true],
    ['Owner',    'Owner',       true],
  ]);

  // Seed Products tab with known catalog
  const productsSheet = ss.getSheetByName('Products');
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd-MM-yyyy');
  const seedProducts = [
    ['Cement Nyumba',          'Cement',        today, 0, '', 820,  'bags', true],
    ['Cement Simba',           'Cement',        today, 0, '', 820,  'bags', true],
    ['Grout Grey 1kg',         'Cement',        today, 0, '', 100,  'kg',   true],
    ['Wire Mesh H/G',          'Wire products', today, 0, '', '',   'rolls',true],
    ['Wire Mesh M/G',          'Wire products', today, 0, '', '',   'rolls',true],
    ['Wire Mesh L/G',          'Wire products', today, 0, '', '',   'rolls',true],
    ['Chain Link 5ft',         'Wire products', today, 0, '', '',   'rolls',true],
    ['Chain Link 6ft',         'Wire products', today, 0, '', '',   'rolls',true],
    ['Binding Wire',           'Wire products', today, 0, '', '',   'rolls',true],
    ['BRC',                    'Wire products', today, 0, '', '',   'pcs',  true],
    ['D-8 Rebar',              'Reinforcement', today, 0, '', '',   'pcs',  true],
    ['D-10 Rebar',             'Reinforcement', today, 0, '', '',   'pcs',  true],
    ['D-12 Rebar',             'Reinforcement', today, 0, '', '',   'pcs',  true],
    ['D-16 Rebar',             'Reinforcement', today, 0, '', '',   'pcs',  true],
    ['D-20 Rebar',             'Reinforcement', today, 0, '', '',   'pcs',  true],
    ['D-25 Rebar',             'Reinforcement', today, 0, '', '',   'pcs',  true],
    ['25x25x1.2mm Square Tube','Steel sections',today, 0, '', '',   'pcs',  true],
    ['40x40x1.5mm Square Tube','Steel sections',today, 0, '', '',   'pcs',  true],
    ['50x50x1.5mm Square Tube','Steel sections',today, 0, '', '',   'pcs',  true],
    ['Flat Bar',               'Steel sections',today, 0, '', '',   'pcs',  true],
    ['Angle Iron',             'Steel sections',today, 0, '', '',   'pcs',  true],
    ['Clear Sheet 2.5m',       'Roofing',       today, 0, '', '',   'pcs',  true],
    ['Clear Sheet 3m',         'Roofing',       today, 0, '', '',   'pcs',  true],
    ['IT5 Sheet',              'Roofing',       today, 0, '', '',   'pcs',  true],
    ['Ridge G28',              'Roofing',       today, 0, '', '',   'pcs',  true],
    ['Ridge G30',              'Roofing',       today, 0, '', '',   'pcs',  true],
    ['Ridge G32',              'Roofing',       today, 0, '', '',   'pcs',  true],
    ['Roofing Nails',          'Roofing',       today, 0, '', '',   'kg',   true],
    ['PVC Pipe 2"',            'Plumbing',      today, 0, '', '',   'pcs',  true],
    ['PVC Pipe 4"',            'Plumbing',      today, 0, '', '',   'pcs',  true],
    ['PVC Pipe 6"',            'Plumbing',      today, 0, '', '',   'pcs',  true],
    ['PVC Bend 2"',            'Plumbing',      today, 0, '', '',   'pcs',  true],
    ['PVC Tee 2"',             'Plumbing',      today, 0, '', '',   'pcs',  true],
    ['PVC Plug 2"',            'Plumbing',      today, 0, '', '',   'pcs',  true],
    ['Floor Trap 1 Way',       'Plumbing',      today, 0, '', '',   'pcs',  true],
    ['Metal Clips 2"',         'Plumbing',      today, 0, '', '',   'pcs',  true],
    ['Nails 4"',               'Fasteners',     today, 0, '', '',   'kg',   true],
    ['Nails 6"',               'Fasteners',     today, 0, '', '',   'kg',   true],
  ];
  productsSheet.getRange(2, 1, seedProducts.length, 8).setValues(seedProducts);

  // Seed Aliases tab with known shorthands
  const aliasSheet = ss.getSheetByName('Aliases');
  const seedAliases = [
    ['1x1x18g',                '25x25x1.2mm Square Tube', 'Imperial gauge notation'],
    ['1¼x1¼x16g',             '40x40x1.5mm Square Tube', 'Imperial gauge notation'],
    ['1½x1½x16g',             '50x50x1.5mm Square Tube', 'Imperial gauge notation'],
    ['wiremesh H/G',           'Wire Mesh H/G',           'Shorthand'],
    ['wiremesh HG',            'Wire Mesh H/G',           'No slash'],
    ['wiremesh M/G',           'Wire Mesh M/G',           'Shorthand'],
    ['wiremesh L/G',           'Wire Mesh L/G',           'Shorthand'],
    ['chainlink 5ft',          'Chain Link 5ft',          'Lowercase'],
    ['chainlink 6ft',          'Chain Link 6ft',          'Lowercase'],
    ['chain link 5ft',         'Chain Link 5ft',          'Two words'],
    ['chain link 6ft',         'Chain Link 6ft',          'Two words'],
    ['fluat',                  'Flat Bar',                'Mispronunciation'],
    ['flat bar',               'Flat Bar',                'Lowercase'],
    ['grout grey 1kg',         'Grout Grey 1kg',          'From POS'],
    ['cement nyumba',          'Cement Nyumba',           'Lowercase'],
  ];
  aliasSheet.getRange(2, 1, seedAliases.length, 3).setValues(seedAliases);

  SpreadsheetApp.flush();
  Logger.log('Setup complete. Tabs created: Products, Aliases, Customers, Staff.');
}

// ============================================================
// addChumaProducts — run ONCE to add Chuma category products
// ============================================================

function addChumaProducts() {
  const ss = getSheet();
  const sheet = ss.getSheetByName('Products');
  if (!sheet) { Logger.log('Products tab not found. Run setupSheet() first.'); return; }

  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd-MM-yyyy');

  // Get existing product names to avoid duplicates
  const lastRow = sheet.getLastRow();
  const existing = lastRow > 1
    ? sheet.getRange(2, 1, lastRow - 1, 1).getValues().flat().map(n => String(n).toLowerCase().trim())
    : [];

  const chuma = [
    // Square / rectangular tubes
    ['1-1/2x1-1/2x16g',           'pcs'],
    ['3x2x3mm',                   'pcs'],
    ['4x4x3mm',                   'pcs'],
    ['1-1/4x1-1/4x16g',           'pcs'],
    ['3/4x3/4x16g tube',          'pcs'],
    ['1/2x1/2x18g',               'pcs'],
    ['3x2x16g',                   'pcs'],
    ['5/8x5/8x16g',               'pcs'],
    ['2-1/2x1-1/2x16g',           'pcs'],
    ['4x2x14g',                   'pcs'],
    ['8x4x18g',                   'pcs'],
    ['2x1x2mm 14g',               'pcs'],
    ['8x4x2mm 14g',               'pcs'],
    ['3/4x3/4x18g',               'pcs'],
    ['2x1x18g',                   'pcs'],
    ['3x3x14g',                   'pcs'],
    ['2x2x16g',                   'pcs'],
    ['1-1/2x1-1/2x18g',           'pcs'],
    ['2x2x18g 1mm',               'pcs'],
    ['Black Sheet 8x4x18g',       'pcs'],
    ['4x4x14g',                   'pcs'],
    ['1x1x16g',                   'pcs'],
    ['2x1x16g',                   'pcs'],
    ['5/8x5/8x18g',               'pcs'],
    ['1-1/2x1x18g',               'pcs'],
    ['1-1/2x1x16g',               'pcs'],
    // Round pipe / tube
    ['Round Pipe 5/8x18g',        'pcs'],
    ['Round Pipe 3"',             'pcs'],
    ['Round Pipe 2x18g',          'pcs'],
    ['Round Pipe 1-1/2x16g',      'pcs'],
    ['Round Pipe 1-1/4x16g',      'pcs'],
    ['Round Pipe 1x16g',          'pcs'],
    ['Round Pipe 2x16g',          'pcs'],
    ['Round Pipe 3/4x16g',        'pcs'],
    ['Round Pipe 1-1/2x18g',      'pcs'],
    ['Round Pipe 1x18g',          'pcs'],
    ['Round Pipe 2-1/2x16g',      'pcs'],
    ['Round Pipe 3/4x18g',        'pcs'],
    ['Round Pipe 1-1/4x18g',      'pcs'],
    ['Round Pipe Furniture 3" 18g','pcs'],
    // Black pipe tubes
    ['Black Pipe Tube 1/2"',      'pcs'],
    ['Black Pipe Tube 3/4"',      'pcs'],
    ['Black Pipe Tube 1"',        'pcs'],
    ['Black Pipe Tube 1-1/4"',    'pcs'],
    ['Black Pipe Tube 1-1/2"',    'pcs'],
    ['Black Pipe Tube 2"',        'pcs'],
    ['Black Pipe Tube 2-1/2"',    'pcs'],
    ['Black Pipe Tube 3"',        'pcs'],
    ['Black Pipe Tube 4"',        'pcs'],
    ['3" 14g',                    'pcs'],
    // Flat bar
    ['Flat 3/4x1/4',              'pcs'],
    ['Flat 2x1/4',                'pcs'],
    ['Flat 3x1/4',                'pcs'],
    ['Flat 4x1/4',                'pcs'],
    ['Flat 1-1/2x1/4',            'pcs'],
    ['Flat 2x1/8',                'pcs'],
    ['Flat 3/4x1/8',              'pcs'],
    ['Flat 1x1/8',                'pcs'],
    ['Flat 1x1/4',                'pcs'],
    ['Flat 1-1/2x1/8',            'pcs'],
    // Angle line
    ['Angle Line 2x1/8',          'pcs'],
    ['Angle Line 1x1/8',          'pcs'],
    ['Angle Line 1-1/2x3/16',     'pcs'],
    ['Angle Line 2x1/4',          'pcs'],
    ['Angle Line 1-1/2x1/4',      'pcs'],
    ['Angle Line 3/4x1/8',        'pcs'],
    ['Angle Line 1-1/2x1/8',      'pcs'],
    // Zed
    ['Zed 3/4',                   'pcs'],
    ['Zed STD 3/4',               'pcs'],
    ['Zed 3/4 Sub',               'pcs'],
    ['Zed 3/4 Standard',          'pcs'],
    ['Zed 1"',                    'pcs'],
    // Sheets & plates
    ['Chequered Plate 8x4x1.0mm', 'pcs'],
    ['Teardrop 8x4x1.6mm',        'pcs'],
    ['Teardrop 8x4x16g Embossed', 'pcs'],
    ['Chaker Plate',              'pcs'],
    ['P.U Sheet',                 'pcs'],
    ['Perforated Sheet 6x3',      'pcs'],
    ['Decorated Sheet 2x2',       'pcs'],
    ['Black Sheet 7x3x18g',       'pcs'],
    ['Black Sheet 6x3x18g',       'pcs'],
    ['Black Sheet 8x4x16g 1.3mm', 'pcs'],
    // D rebars (additional sizes not in seed)
    ['D-32',                      'pcs'],
    // Round bars
    ['Round 6',                   'pcs'],
    ['Round 8',                   'pcs'],
    ['Round 10',                  'pcs'],
    ['Round 12',                  'pcs'],
    ['Round 16',                  'pcs'],
    ['Round 16 Per Ft',           'pcs'],
    ['16 Hammered',               'pcs'],
    ['12 Hammered',               'pcs'],
    ['Square 10',                 'pcs'],
    ['Square 12',                 'pcs'],
    ['Square 16',                 'pcs'],
    // Chrome / tee / other fittings
    ['Chrome Pipe 1"',            'pcs'],
    ['Chrome Pipe 3/4"',          'pcs'],
    ['Chrome Caps 3/4"',          'pcs'],
    ['Chrome Caps 1"',            'pcs'],
    ['Tee 3/4"',                  'pcs'],
    ['Tee 1"',                    'pcs'],
    ['U Channel',                 'pcs'],
    ['Rivets',                    'pcs'],
    // Curtain rods & hardware
    ['Curtain Rod 1m',            'pcs'],
    ['Curtain Rod 2m',            'pcs'],
    ['Curtain Rod 3m',            'pcs'],
    ['Curtain Rod Brackets',      'pcs'],
    ['Gate Handle Flat Konji',    'pcs'],
    ['Center Stoppers',           'pcs'],
    ['Down Stoppers',             'pcs'],
    // PV profiles
    ['PV Z',                      'pcs'],
    ['PV U',                      'pcs'],
    ['Pv',                        'pcs'],
    // Discs & consumables
    ['Grinding Disc 9"',          'pcs'],
    ['Flap Disc 7"',              'pcs'],
    // Wire & iron
    ['Binding Wire Roll',         'rolls'],
    ['Hoop Iron',                 'kg'],
    ['Sugarcane',                 'pcs'],
    // Rods
    ['Rods AGI',                  'pcs'],
    ['Rods Maruiti',              'pcs'],
  ];

  let added = 0;
  chuma.forEach(([name, unit]) => {
    if (existing.includes(name.toLowerCase().trim())) return; // skip duplicates
    sheet.appendRow([name, 'Chuma', today, 0, '', '', unit, true]);
    existing.push(name.toLowerCase().trim());
    added++;
  });

  SpreadsheetApp.flush();
  Logger.log('Chuma products added: ' + added);
}

// ============================================================
// addTanksProducts — run ONCE to add Tanks category products
// ============================================================

function addTanksProducts() {
  const ss = getSheet();
  const sheet = ss.getSheetByName('Products');
  if (!sheet) { Logger.log('Products tab not found. Run setupSheet() first.'); return; }

  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd-MM-yyyy');

  const lastRow = sheet.getLastRow();
  const existing = lastRow > 1
    ? sheet.getRange(2, 1, lastRow - 1, 1).getValues().flat().map(n => String(n).toLowerCase().trim())
    : [];

  const tanks = [
    'Roto Tank 2500L',
    'Top Tank 2500L',
    'Roto Tank 920L',
    'Top Tank 10000L',
    'Vectus Tank 10000L Short',
    'Top Tank Rectangular 1000L',
    'Top Tank 5000L',
    'Top Tank 3000L',
    'Top Tank 2300L',
    'Top Tank 2000L',
    'Top Tank 1500L',
    'Top Tank Cylindrical 1000L',
    'Top Tank 500L',
    'Lockable Tank 1/4"',
    'Lockable Tank 1/2"',
    'Vectus Square 1000L',
    'Vectus Tank 1500L',
    'Vectus Tank 2000L',
    'Vectus Tank 8000L',
    'Techno Square 1000L',
    'Techno Tank 1500L',
    'Techno Tank 6000L',
    'Techno Tank 8000L',
    'Roto Tank 1000L',
    'Roto Tank 2000L',
    'Roto Tank 6000L',
    'Skyplast Tank 210L',
    'Vectus Square 500L',
    'Vectus Tank 500L',
    'Vectus Tank 1000L Cylindrical',
    'Vectus Tank 2500L',
    'Techno Square 500L',
    'Vectus Tank Loft 500L Double Layer',
    'Vectus Tank Loft 1000L Double Layer',
    'Techno Tank 1000L',
    'Techno Tank 2000L',
    'Techno Tank 3000L',
    'Techno Tank 10000L',
    'Roto Tank 1500L',
    'Roto Tank 2300L',
    'Roto Tank 4000L',
    'Roto Tank 10000L',
    'Vectus Tank 6000L',
    'Techno Tank 2300L',
    'Techno Tank 2500L',
    'Techno Tank 4000L',
    'Techno Tank 5000L',
    'Roto Tank 5000L Short',
    'Vectus Tank 1000L Short',
    'Vectus Tank 2300L',
    'Vectus Tank 3000L',
    'Vectus Tank 4000L',
    'Vectus Tank 5000L',
    'Vectus Tank 10000L',
    'Techno Tank 500L',
    'Roto Tank 3000L',
    'Roto Tank 8000L',
  ];

  let added = 0;
  tanks.forEach(name => {
    if (existing.includes(name.toLowerCase().trim())) return;
    sheet.appendRow([name, 'Tanks', today, 0, '', '', 'pcs', true]);
    existing.push(name.toLowerCase().trim());
    added++;
  });

  SpreadsheetApp.flush();
  Logger.log('Tanks products added: ' + added);
}

// ============================================================
// addWoodenProducts — run ONCE to add Wooden category products
// ============================================================

function addWoodenProducts() {
  const ss = getSheet();
  const sheet = ss.getSheetByName('Products');
  if (!sheet) { Logger.log('Products tab not found. Run setupSheet() first.'); return; }

  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd-MM-yyyy');

  const lastRow = sheet.getLastRow();
  const existing = lastRow > 1
    ? sheet.getRange(2, 1, lastRow - 1, 1).getValues().flat().map(n => String(n).toLowerCase().trim())
    : [];

  const wooden = [
    'Particle Board Stone Grey',
    'MDF Board Stone Grey',
    'MDF Plain TZ',
    'MDF Screw 1"',
    'Ceiling Board',
    'Lam MDF Cherry 2 Side',
    'Particle Board 18mm',
    'MDF Ply 3mm',
    'Gypsum Board Blue Swan',
    'American Walnut Particle Board',
    'American Walnut MDF Board',
    'Lipping Stoney Grey',
    'Panel Door',
    'Soft Board',
    'MDF Ply White',
    'MDF Light Grey',
    'Blockboard',
    'Particle Chipboard Coimbra',
    'T.N.G Ceiling Light',
    'Cornice Plain',
    'PVC Ceiling 020',
    'MDF Boards Salza',
    '6 Ply 6mm Plywood',
    'Gypsum Board',
    'PVC Ceiling 027',
    'Particle Chipboard Dark Grey',
    'Malpha Hinge Non Hydraulic',
    'MDF Boards Black Cherry',
    'MDF Boards Salza',
    'MDF Boards Beech',
    'Particle Chipboard Cherry',
    'Particle Chipboard Salza',
    'Particle Chipboard White',
    'Marine Board',
    'Door Handles Gold',
    'Doors Panel',
    'Chip Board Cherry',
    'Particle Chipboard Beech',
    'Plywood 6mm',
    'MDF Boards White',
    'MDF Boards Flower',
    'Doors Flush',
    'PVC Corners',
    'PVC H/G',
    'Cornices 4 W01"',
    'Dark Walnut',
    'Chip Board Flower',
    'Blockboard 3/4 18mm',
    'Plywood 3mm',
    'PVC Ceiling',
    'Channels',
    'MDF Boards Cherry',
    'MDF Boards Coimbra',
    'MDF Boards Particle',
    'MDF Board Plain',
    'Doors Button',
    'Chip Board Plain',
  ];

  let added = 0;
  wooden.forEach(name => {
    if (existing.includes(name.toLowerCase().trim())) return;
    sheet.appendRow([name, 'Wooden', today, 0, '', '', 'pcs', true]);
    existing.push(name.toLowerCase().trim());
    added++;
  });

  SpreadsheetApp.flush();
  Logger.log('Wooden products added: ' + added);
}

// ============================================================
// addWiresProducts — run ONCE to add Wires category products
// ============================================================

function addWiresProducts() {
  const ss = getSheet();
  const sheet = ss.getSheetByName('Products');
  if (!sheet) { Logger.log('Products tab not found. Run setupSheet() first.'); return; }

  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd-MM-yyyy');

  const lastRow = sheet.getLastRow();
  const existing = lastRow > 1
    ? sheet.getRange(2, 1, lastRow - 1, 1).getValues().flat().map(n => String(n).toLowerCase().trim())
    : [];

  const wires = [
    ['Green Razor Wire',                  'rolls'],
    ['Chicken Wire 3/4"',                 'rolls'],
    ['Chicken Wire 1/2"',                 'rolls'],
    ['Chicken Wire 1"',                   'rolls'],
    ['Nail Bag 5"',                       'bags'],
    ['Green Gauze Wire',                  'rolls'],
    ['Chain Link 6ft 14g',                'rolls'],
    ['Nails Bag 2-1/2"',                  'bags'],
    ['Nails Bag 3"',                      'bags'],
    ['Nails Bag 4"',                      'bags'],
    ['Barbed Wire 610m',                  'rolls'],
    ['MTR Abyssinia 480m',                'rolls'],
    ['MTR Abyssinia 610m',                'rolls'],
    ['MTR Zingira 610m',                  'rolls'],
    ['Barbed Wire 610m Blue',             'rolls'],
    ['Plastic Mesh Per Metre',            'rolls'],
    ['Wiremesh M/G',                      'rolls'],
    ['Green Net',                         'rolls'],
    ['BRC A65 Std',                       'pcs'],
    ['Chain Big',                         'pcs'],
    ['Chain Small',                       'pcs'],
    ['Chain 6mm',                         'pcs'],
    ['Crimped Wire Brush',                'pcs'],
    ['Coffee Tray Soldered',              'pcs'],
    ['MTS 610m Farasi',                   'rolls'],
    ['Barbed Wire 480m',                  'rolls'],
    ['Expanded Wire H/G',                 'rolls'],
    ['Expanded Wire L/G',                 'rolls'],
    ['Expanded Wire M/G',                 'rolls'],
    ['Barbed Wire 610m Abyssinia',        'rolls'],
    ['Chain Link 6ft 14g HG',            'rolls'],
    ['Chain Link 5ft 14g HG',            'rolls'],
    ['Wiremesh L/G',                      'rolls'],
    ['Wiremesh H/G',                      'rolls'],
    ['Wiremesh 8x4 50x50 3.5mm',         'rolls'],
    ['610 MTS Ngombe',                    'rolls'],
    ['610 MTS Kifaru',                    'rolls'],
    ['610 MTS DVK',                       'rolls'],
    ['Chain Link 7ft',                    'rolls'],
    ['BRC Wire A142 Std',                 'pcs'],
    ['BRC Wire A98',                      'pcs'],
    ['BRC Wire A66',                      'pcs'],
    ['Kuku Net 1/2"',                     'rolls'],
    ['Kuku Net 3/4"',                     'rolls'],
    ['Perforated Sheet Sieve',            'pcs'],
    ['180 MTS Nyati',                     'rolls'],
    ['Chain Link 5ft',                    'rolls'],
    ['Chain Link 6ft',                    'rolls'],
    ['BRC Wire A98 Std',                  'pcs'],
    ['Razor Wire',                        'rolls'],
    ['Goose Wire',                        'rolls'],
    ['480 MTS DVK',                       'rolls'],
    ['BRC Wire A610',                     'pcs'],
    ['3/4x30m Ngombe',                    'rolls'],
    ['Medium Dog Chain',                  'pcs'],
    ['Galvanized Wire',                   'rolls'],
    ['Chain Link 4ft',                    'rolls'],
  ];

  let added = 0;
  wires.forEach(([name, unit]) => {
    if (existing.includes(name.toLowerCase().trim())) return;
    sheet.appendRow([name, 'Wires', today, 0, '', '', unit, true]);
    existing.push(name.toLowerCase().trim());
    added++;
  });

  SpreadsheetApp.flush();
  Logger.log('Wires products added: ' + added);
}
