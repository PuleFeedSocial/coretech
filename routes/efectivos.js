const express = require('express');
const { google } = require('googleapis');
const router = express.Router();
const { authenticate } = require('../middleware/auth');

const SHEET_ID = process.env.GOOGLE_SHEET_ID;

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

let _sheetMeta = null;
async function getSheetName() {
  if (_sheetMeta) return _sheetMeta;
  const s = sheets();
  if (!s) return 'Sheet1';
  const meta = await s.spreadsheets.get({ spreadsheetId: SHEET_ID, ranges: [] });
  const name = meta.data.sheets?.[0]?.properties?.title || 'Sheet1';
  _sheetMeta = name;
  return name;
}

async function range(r) {
  const name = await getSheetName();
  return name + '!' + r;
}

const DATA_COLS = 10;
const HEADER_OFFSET = 1;

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
    range: await range('A:K'),
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
    range: await range('B:B'),
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
  _sheetMeta = null;
  try {
    const data = await fetchAll(true);
    res.json({ message: 'Cache renovado', total: data ? data.length : 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/validations', async (req, res) => {
  try {
    const s = sheets();
    if (!s) return res.status(503).json({ error: 'Google Sheets no configurado.' });

    const name = await getSheetName();
    const meta = await s.spreadsheets.get({
      spreadsheetId: SHEET_ID,
      ranges: [`${name}!D2:I2`],
      includeGridData: true,
      fields: 'sheets.data.rowData.values.dataValidation'
    });

    const rowVals = meta.data.sheets?.[0]?.data?.[0]?.rowData?.[0]?.values || [];
    const map = { JERARQUÍA: 0, DEPARTAMENTO: 2, ESTATUS: 4, 'CASOS ESPECIALES': 5 };
    const result = {};

    for (const [key, idx] of Object.entries(map)) {
      const dv = rowVals[idx]?.dataValidation;
      if (dv?.conditionType === 'ONE_OF_LIST' && dv.values) {
        result[key] = dv.values.map(v => v.userEnteredValue).filter(Boolean);
      } else {
        result[key] = [];
      }
    }

    res.json(result);
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
      range: await range('A:K'),
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
      range: await range(`B${rowIndex}:K${rowIndex}`),
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

    const name = await getSheetName();
    const meta = await s.spreadsheets.get({ spreadsheetId: SHEET_ID, ranges: [] });
    const sheet = meta.data.sheets.find(sh => sh.properties.title === name);
    const sheetId = sheet ? sheet.properties.sheetId : 0;

    await s.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      resource: {
        requests: [{
          deleteDimension: {
            range: { sheetId, dimension: 'ROWS', startIndex: rowIndex - 1, endIndex: rowIndex }
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
