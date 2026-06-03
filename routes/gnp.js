const express = require('express');
const router = express.Router();
const { conectar, DataGNP, AsistenciaGNP, H50GNP, PerfilGNP, AusenciaGNP, DiscordUser, LogGNP } = require('../gnp-db');
const { authenticate } = require('../middleware/auth');
const getDb = require('../database');

const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID;
const LOG_WEBHOOK_SECRET = process.env.LOG_WEBHOOK_SECRET || 'coretech-log-secret-2026';

function esDiscordId(v) { return /^\d{17,19}$/.test(v); }

async function getCachedNames(userIds) {
  if (!userIds.length) return {};
  const unique = [...new Set(userIds.filter(Boolean))].filter(esDiscordId);
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
  try {
    const unique = [...new Set(userIds.filter(Boolean))].filter(esDiscordId);
    const allDocs = await DiscordUser.find({ userId: { $in: unique } });
    const cachedIds = new Set();
    for (const doc of allDocs) {
      if (Date.now() - new Date(doc.updatedAt).getTime() < 86400000) cachedIds.add(doc.userId);
    }
    const toFetch = unique.filter(id => !cachedIds.has(id));
    if (!toFetch.length) return;
    console.log(`[GNP] Resolviendo ${toFetch.length} nombres desde Discord API...`);
    let ok = 0, fail = 0;
    for (let i = 0; i < toFetch.length; i += 5) {
      await Promise.all(toFetch.slice(i, i + 5).map(async (userId) => {
        try {
          let name = null;
          // 1) Intentar con apodo del servidor (si hay GUILD_ID)
          if (DISCORD_GUILD_ID) {
            const g = await fetch(`https://discord.com/api/v10/guilds/${DISCORD_GUILD_ID}/members/${userId}`, {
              headers: { Authorization: `Bot ${DISCORD_TOKEN}` }
            });
            if (g.ok) {
              const member = await g.json();
              name = member.nick || member.user?.global_name || member.user?.username || null;
            }
          }
          // 2) Fallback a global API
          if (!name) {
            const r = await fetch(`https://discord.com/api/v10/users/${userId}`, {
              headers: { Authorization: `Bot ${DISCORD_TOKEN}` }
            });
            if (r.ok) {
              const data = await r.json();
              name = data.global_name || data.username || null;
            } else {
              console.log(`[GNP] API users/${userId} → ${r.status}`);
              fail++;
            }
          }
          if (name) {
            await DiscordUser.updateOne({ userId }, { $set: { globalName: name, updatedAt: new Date() } }, { upsert: true });
            ok++;
          }
        } catch (e) {
          console.log(`[GNP] Error fetch ${userId}: ${e.message}`);
        } 
      }));
      if (i + 5 < toFetch.length) await new Promise(r => setTimeout(r, 1000));
    }
    console.log(`[GNP] Resueltos: ${ok} ok, ${fail} fallidos`);
  } finally {
    warming = false;
  }
}

async function prewarmCache() {
  try {
    await conectar();
    const docs = await DataGNP.find({}).maxTimeMS(5000);
    const ids = [];
    for (const d of docs) if (d.key !== 'config' && Array.isArray(d.valor)) ids.push(...d.valor.filter(esDiscordId));
    if (ids.length) backgroundFetch(ids);
  } catch (e) {
    console.log('[GNP] Prewarm omitido (aún no conectado):', e.message);
  }
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

async function log(tipo, accion, descripcion, autor) {
  try {
    await LogGNP.create({ tipo, accion, descripcion, autor: autor || 'sistema' });
  } catch (e) {
    console.log('[GNP] Error al guardar log:', e.message);
  }
}

router.get('/diagnostico', async (req, res) => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ error: 'Token requerido' });
    const decoded = require('jsonwebtoken').verify(header.split(' ')[1], process.env.JWT_SECRET);
    const db = await getDb();
    const user = await db.get('SELECT role FROM users WHERE id = ?', [decoded.id]);
    if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Solo admin' });
    await conectar().catch(() => {});
    const result = {
      discordTokenConfigurado: !!DISCORD_TOKEN,
      discordTokenLength: DISCORD_TOKEN ? DISCORD_TOKEN.length : 0,
      discordGuildId: DISCORD_GUILD_ID || '(no configurado - usa global_name)',
      warming,
      usuariosEnCache: 0
    };
    try { result.usuariosEnCache = await DiscordUser.countDocuments({}); } catch {}
    if (DISCORD_TOKEN) {
      try {
        const test = await fetch('https://discord.com/api/v10/users/@me', {
          headers: { Authorization: `Bot ${DISCORD_TOKEN}` }
        });
        result.tokenValido = test.ok;
        result.statusCode = test.status;
        if (test.ok) {
          const data = await test.json();
          result.botName = data.username;
        } else {
          const err = await test.json().catch(() => ({}));
          result.errorDiscord = err;
        }
      } catch (e) {
        result.tokenValido = false;
        result.errorRed = e.message;
      }
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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

router.get('/logs', async (req, res) => {
  const { page = 1, limit = 50, tipo } = req.query;
  const filtro = {};
  if (tipo) filtro.tipo = tipo;
  const total = await LogGNP.countDocuments(filtro);
  const docs = await LogGNP.find(filtro).sort({ timestamp: -1 }).skip((page - 1) * limit).limit(parseInt(limit));
  res.json({ data: docs, total, page: parseInt(page), limit: parseInt(limit) });
});

router.get('/ascensos/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    const todos = await LogGNP.find({ tipo: 'bot' }).sort({ timestamp: 1 }).maxTimeMS(5000);
    const events = todos.filter(e => e.descripcion && e.descripcion.includes(userId));
    const cuarteles = await DataGNP.find({}).maxTimeMS(3000);
    function cuartelDe(id) { for (const c of cuarteles) if (c.key !== 'config' && Array.isArray(c.valor) && c.valor.includes(id)) return c.key.toUpperCase(); return 'Sin asignar'; }
    const periods = [];
    let prev = null;
    const ingreso = await AsistenciaGNP.findOne({ userId }).sort({ timestamp: 1 }).maxTimeMS(3000);
    if (ingreso) {
      const desde = new Date(0);
      const hasta = events.length ? events[0].timestamp : new Date();
      const asisAntes = await AsistenciaGNP.countDocuments({ userId, timestamp: { $gte: desde, $lt: hasta } }).maxTimeMS(3000);
      const h50Antes = await H50GNP.aggregate([{ $match: { userId, timestamp: { $gte: desde, $lt: hasta } } }, { $group: { _id: null, t: { $sum: '$minutos' } } }]).maxTimeMS(3000);
      periods.push({ fecha: ingreso.timestamp, label: 'Ingreso', cuartel: cuartelDe(userId), asistencias: asisAntes, h50: h50Antes.length ? h50Antes[0].t : 0, descripcion: '' });
      prev = hasta;
    }
    for (const ev of events) {
      const desde = prev || new Date(0);
      const hasta = ev.timestamp;
      const asis = await AsistenciaGNP.countDocuments({ userId, timestamp: { $gte: desde, $lt: hasta } }).maxTimeMS(3000);
      const h50 = await H50GNP.aggregate([{ $match: { userId, timestamp: { $gte: desde, $lt: hasta } } }, { $group: { _id: null, t: { $sum: '$minutos' } } }]).maxTimeMS(3000);
      periods.push({ fecha: ev.timestamp, label: ev.accion || 'Ascenso', cuartel: cuartelDe(userId), asistencias: asis, h50: h50.length ? h50[0].t : 0, descripcion: ev.descripcion });
      prev = hasta;
    }
    const desde = prev || new Date(0);
    const asisAct = await AsistenciaGNP.countDocuments({ userId, timestamp: { $gte: desde } }).maxTimeMS(3000);
    const h50Act = await H50GNP.aggregate([{ $match: { userId, timestamp: { $gte: desde } } }, { $group: { _id: null, t: { $sum: '$minutos' } } }]).maxTimeMS(3000);
    if (periods.length) periods.push({ fecha: new Date(), label: 'Actual', cuartel: cuartelDe(userId), asistencias: asisAct, h50: h50Act.length ? h50Act[0].t : 0, descripcion: '' });
    res.json({ data: periods });
  } catch (e) {
    res.json({ data: [], error: e.message });
  }
});

setTimeout(prewarmCache, 5000);

router.post('/refresh-names', async (req, res) => {
  const docs = await DataGNP.find({});
  const ids = [];
  for (const d of docs) if (d.key !== 'config' && d.valor) ids.push(...d.valor);
  backgroundFetch(ids);
  res.json({ message: `Recarga iniciada para ${[...new Set(ids)].length} usuarios.` });
});

router.post('/webhook-log', async (req, res) => {
  const { secret, titulo, descripcion, color, autor } = req.body;
  if (secret !== LOG_WEBHOOK_SECRET) return res.status(401).json({ error: 'No autorizado' });
  log('bot', titulo || 'Evento', descripcion || '', autor || 'bot');
  res.json({ message: 'Log registrado' });
});

// ---- CRUD: Cuarteles (admin) ----

async function adminOnly(req, res, next) {
  const db = await getDb();
  const user = await db.get('SELECT role FROM users WHERE id = ?', [req.user.id]);
  if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Solo admin' });
  next();
}

router.post('/cuarteles', adminOnly, async (req, res) => {
  const { nombre } = req.body;
  if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });
  const key = nombre.toLowerCase().replace(/\s+/g, '_');
  const existente = await DataGNP.findOne({ key });
  if (existente) return res.status(409).json({ error: 'El cuartel ya existe' });
  await DataGNP.create({ key, valor: [] });
  log('cuartel', 'crear', `Cuartel "${key}" creado`, req.user.id);
  res.json({ message: 'Cuartel creado', nombre: key });
});

router.put('/cuarteles/:nombre', adminOnly, async (req, res) => {
  const nuevo = req.body.nombre;
  if (!nuevo) return res.status(400).json({ error: 'Nombre requerido' });
  const oldKey = req.params.nombre.toLowerCase();
  const newKey = nuevo.toLowerCase().replace(/\s+/g, '_');
  const doc = await DataGNP.findOne({ key: oldKey });
  if (!doc) return res.status(404).json({ error: 'Cuartel no encontrado' });
  await DataGNP.updateOne({ key: oldKey }, { $set: { key: newKey } });
  log('cuartel', 'editar', `Cuartel "${oldKey}" renombrado a "${newKey}"`, req.user.id);
  res.json({ message: 'Cuartel renombrado', old: oldKey, new: newKey });
});

router.delete('/cuarteles/:nombre', adminOnly, async (req, res) => {
  const key = req.params.nombre.toLowerCase();
  const doc = await DataGNP.findOne({ key });
  if (!doc) return res.status(404).json({ error: 'Cuartel no encontrado' });
  await DataGNP.deleteOne({ key });
  log('cuartel', 'eliminar', `Cuartel "${key}" eliminado`, req.user.id);
  res.json({ message: 'Cuartel eliminado' });
});

router.post('/cuarteles/:nombre/miembros', adminOnly, async (req, res) => {
  const { userId } = req.body;
  if (!userId || !/^\d{17,19}$/.test(userId)) return res.status(400).json({ error: 'userId inválido (debe ser un ID numérico de Discord)' });
  const key = req.params.nombre.toLowerCase();
  const doc = await DataGNP.findOne({ key });
  if (!doc) return res.status(404).json({ error: 'Cuartel no encontrado' });
  if ((doc.valor || []).includes(userId)) return res.status(409).json({ error: 'El usuario ya está en el cuartel' });
  await DataGNP.updateOne({ key }, { $push: { valor: userId } });
  backgroundFetch([userId]);
  log('cuartel', 'editar', `Miembro ${userId} agregado a cuartel "${key}"`, req.user.id);
  res.json({ message: 'Miembro agregado' });
});

router.delete('/cuarteles/:nombre/miembros/:userId', adminOnly, async (req, res) => {
  const key = req.params.nombre.toLowerCase();
  const { userId } = req.params;
  const doc = await DataGNP.findOne({ key });
  if (!doc) return res.status(404).json({ error: 'Cuartel no encontrado' });
  await DataGNP.updateOne({ key }, { $pull: { valor: userId } });
  log('cuartel', 'editar', `Miembro ${userId} removido de cuartel "${key}"`, req.user.id);
  res.json({ message: 'Miembro eliminado' });
});

// ---- CRUD: Asistencias (admin) ----

router.put('/asistencias/:id', adminOnly, async (req, res) => {
  const { horaEntrada, horaSalida, cuartel } = req.body;
  const update = {};
  if (horaEntrada !== undefined) update.horaEntrada = horaEntrada;
  if (horaSalida !== undefined) update.horaSalida = horaSalida;
  if (cuartel !== undefined) update.cuartel = cuartel;
  const doc = await AsistenciaGNP.findByIdAndUpdate(req.params.id, { $set: update }, { new: true });
  if (!doc) return res.status(404).json({ error: 'Registro no encontrado' });
  log('asistencia', 'editar', `Asistencia ${req.params.id} actualizada (userId:${doc.userId})`, req.user.id);
  res.json({ message: 'Asistencia actualizada' });
});

router.delete('/asistencias/:id', adminOnly, async (req, res) => {
  const doc = await AsistenciaGNP.findByIdAndDelete(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Registro no encontrado' });
  log('asistencia', 'eliminar', `Asistencia ${req.params.id} eliminada (userId:${doc.userId})`, req.user.id);
  res.json({ message: 'Asistencia eliminada' });
});

// ---- CRUD: H50 (admin) ----

router.put('/h50/:id', adminOnly, async (req, res) => {
  const { minutos, emisor, relegado } = req.body;
  const update = {};
  if (minutos !== undefined) update.minutos = parseInt(minutos);
  if (emisor !== undefined) update.emisor = emisor;
  if (relegado !== undefined) update.relegado = relegado;
  const doc = await H50GNP.findByIdAndUpdate(req.params.id, { $set: update }, { new: true });
  if (!doc) return res.status(404).json({ error: 'Registro no encontrado' });
  log('h50', 'editar', `H50 ${req.params.id} actualizado (userId:${doc.userId})`, req.user.id);
  res.json({ message: 'H50 actualizado' });
});

router.delete('/h50/:id', adminOnly, async (req, res) => {
  const doc = await H50GNP.findByIdAndDelete(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Registro no encontrado' });
  log('h50', 'eliminar', `H50 ${req.params.id} eliminado (userId:${doc.userId})`, req.user.id);
  res.json({ message: 'H50 eliminado' });
});

// ---- CRUD: Ausencias (admin) ----

router.post('/ausencias', adminOnly, async (req, res) => {
  const { userId, fechaFin, motivo } = req.body;
  if (!userId || !fechaFin) return res.status(400).json({ error: 'userId y fechaFin requeridos' });
  await AusenciaGNP.updateOne(
    { userId },
    { $set: { userId, fechaFin: new Date(fechaFin), motivo: motivo || '' } },
    { upsert: true }
  );
  log('ausencia', 'crear', `Ausencia creada para userId:${userId} hasta ${fechaFin}`, req.user.id);
  res.json({ message: 'Ausencia guardada' });
});

router.put('/ausencias/:userId', adminOnly, async (req, res) => {
  const { fechaFin, motivo } = req.body;
  const update = {};
  if (fechaFin) update.fechaFin = new Date(fechaFin);
  if (motivo !== undefined) update.motivo = motivo;
  const doc = await AusenciaGNP.findOneAndUpdate({ userId: req.params.userId }, { $set: update });
  if (!doc) return res.status(404).json({ error: 'Ausencia no encontrada' });
  log('ausencia', 'editar', `Ausencia de userId:${req.params.userId} actualizada`, req.user.id);
  res.json({ message: 'Ausencia actualizada' });
});

router.delete('/ausencias/:userId', adminOnly, async (req, res) => {
  const doc = await AusenciaGNP.findOneAndDelete({ userId: req.params.userId });
  if (!doc) return res.status(404).json({ error: 'Ausencia no encontrada' });
  log('ausencia', 'eliminar', `Ausencia de userId:${req.params.userId} eliminada`, req.user.id);
  res.json({ message: 'Ausencia eliminada' });
});

// ---- CRUD: Perfiles (admin) ----

router.put('/perfiles/:userId', adminOnly, async (req, res) => {
  const { ultimoAscenso } = req.body;
  await PerfilGNP.updateOne(
    { userId: req.params.userId },
    { $set: { ultimoAscenso: ultimoAscenso ? new Date(ultimoAscenso) : null } },
    { upsert: true }
  );
  log('perfil', 'editar', `Perfil de userId:${req.params.userId} actualizado`, req.user.id);
  res.json({ message: 'Perfil actualizado' });
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
  log('nombre', 'crear', `Nombre "${globalName}" asignado a userId:${userId}`, req.user.id);
  res.json({ message: 'Nombre guardado' });
});

router.delete('/nombres/:userId', async (req, res) => {
  const db = await getDb();
  const user = await db.get('SELECT role FROM users WHERE id = ?', [req.user.id]);
  if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Solo admin' });
  await DiscordUser.deleteOne({ userId: req.params.userId });
  log('nombre', 'eliminar', `Nombre de userId:${req.params.userId} eliminado`, req.user.id);
  res.json({ message: 'Nombre eliminado' });
});

module.exports = router;
