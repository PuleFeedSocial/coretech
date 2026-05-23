const express = require('express');
const router = express.Router();
const { conectar, DataGNP, AsistenciaGNP, H50GNP, PerfilGNP, AusenciaGNP, DiscordUser } = require('../gnp-db');
const { authenticate } = require('../middleware/auth');
const getDb = require('../database');

const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// ---- Cache-only resolver (sin esperar a Discord API) ----
async function getCachedNames(userIds) {
  if (!userIds.length) return {};
  const unique = [...new Set(userIds.filter(Boolean))];
  const docs = await DiscordUser.find({ userId: { $in: unique } });
  const result = {};
  const now = Date.now();
  for (const doc of docs) {
    if (now - new Date(doc.updatedAt).getTime() < CACHE_TTL_MS) {
      result[doc.userId] = doc.globalName;
    }
  }
  return result;
}

// ---- Fetcher en segundo plano (no bloquea al request) ----
let warming = false;
async function backgroundFetch(userIds) {
  if (!DISCORD_TOKEN || warming) return;
  warming = true;
  const unique = [...new Set(userIds.filter(Boolean))];

  // Filtrar solo los que no están cacheados o están expirados
  const cached = await DiscordUser.find({ userId: { $in: unique } });
  const cachedIds = new Set();
  const now = Date.now();
  for (const doc of cached) {
    if (now - new Date(doc.updatedAt).getTime() < CACHE_TTL_MS) {
      cachedIds.add(doc.userId);
    }
  }
  const toFetch = unique.filter(id => !cachedIds.has(id));

  if (!toFetch.length) { warming = false; return; }

  const BATCH_SIZE = 5;
  for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
    const batch = toFetch.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async (userId) => {
      try {
        const apiRes = await fetch(`https://discord.com/api/v10/users/${userId}`, {
          headers: { Authorization: `Bot ${DISCORD_TOKEN}` }
        });
        if (!apiRes.ok) {
          console.error(`[Discord API] Error ${apiRes.status} para userId ${userId}`);
          return;
        }
        const data = await apiRes.json();
        const name = data.global_name || data.username || null;
        if (name) {
          await DiscordUser.updateOne(
            { userId },
            { $set: { globalName: name, updatedAt: new Date() } },
            { upsert: true }
          );
        }
      } catch (e) {
        console.error(`[Discord API] Error fetching ${userId}: ${e.message}`);
      }
    }));
    if (i + BATCH_SIZE < toFetch.length) await new Promise(r => setTimeout(r, 1000));
  }
  warming = false;
}

// ---- Pre-cargar caché al arrancar ----
async function prewarmCache() {
  try {
    const docs = await DataGNP.find({});
    const allIds = [];
    for (const d of docs) {
      if (d.key !== 'config' && d.valor) allIds.push(...d.valor);
    }
    const members = await PerfilGNP.find({});
    for (const m of members) allIds.push(m.userId);
    if (allIds.length) backgroundFetch(allIds);
  } catch {}
}

// ---- Acceso ----
async function tieneAcceso(userId) {
  const db = await getDb();
  const user = await db.get('SELECT role FROM users WHERE id = ?', [userId]);
  if (user && user.role === 'admin') return true;
  const proyectos = await db.all('SELECT id FROM projects WHERE LOWER(title) LIKE ?', ['%guardia%']);
  for (const p of proyectos) {
    const asignado = await db.get('SELECT id FROM user_projects WHERE user_id = ? AND project_id = ?', [userId, p.id]);
    if (asignado) return true;
  }
  return false;
}

router.use(authenticate);
router.use(async (req, res, next) => {
  const acceso = await tieneAcceso(req.user.id);
  if (!acceso) return res.status(403).json({ error: 'No tienes acceso a este módulo.' });
  try {
    await conectar();
    next();
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});

router.get('/cuarteles', async (req, res) => {
  const docs = await DataGNP.find({});
  const cuarteles = docs.filter(d => d.key !== 'config').map(d => ({
    nombre: d.key,
    miembros: d.valor || [],
    cantidad: (d.valor || []).length
  }));
  const allIds = cuarteles.flatMap(c => c.miembros);
  const names = await getCachedNames(allIds);
  // Lanzar fetch en segundo plano sin await
  backgroundFetch(allIds);
  const enriched = cuarteles.map(c => ({
    ...c,
    miembros: c.miembros.map(id => ({ userId: id, displayName: names[id] || id }))
  }));
  res.json(enriched);
});

router.get('/cuarteles/:nombre', async (req, res) => {
  const doc = await DataGNP.findOne({ key: req.params.nombre.toLowerCase() });
  if (!doc) return res.status(404).json({ error: 'Cuartel no encontrado.' });
  const miembros = doc.valor || [];
  const names = await getCachedNames(miembros);
  backgroundFetch(miembros);
  res.json({
    nombre: doc.key,
    miembros: miembros.map(id => ({ userId: id, displayName: names[id] || id }))
  });
});

router.get('/miembros/:userId', async (req, res) => {
  const { userId } = req.params;
  const perfil = await PerfilGNP.findOne({ userId });
  const ausencia = await AusenciaGNP.findOne({ userId });
  const cuarteles = await DataGNP.find({});
  let cuartelActual = null;
  for (const c of cuarteles) {
    if (c.key !== 'config' && (c.valor || []).includes(userId)) {
      cuartelActual = c.key;
      break;
    }
  }
  const names = await getCachedNames([userId]);
  backgroundFetch([userId]);
  res.json({
    userId,
    displayName: names[userId] || userId,
    cuartel: cuartelActual,
    ultimoAscenso: perfil?.ultimoAscenso || null,
    ausencia: ausencia ? { fechaFin: ausencia.fechaFin, motivo: ausencia.motivo } : null
  });
});

router.get('/asistencias', async (req, res) => {
  const { userId, cuartel, desde, hasta, page = 1, limit = 50 } = req.query;
  const filtro = {};
  if (userId) filtro.userId = userId;
  if (cuartel) filtro.cuartel = cuartel.toLowerCase();
  if (desde || hasta) {
    filtro.timestamp = {};
    if (desde) filtro.timestamp.$gte = new Date(desde);
    if (hasta) filtro.timestamp.$lte = new Date(hasta);
  }
  const total = await AsistenciaGNP.countDocuments(filtro);
  const docs = await AsistenciaGNP.find(filtro).sort({ timestamp: -1 }).skip((page - 1) * limit).limit(parseInt(limit));
  const allIds = docs.flatMap(d => [d.userId, d.h50Momento]);
  const names = await getCachedNames(allIds);
  backgroundFetch(allIds);
  const enriched = docs.map(d => ({
    ...d.toObject(),
    displayName: names[d.userId] || d.userId,
    h50MomentoDisplay: names[d.h50Momento] || d.h50Momento
  }));
  res.json({ data: enriched, total, page: parseInt(page), limit: parseInt(limit) });
});

router.get('/h50', async (req, res) => {
  const { userId, cuartel, desde, hasta, page = 1, limit = 50 } = req.query;
  const filtro = {};
  if (userId) filtro.userId = userId;
  if (cuartel) filtro.cuartel = cuartel.toLowerCase();
  if (desde || hasta) {
    filtro.timestamp = {};
    if (desde) filtro.timestamp.$gte = new Date(desde);
    if (hasta) filtro.timestamp.$lte = new Date(hasta);
  }
  const total = await H50GNP.countDocuments(filtro);
  const docs = await H50GNP.find(filtro).sort({ timestamp: -1 }).skip((page - 1) * limit).limit(parseInt(limit));
  const allIds = docs.flatMap(d => [d.userId, d.emisor, d.relegado]);
  const names = await getCachedNames(allIds);
  backgroundFetch(allIds);
  const enriched = docs.map(d => ({
    ...d.toObject(),
    displayName: names[d.userId] || d.userId,
    emisorDisplay: names[d.emisor] || d.emisor,
    relegadoDisplay: names[d.relegado] || d.relegado
  }));
  res.json({ data: enriched, total, page: parseInt(page), limit: parseInt(limit) });
});

router.get('/ausencias', async (req, res) => {
  const { activas } = req.query;
  const filtro = {};
  if (activas === 'true') filtro.fechaFin = { $gte: new Date() };
  const docs = await AusenciaGNP.find(filtro).sort({ fechaFin: -1 });
  const allIds = docs.map(d => d.userId);
  const names = await getCachedNames(allIds);
  backgroundFetch(allIds);
  const enriched = docs.map(d => ({
    ...d.toObject(),
    displayName: names[d.userId] || d.userId
  }));
  res.json(enriched);
});

// Endpoint manual para forzar recarga de nombres
router.post('/refresh-names', async (req, res) => {
  const docs = await DataGNP.find({});
  const allIds = [];
  for (const d of docs) {
    if (d.key !== 'config' && d.valor) allIds.push(...d.valor);
  }
  const members = await PerfilGNP.find({});
  for (const m of members) allIds.push(m.userId);
  backgroundFetch(allIds);
  res.json({ message: `Recarga iniciada para ${[...new Set(allIds)].length} usuarios.` });
});

// Pre-warm al arrancar (después de conectar)
setTimeout(prewarmCache, 5000);

// Diagnóstico del token (solo admin)
router.get('/diagnostico', async (req, res) => {
  const db = await getDb();
  const user = await db.get('SELECT role FROM users WHERE id = ?', [req.user.id]);
  if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Solo admin' });
  const status = { tokenConfigurado: !!DISCORD_TOKEN };
  if (DISCORD_TOKEN) {
    try {
      const test = await fetch('https://discord.com/api/v10/users/@me', {
        headers: { Authorization: `Bot ${DISCORD_TOKEN}` }
      });
      status.tokenValido = test.ok;
      status.codigo = test.status;
      if (test.ok) {
        const data = await test.json();
        status.botName = data.username;
      } else {
        const err = await test.json().catch(() => ({}));
        status.error = err;
      }
    } catch (e) {
      status.tokenValido = false;
      status.error = e.message;
    }
  }
  const cacheados = await DiscordUser.countDocuments({});
  status.usuariosCacheados = cacheados;
  res.json(status);
});

module.exports = router;
