require('dotenv').config();
const bcrypt = require('bcryptjs');
const getDb = require('./database');

async function seed() {
  console.log('Sembrando datos iniciales...');
  const db = await getDb();

  const adminEmail = process.env.ADMIN_EMAIL || 'admin@coretech.io';
  const adminPassword = process.env.ADMIN_PASSWORD || 'Admin123!';

  const existingAdmin = await db.get('SELECT id FROM users WHERE email = ?', [adminEmail]);
  if (!existingAdmin) {
    const hashed = bcrypt.hashSync(adminPassword, 10);
    await db.run('INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)',
      ['Administrador CoreTech', adminEmail, hashed, 'admin']);
    console.log('Admin creado:', adminEmail);
  } else {
    console.log('Admin ya existe:', adminEmail);
  }

  const existingCodes = await db.all('SELECT COUNT(*) as count FROM activation_codes');
  if (!existingCodes[0]?.count) {
    const codes = ['111111', '222222', '333333', '444444', '555555'];
    for (const code of codes) {
      await db.run('INSERT INTO activation_codes (code) VALUES (?)', [code]);
    }
    console.log('Códigos insertados:', codes.join(', '));
  } else {
    console.log('Ya existen códigos.');
  }

  const existingProjects = await db.all('SELECT COUNT(*) as count FROM projects');
  if (!existingProjects[0]?.count) {
    const projects = [
      { title: 'Panel de Control Financiero', description: 'Sistema de monitoreo financiero en tiempo real con gráficos interactivos, reportes automatizados y alertas personalizadas.', image_url: '', tags: JSON.stringify(['Dashboard', 'Analytics']), year: '2025', tech_stack: 'React + Node' },
      { title: 'Bot Modular para Comunidades', description: 'Bot de Discord con arquitectura modular, sistema de tickets, moderación inteligente y estadísticas.', image_url: '', tags: JSON.stringify(['Bot', 'Discord', 'Automatización']), year: '2025', tech_stack: 'Python + MongoDB' },
      { title: 'Sistema de Gestión Administrativa', description: 'Plataforma ERP integral para administración de recursos, inventarios, facturación y personal.', image_url: '', tags: JSON.stringify(['Web App', 'ERP']), year: '2024', tech_stack: 'Laravel + MySQL' },
      { title: 'API Gateway para E-commerce', description: 'Arquitectura de microservicios con API Gateway para comercio electrónico.', image_url: '', tags: JSON.stringify(['API', 'Microservicios']), year: '2024', tech_stack: 'Go + Docker' },
      { title: 'Landing Page para Startup Tech', description: 'Página de aterrizaje de alta conversión con diseño moderno y animaciones fluidas.', image_url: '', tags: JSON.stringify(['Landing Page', 'Marketing']), year: '2026', tech_stack: 'HTML + CSS + JS' },
      { title: 'Sistema de Monitoreo de Precios', description: 'Motor de scraping y monitoreo competitivo de precios con alertas configurables.', image_url: '', tags: JSON.stringify(['Scraper', 'Data', 'Automation']), year: '2025', tech_stack: 'Python + Selenium' }
    ];

    for (const p of projects) {
      await db.run('INSERT INTO projects (title, description, image_url, tags, year, tech_stack) VALUES (?, ?, ?, ?, ?, ?)',
        [p.title, p.description, p.image_url, p.tags, p.year, p.tech_stack]);
    }
    console.log('Proyectos insertados:', projects.length);
  } else {
    console.log('Ya existen proyectos.');
  }

  console.log('Seed completado.');
  if (db._close) await db._close();
  process.exit(0);
}

seed().catch(err => {
  console.error('Error en seed:', err);
  process.exit(1);
});
