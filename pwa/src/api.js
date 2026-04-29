const BASE = 'https://script.google.com/macros/s/AKfycbyWQcmMTMlBjW9zVk8DzKNfej6Pb5KDb8j682LDFEwkZ8Yxvoa4gq1_xz-caWE9aLEhgA/exec';

async function post(body) {
  const res = await fetch(BASE, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    console.error('Apps Script raw response:', text.slice(0, 800));
    return { ok: false, error: 'Server error — check console for details.' };
  }
}

export const runOcr = (image, mediaType, type) =>
  post({ action: 'ocr', image, mediaType, type });

export const saveScan = (payload) =>
  post({ action: 'saveScan', ...payload });

export const getStaff = () =>
  fetch(`${BASE}?action=getStaff`).then(r => r.json());

export const getProductSuggestions = (query) =>
  post({ action: 'getProductSuggestions', query });

export const addAlias = (alias, canonical) =>
  post({ action: 'addAlias', alias, canonical });
