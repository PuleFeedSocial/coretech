const express = require('express');
const router = express.Router();
const { conectar, DataGNP, AsistenciaGNP, H50GNP, PerfilGNP, AusenciaGNP, DiscordUser } = require('../gnp-db');
const { authenticate } = require('../middleware/auth');
const getDb = require('../database');

const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN;

async function getCachedNames(userIds) {
  if (!userIds.length) return {};
  const unique = [...new Set(userIds.filter(Boolean))];
  const docs = await DiscordUser.find({ userId: { $in: unique } });
  const result = {};
  for (const doc of docs) {
    result[doc.userId] = doc.globalName;
  }
  return result;
}

let warming = false;
async function backgroundFetch(userIds) {
  if (!DISCORD_TOKEN || warming) return;
  warming = true;
  const unique = [...new Set(userIds.filter(Boolean))];
  const allDocs = await DiscordUser.find({ userId: { $in: unique } });
  const cachedIds = new Set();
  for (const doc of allDocs) {
    if (Date.now() - new Date(doc.updatedAt).getTime() < 86400000) cachedIds.add(doc.userId);
  }
  const toFetch = unique.filter(id => !cachedIds.has(id));
  if (!toFetch.length) { warming = false; return; }
  for (let i = 0; i < toFetch.length; i += 5) {
    await Promise.all(toFetch.slice(i, i + 5).map(async (userId) => {
      try {
        const r = await fetch(`https://discord.com/api/v10/users/${userId}`, {
          headers: { Authorization: `Bot ${DISCORD_TOKEN}` }
        });
        if (!r.ok) return;
        const data = await r.json();
        const name = data.global_name || data.username;
        if (name) await DiscordUser.updateOne({ userId }, { $set: { globalName: name, updatedAt: new Date() } }, { upsert: true });
      } catch {}
    }));
    if (i + 5 < toFetch.length) await new Promise(r => setTimeout(r, 1000));
  }
  warming = false;
}

async function prewarmCache() {
  try {
    const docs = await DataGNP.find({});
    const ids = [];
    for (const d of docs) if (d.key !== 'config' && d.valor) ids.push(...d.valor);
    if (ids.length) backgroundFetch(ids);
  } catch {}
}

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
  const allIds = docs.map(d => d.userId);
  const names = await getCachedNames(allIds);
  backgroundFetch(allIds);
  const enriched = docs.map(d => ({
    ...d.toObject(),
    displayName: names[d.userId] || d.userId
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

setTimeout(prewarmCache, 5000);

router.post('/refresh-names', async (req, res) => {
  const docs = await DataGNP.find({});
  const ids = [];
  for (const d of docs) if (d.key !== 'config' && d.valor) ids.push(...d.valor);
  backgroundFetch(ids);
  res.json({ message: `Recarga iniciada para ${[...new Set(ids)].length} usuarios.` });
});

// ---- Gestión manual de nombres (solo admin) ----

router.get('/nombres', async (req, res) => {
  const db = await getDb();
  const user = await db.get('SELECT role FROM users WHERE id = ?', [req.user.id]);
  if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Solo admin' });
  const docs = await DiscordUser.find({}).sort({ userId: 1 });
  res.json(docs.map(d => ({ userId: d.userId, globalName: d.globalName })));
});

router.post('/nombres', async (req, res) => {
  const db = await getDb();
  const user = await db.get('SELECT role FROM users WHERE id = ?', [req.user.id]);
  if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Solo admin' });
  const { userId, globalName } = req.body;
  if (!userId || !globalName) return res.status(400).json({ error: 'userId y globalName requeridos' });
  await DiscordUser.updateOne(
    { userId },
    { $set: { globalName, updatedAt: new Date() } },
    { upsert: true }
  );
  res.json({ message: 'Nombre guardado' });
});

router.delete('/nombres/:userId', async (req, res) => {
  const db = await getDb();
  const user = await db.get('SELECT role FROM users WHERE id = ?', [req.user.id]);
  if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Solo admin' });
  await DiscordUser.deleteOne({ userId: req.params.userId });
  res.json({ message: 'Nombre eliminado' });
});

module.exports = router;
