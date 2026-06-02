const express = require('express');
const router = express.Router();

const CSV_URL = process.env.GOOGLE_SHEET_CSV_URL;

function splitCSVLines(text) {
  const lines = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === '\n') { lines.push(cur); cur = ''; }
      else if (ch === '\r') continue;
      else cur += ch;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function splitCSVLine(line) {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { fields.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

let cache = null;
let cacheTime = 0;

async function fetchWithRedirects(url, maxRedirects = 5) {
  let currentUrl = url;
  for (let i = 0; i < maxRedirects; i++) {
    const res = await fetch(currentUrl, { redirect: 'manual' });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      currentUrl = new URL(res.headers.get('location'), currentUrl).href;
      continue;
    }
    return res;
  }
  return await fetch(currentUrl);
}

async function fetchSheet() {
  if (cache && Date.now() - cacheTime < 60000) return cache;
  if (!CSV_URL) { cache = null; return null; }

  const res = await fetchWithRedirects(CSV_URL);
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + res.statusText);

  const text = await res.text();

  const lines = splitCSVLines(text);
  if (lines.length < 2) return [];

  const headerFields = splitCSVLine(lines[0]);
  const headers = headerFields.slice(1, 11).map(h => h.trim());

  const result = [];
  for (let r = 1; r < lines.length; r++) {
    const line = lines[r].trim();
    if (!line) continue;
    const fields = splitCSVLine(line);
    const obj = {};
    for (let c = 0; c < 10; c++) {
      obj[headers[c]] = (fields[1 + c] || '').trim();
    }
    result.push(obj);
  }

  cache = result;
  cacheTime = Date.now();
  return result;
}

router.get('/', async (req, res) => {
  try {
    const data = await fetchSheet();
    if (!data) return res.status(503).json({ error: 'Google Sheets CSV no configurado. Falta GOOGLE_SHEET_CSV_URL.' });
    res.json({ total: data.length, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/refresh', async (req, res) => {
  cache = null;
  cacheTime = 0;
  try {
    const data = await fetchSheet();
    res.json({ message: 'Cache renovado', total: data ? data.length : 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
