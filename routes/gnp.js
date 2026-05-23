const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const { conectar, DataGNP, AsistenciaGNP, H50GNP, PerfilGNP, AusenciaGNP } = require('../gnp-db');
const { authenticate } = require('../middleware/auth');
const getDb = require('../database');

const PROJECTO_TITULO = 'Bot Guardia Nacional';

async function tieneAcceso(userId) {
  const db = await getDb();
  const user = await db.get('SELECT role FROM users WHERE id = ?', [userId]);
  if (user && user.role === 'admin') return true;
  const proyecto = await db.get('SELECT id FROM projects WHERE title = ?', [PROJECTO_TITULO]);
  if (!proyecto) return false;
  const asignado = await db.get('SELECT id FROM user_projects WHERE user_id = ? AND project_id = ?', [userId, proyecto.id]);
  return !!asignado;
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
  res.json(cuarteles);
});

router.get('/cuarteles/:nombre', async (req, res) => {
  const doc = await DataGNP.findOne({ key: req.params.nombre.toLowerCase() });
  if (!doc) return res.status(404).json({ error: 'Cuartel no encontrado.' });
  res.json({ nombre: doc.key, miembros: doc.valor || [] });
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
  res.json({
    userId,
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
  res.json({ data: docs, total, page: parseInt(page), limit: parseInt(limit) });
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
  res.json({ data: docs, total, page: parseInt(page), limit: parseInt(limit) });
});

router.get('/ausencias', async (req, res) => {
  const { activas } = req.query;
  const filtro = {};
  if (activas === 'true') filtro.fechaFin = { $gte: new Date() };
  const docs = await AusenciaGNP.find(filtro).sort({ fechaFin: -1 });
  res.json(docs);
});

router.get('/debug/colecciones', async (req, res) => {
  try {
    const conn = mongoose.connection;
    if (!conn || conn.readyState !== 1) {
      return res.json({ conectado: false, estado: conn?.readyState });
    }
    const collections = await conn.db.listCollections().toArray();
    const info = [];
    for (const col of collections) {
      const count = await conn.db.collection(col.name).countDocuments();
      info.push({ nombre: col.name, documentos: count });
    }
    res.json({ conectado: true, baseDeDatos: conn.db.databaseName, colecciones: info });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
