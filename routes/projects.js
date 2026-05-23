const express = require('express');
const getDb = require('../database');
const { authenticate, adminOnly } = require('../middleware/auth');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const db = await getDb();
    const projects = await db.all('SELECT * FROM projects ORDER BY created_at DESC');
    res.json(projects.map(p => ({
      ...p,
      tags: JSON.parse(p.tags || '[]')
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener proyectos.' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const db = await getDb();
    const project = await db.get('SELECT * FROM projects WHERE id = ?', [req.params.id]);
    if (!project) {
      return res.status(404).json({ error: 'Proyecto no encontrado.' });
    }
    project.tags = JSON.parse(project.tags || '[]');
    res.json(project);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener proyecto.' });
  }
});

router.post('/', authenticate, adminOnly, async (req, res) => {
  try {
    const { title, description, image_url, tags, year, tech_stack } = req.body;

    if (!title || !description) {
      return res.status(400).json({ error: 'Título y descripción son obligatorios.' });
    }

    const db = await getDb();
    const tagsJson = JSON.stringify(tags || []);

    await db.run(
      'INSERT INTO projects (title, description, image_url, tags, year, tech_stack) VALUES (?, ?, ?, ?, ?, ?)',
      [title, description, image_url || '', tagsJson, year || '', tech_stack || '']
    );

    const project = await db.get('SELECT * FROM projects ORDER BY id DESC LIMIT 1');
    project.tags = JSON.parse(project.tags || '[]');

    res.status(201).json(project);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al crear proyecto.' });
  }
});

router.put('/:id', authenticate, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    const existing = await db.get('SELECT * FROM projects WHERE id = ?', [req.params.id]);

    if (!existing) {
      return res.status(404).json({ error: 'Proyecto no encontrado.' });
    }

    const { title, description, image_url, tags, year, tech_stack } = req.body;
    const tagsJson = JSON.stringify(tags || JSON.parse(existing.tags || '[]'));

    await db.run(
      'UPDATE projects SET title = ?, description = ?, image_url = ?, tags = ?, year = ?, tech_stack = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [
        title || existing.title,
        description || existing.description,
        image_url !== undefined ? image_url : existing.image_url,
        tagsJson,
        year || existing.year,
        tech_stack || existing.tech_stack,
        req.params.id
      ]
    );

    const project = await db.get('SELECT * FROM projects WHERE id = ?', [req.params.id]);
    project.tags = JSON.parse(project.tags || '[]');

    res.json(project);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar proyecto.' });
  }
});

router.delete('/:id', authenticate, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    const existing = await db.get('SELECT * FROM projects WHERE id = ?', [req.params.id]);

    if (!existing) {
      return res.status(404).json({ error: 'Proyecto no encontrado.' });
    }

    await db.run('DELETE FROM projects WHERE id = ?', [req.params.id]);
    res.json({ message: 'Proyecto eliminado.', id: Number(req.params.id) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar proyecto.' });
  }
});

module.exports = router;
