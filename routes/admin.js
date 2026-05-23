const express = require('express');
const getDb = require('../database');
const { authenticate, adminOnly } = require('../middleware/auth');

const router = express.Router();

router.get('/stats', authenticate, adminOnly, async (req, res) => {
  try {
    const db = await getDb();

    const userCount = db.all('SELECT COUNT(*) as count FROM users');
    const projectCount = db.all('SELECT COUNT(*) as count FROM projects');
    const usedCodes = db.all('SELECT COUNT(*) as count FROM activation_codes WHERE used = 1');
    const totalCodes = db.all('SELECT COUNT(*) as count FROM activation_codes');
    const recentUsers = db.all('SELECT id, name, email, role, created_at FROM users ORDER BY created_at DESC LIMIT 5');
    const recentProjects = db.all('SELECT id, title, created_at FROM projects ORDER BY created_at DESC LIMIT 5');

    res.json({
      totalUsers: userCount[0]?.count || 0,
      totalProjects: projectCount[0]?.count || 0,
      usedCodes: usedCodes[0]?.count || 0,
      totalCodes: totalCodes[0]?.count || 0,
      pendingCodes: (totalCodes[0]?.count || 0) - (usedCodes[0]?.count || 0),
      recentUsers,
      recentProjects
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener estadísticas.' });
  }
});

router.get('/users', authenticate, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    const users = db.all('SELECT id, name, email, role, created_at FROM users ORDER BY created_at DESC');
    res.json(users);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener usuarios.' });
  }
});

router.put('/users/:id/role', authenticate, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    const { role } = req.body;

    if (!role || !['user', 'admin'].includes(role)) {
      return res.status(400).json({ error: 'Rol inválido. Debe ser "user" o "admin".' });
    }

    const user = db.get('SELECT id FROM users WHERE id = ?', [req.params.id]);
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado.' });
    }

    db.run('UPDATE users SET role = ? WHERE id = ?', [role, req.params.id]);
    res.json({ message: 'Rol actualizado.', id: Number(req.params.id), role });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar rol.' });
  }
});

router.delete('/users/:id', authenticate, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    const user = db.get('SELECT id, role FROM users WHERE id = ?', [req.params.id]);

    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado.' });
    }

    if (user.role === 'admin') {
      const adminCount = db.all('SELECT COUNT(*) as count FROM users WHERE role = "admin"');
      if ((adminCount[0]?.count || 0) <= 1) {
        return res.status(400).json({ error: 'No puedes eliminar al único administrador.' });
      }
    }

    db.run('UPDATE activation_codes SET used = 0, used_by = NULL WHERE used_by = ?', [req.params.id]);
    db.run('DELETE FROM users WHERE id = ?', [req.params.id]);
    res.json({ message: 'Usuario eliminado.', id: Number(req.params.id) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar usuario.' });
  }
});

router.get('/codes', authenticate, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    const codes = db.all(`
      SELECT ac.id, ac.code, ac.used, ac.created_at, u.name as used_by_name, u.email as used_by_email
      FROM activation_codes ac
      LEFT JOIN users u ON ac.used_by = u.id
      ORDER BY ac.created_at DESC
    `);
    res.json(codes);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener códigos.' });
  }
});

router.post('/codes', authenticate, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    const { quantity } = req.body;
    const count = Math.min(Math.max(parseInt(quantity) || 1, 1), 50);

    const generated = [];
    const insert = db.prepare('INSERT INTO activation_codes (code) VALUES (?)');

    for (let i = 0; i < count; i++) {
      let code;
      do {
        code = String(Math.floor(100000 + Math.random() * 900000));
      } while (db.get('SELECT id FROM activation_codes WHERE code = ?', [code]));

      insert.bind([code]);
      insert.step();
      insert.reset();
      generated.push(code);
    }

    res.status(201).json({ message: `${generated.length} código(s) generado(s).`, codes: generated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al generar códigos.' });
  }
});

router.delete('/codes/:id', authenticate, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    const code = db.get('SELECT id FROM activation_codes WHERE id = ?', [req.params.id]);
    if (!code) {
      return res.status(404).json({ error: 'Código no encontrado.' });
    }
    db.run('DELETE FROM activation_codes WHERE id = ?', [req.params.id]);
    res.json({ message: 'Código eliminado.', id: Number(req.params.id) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar código.' });
  }
});

router.get('/users/:id/projects', authenticate, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    const user = db.get('SELECT id FROM users WHERE id = ?', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado.' });

    const assigned = db.all(`
      SELECT p.id, p.title, up.created_at as assigned_at
      FROM user_projects up
      JOIN projects p ON up.project_id = p.id
      WHERE up.user_id = ?
      ORDER BY p.title
    `, [req.params.id]);

    const available = db.all(`
      SELECT id, title FROM projects
      WHERE id NOT IN (SELECT project_id FROM user_projects WHERE user_id = ?)
      ORDER BY title
    `, [req.params.id]);

    res.json({ assigned, available });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener proyectos del usuario.' });
  }
});

router.post('/users/:id/projects', authenticate, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    const { project_id } = req.body;
    if (!project_id) return res.status(400).json({ error: 'project_id requerido.' });

    const user = db.get('SELECT id FROM users WHERE id = ?', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado.' });

    const project = db.get('SELECT id FROM projects WHERE id = ?', [project_id]);
    if (!project) return res.status(404).json({ error: 'Proyecto no encontrado.' });

    const existing = db.get('SELECT id FROM user_projects WHERE user_id = ? AND project_id = ?', [req.params.id, project_id]);
    if (existing) return res.status(409).json({ error: 'El proyecto ya está asignado a este usuario.' });

    db.run('INSERT INTO user_projects (user_id, project_id) VALUES (?, ?)', [req.params.id, project_id]);
    res.status(201).json({ message: 'Proyecto asignado correctamente.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al asignar proyecto.' });
  }
});

router.delete('/users/:id/projects/:projectId', authenticate, adminOnly, async (req, res) => {
  try {
    const db = await getDb();
    const existing = db.get('SELECT id FROM user_projects WHERE user_id = ? AND project_id = ?',
      [req.params.id, req.params.projectId]);

    if (!existing) return res.status(404).json({ error: 'Asignación no encontrada.' });

    db.run('DELETE FROM user_projects WHERE user_id = ? AND project_id = ?',
      [req.params.id, req.params.projectId]);

    res.json({ message: 'Proyecto desasignado correctamente.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al desasignar proyecto.' });
  }
});

module.exports = router;
