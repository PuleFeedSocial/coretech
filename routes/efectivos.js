const express = require('express');
const { google } = require('googleapis');
const router = express.Router();

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_RANGE = process.env.GOOGLE_SHEET_RANGE || 'Sheet1!A:J';

function getAuth() {
  const credsJson = process.env.GOOGLE_CREDENTIALS;
  if (!credsJson) return null;
  try {
    const credentials = JSON.parse(credsJson);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
    });
    return auth;
  } catch { return null; }
}

let cache = null;
let cacheTime = 0;

async function fetchSheet() {
  if (cache && Date.now() - cacheTime < 60000) return cache;

  const auth = getAuth();
  if (!auth) { cache = null; return null; }

  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: SHEET_RANGE,
    valueRenderOption: 'FORMATTED_VALUE'
  });

  const rows = res.data.values || [];
  if (rows.length < 2) return [];

  const headers = rows[0];
  const data = rows.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => {
      obj[h.trim()] = (row[i] || '').toString().trim();
    });
    return obj;
  });

  cache = data;
  cacheTime = Date.now();
  return data;
}

router.get('/', async (req, res) => {
  try {
    const data = await fetchSheet();
    if (!data) {
      return res.status(503).json({ error: 'Google Sheets no configurado. Faltan GOOGLE_CREDENTIALS o GOOGLE_SHEET_ID.' });
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
