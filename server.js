require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const getDb = require('./database');

const bcrypt = require('bcryptjs');

const authRoutes = require('./routes/auth');
const projectRoutes = require('./routes/projects');
const uploadRoutes = require('./routes/upload');
const adminRoutes = require('./routes/admin');
const userRoutes = require('./routes/user');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/uploads', express.static(path.resolve(__dirname, 'uploads')));

app.use(express.static(__dirname));

app.use('/api/auth', authRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/user', userRoutes);

async function runSeed() {
  const db = await getDb();
  const existing = await db.get('SELECT id FROM users WHERE role = ?', ['admin']);
  if (existing) return;

  const adminEmail = process.env.ADMIN_EMAIL || 'admin@coretech.io';
  const adminPassword = process.env.ADMIN_PASSWORD || 'Admin123!';
  const hashed = bcrypt.hashSync(adminPassword, 10);
  await db.run('INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)',
    ['Administrador CoreTech', adminEmail, hashed, 'admin']);

  const codes = ['111111', '222222', '333333', '444444', '555555'];
  for (const code of codes) {
    await db.run('INSERT INTO activation_codes (code) VALUES (?)', [code]);
  }

  const projects = [
    { title: 'Panel de Control Financiero', description: 'Sistema de monitoreo financiero en tiempo real con gráficos interactivos.', tags: JSON.stringify(['Dashboard', 'Analytics']), year: '2025', tech_stack: 'React + Node' },
    { title: 'Bot Modular para Comunidades', description: 'Bot de Discord con arquitectura modular, sistema de tickets y moderación inteligente.', tags: JSON.stringify(['Bot', 'Discord']), year: '2025', tech_stack: 'Python + MongoDB' },
    { title: 'Sistema de Gestión Administrativa', description: 'Plataforma ERP integral para administración de recursos e inventarios.', tags: JSON.stringify(['Web App', 'ERP']), year: '2024', tech_stack: 'Laravel + MySQL' },
    { title: 'API Gateway para E-commerce', description: 'Arquitectura de microservicios con API Gateway.', tags: JSON.stringify(['API', 'Microservicios']), year: '2024', tech_stack: 'Go + Docker' },
    { title: 'Landing Page para Startup Tech', description: 'Página de aterrizaje de alta conversión con diseño moderno.', tags: JSON.stringify(['Landing', 'Marketing']), year: '2026', tech_stack: 'HTML + CSS + JS' },
    { title: 'Sistema de Monitoreo de Precios', description: 'Motor de scraping y monitoreo competitivo de precios.', tags: JSON.stringify(['Scraper', 'Data']), year: '2025', tech_stack: 'Python + Selenium' }
  ];
  for (const p of projects) {
    await db.run('INSERT INTO projects (title, description, image_url, tags, year, tech_stack) VALUES (?, ?, ?, ?, ?, ?)',
      [p.title, p.description, '', p.tags, p.year, p.tech_stack]);
  }
}

app.get('/debug', async (req, res) => {
  try {
    const db = await getDb();
    const admin = await db.get('SELECT id, email, role FROM users WHERE role = ?', ['admin']);
    const userCount = (await db.all('SELECT COUNT(*) as c FROM users'))[0]?.c || 0;
    const codeCount = (await db.all('SELECT COUNT(*) as c FROM activation_codes'))[0]?.c || 0;
    const projectCount = (await db.all('SELECT COUNT(*) as c FROM projects'))[0]?.c || 0;
    const dbMode = process.env.DATABASE_URL ? 'PostgreSQL' : 'SQLite';
    res.json({ dbMode, admin: admin || null, userCount, codeCount, projectCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/seed', async (req, res) => {
  try {
    if (req.query.force === 'true') {
      const db = await getDb();
      await db.run('DELETE FROM user_projects');
      await db.run('DELETE FROM projects');
      await db.run('DELETE FROM activation_codes');
      await db.run('DELETE FROM users');
    }
    await runSeed();
    res.json({ message: 'Seed ejecutado correctamente.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error en seed.' });
  }
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Error interno del servidor.' });
});

async function start() {
  await getDb();
  await runSeed();
  app.listen(PORT, () => {
    console.log(`CoreTech Server corriendo en http://localhost:${PORT}`);
  });
}

start();
