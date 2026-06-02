const express = require('express');
const router = express.Router();

const CSV_URL = process.env.GOOGLE_SHEET_CSV_URL;

function parseCSV(text) {
  const lines = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') { current += '"'; i++; }
        else inQuotes = false;
      } else current += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { lines.push(current); current = ''; }
      else if (ch === '\n' || (ch === '\r' && text[i + 1] === '\n')) { lines.push(current); current = ''; if (ch === '\r') i++; }
      else if (ch === '\r') { lines.push(current); current = ''; }
      else current += ch;
    }
  }
  if (current) lines.push(current);
  return lines;
}

let cache = null;
let cacheTime = 0;

async function fetchSheet() {
  if (cache && Date.now() - cacheTime < 60000) return cache;
  if (!CSV_URL) { cache = null; return null; }

  const res = await fetch(CSV_URL);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const text = await res.text();
  const fields = parseCSV(text);

  if (fields.length < 10) return [];
  const totalCols = 10;
  const headers = fields.slice(0, totalCols).map(h => h.trim());
  const rows = [];
  for (let i = totalCols; i + totalCols - 1 < fields.length; i += totalCols) {
    const obj = {};
    for (let c = 0; c < totalCols; c++) {
      obj[headers[c]] = (fields[i + c] || '').trim();
    }
    rows.push(obj);
  }

  cache = rows;
  cacheTime = Date.now();
  return rows;
}

router.get('/', async (req, res) => {
  try {
    const data = await fetchSheet();
    if (!data) {
      return res.status(503).json({ error: 'Google Sheets CSV no configurado. Falta GOOGLE_SHEET_CSV_URL.' });
    }
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
