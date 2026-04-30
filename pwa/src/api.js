const BASE = 'https://script.google.com/macros/s/AKfycbyWQcmMTMlBjW9zVk8DzKNfej6Pb5KDb8j682LDFEwkZ8Yxvoa4gq1_xz-caWE9aLEhgA/exec';

async function post(body) {
  let res, text;
  try {
    res = await fetch(BASE, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, error: 'Network error: ' + (e.message || 'unknown') };
  }
  try {
    text = await res.text();
  } catch (e) {
    return { ok: false, error: 'Read error: ' + (e.message || 'unknown') };
  }
  try {
    return JSON.parse(text);
  } catch {
    console.error('Apps Script raw response:', text.slice(0, 800));
    const preview = text.slice(0, 150).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return { ok: false, error: `[${res.status}] ${preview || 'empty response'}` };
  }
}

export const runOcr = (image, mediaType, type) =>
  post({ action: 'ocr', image, mediaType, type });

export const uploadImage = (image_base64, mime_type, trnx_ref, date) =>
  post({ action: 'uploadImage', image_base64, mime_type, trnx_ref, date });

export const saveScan = (payload) =>
  post({ action: 'saveScan', ...payload });

export const getStaff = () =>
  fetch(`${BASE}?action=getStaff`).then(r => r.json());

export const getProductSuggestions = (query) =>
  post({ action: 'getProductSuggestions', query });

export const addAlias = (alias, canonical) =>
  post({ action: 'addAlias', alias, canonical });
