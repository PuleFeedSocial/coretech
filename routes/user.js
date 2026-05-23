const express = require('express');
const getDb = require('../database');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

router.get('/projects', authenticate, async (req, res) => {
  try {
    const db = await getDb();
    const projects = await db.all(`
      SELECT p.*, up.created_at as assigned_at
      FROM user_projects up JOIN projects p ON up.project_id = p.id
      WHERE up.user_id = ? ORDER BY up.created_at DESC
    `, [req.user.id]);

    res.json(projects.map(p => ({
      ...p,
      tags: JSON.parse(p.tags || '[]')
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener proyectos.' });
  }
});

module.exports = router;
