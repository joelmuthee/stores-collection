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
  'Timestamp', 'Receipt Type', 'Document Label', 'Trnx Ref',
  'Manual Marking', 'Customer Name', 'Salesperson', 'Stores Employee',
  'Sale Date', 'Sale Time', 'Collection Time', 'Time Gap (mins)',
  'Item Count', 'Items (JSON)', 'Item Summary', 'Total Amount',
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
- Return ONLY the JSON object, no preamble or explanation.`;

function runOcr(payload) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) return { ok: false, error: 'ANTHROPIC_API_KEY not set in Script Properties' };

  const prompt = payload.type === 'printed' ? PRINTED_PROMPT : HANDWRITTEN_PROMPT;
  const mediaType = payload.mediaType || 'image/jpeg';

  const body = {
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
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

  // Sanitise impossible time values
  if (scan.time) {
    const parts = scan.time.split(':').map(Number);
    if (isNaN(parts[0]) || isNaN(parts[1]) || parts[0] > 23 || parts[1] > 59) {
      scan.time = null;
      scan.confidence = { ...scan.confidence, time: 'low' };
    }
  }

  return { ok: true, scan };
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

  // Duplicate check for printed receipts
  if (scan.trnx_ref) {
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

  const dailyTab = getOrCreateDailyTab(ss, now);
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
    scan.document_label || 'Note',              // C: Document Label
    scan.trnx_ref || '',                        // D: Trnx Ref
    scan.manual_marking || '',                  // E: Manual Marking
    scan.customer_name || '',                   // F: Customer Name
    scan.salesperson || '',                     // G: Salesperson
    payload.stores_employee || '',              // H: Stores Employee
    saleDate || '',                             // I: Sale Date
    saleTime || '',                             // J: Sale Time
    now.toISOString(),                          // K: Collection Time
    timeGap !== null ? timeGap : '',            // L: Time Gap (mins)
    items.length,                               // M: Item Count
    JSON.stringify(items),                      // N: Items (JSON)
    itemSummary,                                // O: Item Summary
    scan.total !== undefined ? scan.total : '', // P: Total Amount
    payload.status || 'Collected',              // Q: Status
    payload.drive_image_link || '',             // R: Drive Image Link
    payload.notes || '',                        // S: Notes
    flags.join('; '),                           // T: Flag
  ];

  dailyTab.appendRow(row);

  // Update Products catalog
  updateProductsCatalog(ss, items, saleDate || Utilities.formatDate(now, Session.getScriptTimeZone(), 'dd-MM-yyyy'));

  // Update Customers tab for handwritten notes
  if (scan.customer_name) {
    updateCustomers(ss, scan.customer_name, now);
  }

  return { ok: true, saved: true, flags };
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

  const sheet = ss.getSheetByName(today);
  if (!sheet || sheet.getLastRow() <= 1) {
    return { ok: true, date: today, total_scans: 0, collected: 0, pending: 0, total_value: 0, salespersons: {}, items_by_category: {} };
  }

  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, DAILY_HEADERS.length).getValues();

  let totalValue = 0;
  let collected = 0;
  let pending = 0;
  const salespersons = {};
  const itemsByCategory = {};

  data.forEach(row => {
    const status = row[16]; // Q: Status
    const total = parseFloat(row[15]) || 0; // P: Total Amount
    const salesperson = row[6]; // G: Salesperson
    const itemsJson = row[13]; // N: Items (JSON)

    totalValue += total;
    if (status === 'Collected') collected++;
    else pending++;

    if (salesperson) salespersons[salesperson] = (salespersons[salesperson] || 0) + 1;

    try {
      const items = JSON.parse(itemsJson || '[]');
      items.forEach(item => {
        const cat = categoriseItem(item.description || '');
        itemsByCategory[cat] = (itemsByCategory[cat] || 0) + 1;
      });
    } catch (_) {}
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

  const sheets = ss.getSheets();
  const pattern = /^(\d{2})-(\d{2})-(\d{4})$/;

  let totalScans = 0;
  let totalValue = 0;
  let collected = 0;
  let pending = 0;
  const salespersons = {};
  const customers = {};
  const dailyBreakdown = [];

  sheets.forEach(sheet => {
    const match = sheet.getName().match(pattern);
    if (!match) return;
    const [, d, m, y] = match;
    if (parseInt(m) !== targetMonth || parseInt(y) !== targetYear) return;
    if (sheet.getLastRow() <= 1) return;

    const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, DAILY_HEADERS.length).getValues();
    let dayValue = 0;

    data.forEach(row => {
      const status = row[16];
      const total = parseFloat(row[15]) || 0;
      const sp = row[6];
      const cust = row[5];

      totalScans++;
      totalValue += total;
      dayValue += total;
      if (status === 'Collected') collected++; else pending++;
      if (sp) salespersons[sp] = (salespersons[sp] || 0) + 1;
      if (cust) customers[cust] = (customers[cust] || 0) + 1;
    });

    dailyBreakdown.push({ date: sheet.getName(), scans: data.length, value: dayValue });
  });

  dailyBreakdown.sort((a, b) => a.date.localeCompare(b.date));

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

function getOrCreateDailyTab(ss, date) {
  const tz = Session.getScriptTimeZone();
  const tabName = Utilities.formatDate(date, tz, 'dd-MM-yyyy');
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
  const pattern = /^\d{2}-\d{2}-\d{4}$/;
  for (const sheet of sheets) {
    if (!pattern.test(sheet.getName())) continue;
    if (sheet.getLastRow() <= 1) continue;
    const refs = sheet.getRange(2, 4, sheet.getLastRow() - 1, 1).getValues().flat();
    const idx = refs.indexOf(trnxRef);
    if (idx >= 0) {
      return { sheet: sheet.getName(), row: idx + 2 };
    }
  }
  return null;
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
