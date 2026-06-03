const express = require('express');
const { google } = require('googleapis');
const router = express.Router();
const { authenticate } = require('../middleware/auth');

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = process.env.GOOGLE_SHEET_RANGE ? process.env.GOOGLE_SHEET_RANGE.split('!')[0] : 'Sheet1';
const RANGE = SHEET_NAME + '!A:K';

let _auth = null;
function getAuth() {
  if (_auth) return _auth;
  const credsJson = process.env.GOOGLE_CREDENTIALS;
  if (!credsJson) return null;
  try {
    const credentials = JSON.parse(credsJson);
    _auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    return _auth;
  } catch { return null; }
}

function sheets() {
  const auth = getAuth();
  if (!auth) return null;
  return google.sheets({ version: 'v4', auth });
}

const DATA_COLS = 10;
const HEADER_OFFSET = 1;
const STATUS_COL = 'A';

let cache = null;
let cacheTime = 0;

function rowToObj(headers, row) {
  const obj = {};
  for (let c = 0; c < DATA_COLS; c++) {
    obj[headers[c]] = (row[HEADER_OFFSET + c] || '').trim();
  }
  return obj;
}

async function fetchAll(forceRefresh) {
  if (cache && Date.now() - cacheTime < 60000 && !forceRefresh) return cache;
  const s = sheets();
  if (!s) return null;

  const res = await s.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: RANGE,
    valueRenderOption: 'FORMATTED_VALUE'
  });

  const rows = res.data.values || [];
  if (rows.length < 2) return [];

  const headers = rows[0].slice(HEADER_OFFSET, HEADER_OFFSET + DATA_COLS).map(h => h.trim());
  const data = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row[HEADER_OFFSET]) continue;
    data.push(rowToObj(headers, row));
  }

  cache = data;
  cacheTime = Date.now();
  return data;
}

async function findRowIndex(placa) {
  const s = sheets();
  if (!s) return -1;
  const res = await s.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: SHEET_NAME + '!B:B',
    valueRenderOption: 'FORMATTED_VALUE'
  });
  const values = res.data.values || [];
  for (let i = 1; i < values.length; i++) {
    if ((values[i][0] || '').trim() === String(placa)) return i + 1;
  }
  return -1;
}

router.get('/', async (req, res) => {
  try {
    const data = await fetchAll(req.query.refresh === 'true');
    if (!data) return res.status(503).json({ error: 'Google Sheets no configurado.' });
    res.json({ total: data.length, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/refresh', async (req, res) => {
  cache = null;
  cacheTime = 0;
  try {
    const data = await fetchAll(true);
    res.json({ message: 'Cache renovado', total: data ? data.length : 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo administradores' });
    const { nombre, jerarquia, discord, departamento, fechaIngreso, estatus, casosEspeciales, bonos, fechaEgreso } = req.body;
    if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });

    const s = sheets();
    if (!s) return res.status(503).json({ error: 'Google Sheets no configurado.' });

    const current = await fetchAll(true);
    const maxPlaca = current.reduce((m, r) => {
      const p = parseInt(r['N° PLACA']);
      return p > m ? p : m;
    }, 999);
    const nuevaPlaca = maxPlaca + 1;

    await s.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: SHEET_NAME + '!A:K',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      resource: { values: [[
        '', nuevaPlaca, nombre, jerarquia || '', discord || '', departamento || '',
        fechaIngreso || '', estatus || '', casosEspeciales || '', bonos || '', fechaEgreso || ''
      ]]}
    });

    cache = null;
    cacheTime = 0;
    res.json({ message: 'Agregado', placa: nuevaPlaca });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:placa', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo administradores' });
    const placa = req.params.placa;
    const rowIndex = await findRowIndex(placa);
    if (rowIndex === -1) return res.status(404).json({ error: 'Placa no encontrada' });

    const { nombre, jerarquia, discord, departamento, fechaIngreso, estatus, casosEspeciales, bonos, fechaEgreso } = req.body;
    const s = sheets();
    if (!s) return res.status(503).json({ error: 'Google Sheets no configurado.' });

    await s.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: SHEET_NAME + `!B${rowIndex}:K${rowIndex}`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[
        placa, nombre || '', jerarquia || '', discord || '', departamento || '',
        fechaIngreso || '', estatus || '', casosEspeciales || '', bonos || '', fechaEgreso || ''
      ]]}
    });

    cache = null;
    cacheTime = 0;
    res.json({ message: 'Actualizado' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:placa', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo administradores' });
    const placa = req.params.placa;
    const rowIndex = await findRowIndex(placa);
    if (rowIndex === -1) return res.status(404).json({ error: 'Placa no encontrada' });

    const s = sheets();
    if (!s) return res.status(503).json({ error: 'Google Sheets no configurado.' });

    await s.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      resource: {
        requests: [{
          deleteDimension: {
            range: { sheetId: 0, dimension: 'ROWS', startIndex: rowIndex - 1, endIndex: rowIndex }
          }
        }]
      }
    });

    cache = null;
    cacheTime = 0;
    res.json({ message: 'Eliminado' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
