const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const getDb = require('../database');

const router = express.Router();
const SECRET = process.env.JWT_SECRET || 'CoreTech_S3cur3_K3y_2026';

router.post('/register', async (req, res) => {
  try {
    const { name, email, password, activationCode } = req.body;

    if (!name || !email || !password || !activationCode) {
      return res.status(400).json({ error: 'Todos los campos son obligatorios.' });
    }

    if (!/^[0-9]{6}$/.test(activationCode)) {
      return res.status(400).json({ error: 'El código de activación debe tener 6 dígitos.' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres.' });
    }

    const db = await getDb();

    const existingUser = await db.get('SELECT id FROM users WHERE email = ?', [email]);
    if (existingUser) {
      return res.status(409).json({ error: 'El email ya está registrado.' });
    }

    const code = await db.get('SELECT id FROM activation_codes WHERE code = ? AND used = 0', [activationCode]);
    if (!code) {
      return res.status(400).json({ error: 'Código de activación inválido o ya utilizado.' });
    }

    const hashedPassword = bcrypt.hashSync(password, 10);
    await db.run('INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)', [name, email, hashedPassword, 'user']);

    const user = await db.get('SELECT id FROM users WHERE email = ?', [email]);
    await db.run('UPDATE activation_codes SET used = 1, used_by = ? WHERE id = ?', [user.id, code.id]);

    const token = jwt.sign({ id: user.id, name, email, role: 'user' }, SECRET, { expiresIn: '7d' });

    res.status(201).json({ message: 'Cuenta creada exitosamente.', token, user: { id: user.id, name, email, role: 'user' } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email y contraseña son obligatorios.' });
    }

    const db = await getDb();
    const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);

    if (!user) {
      return res.status(401).json({ error: 'Credenciales inválidas.', code: 'USER_NOT_FOUND' });
    }

    if (!bcrypt.compareSync(password, user.password)) {
      return res.status(401).json({ error: 'Credenciales inválidas.', code: 'WRONG_PASSWORD' });
    }

    const token = jwt.sign(
      { id: user.id, name: user.name, email: user.email, role: user.role },
      SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      message: 'Inicio de sesión exitoso.',
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

router.post('/change-password', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Token requerido.' });

    const decoded = jwt.verify(token, SECRET);
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Ambas contraseñas son obligatorias.' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres.' });
    }

    const db = await getDb();
    const user = await db.get('SELECT * FROM users WHERE id = ?', [decoded.id]);
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado.' });

    if (!bcrypt.compareSync(currentPassword, user.password)) {
      return res.status(400).json({ error: 'La contraseña actual no es correcta.' });
    }

    const hashed = bcrypt.hashSync(newPassword, 10);
    await db.run('UPDATE users SET password = ? WHERE id = ?', [hashed, decoded.id]);

    res.json({ message: 'Contraseña actualizada correctamente.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al cambiar contraseña.' });
  }
});

module.exports = router;
