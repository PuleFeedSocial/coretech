const path = require('path');
let db = null;

function convertParams(sql, params) {
  if (!params || !params.length) return { text: sql, values: [] };
  let idx = 0;
  const text = sql.replace(/\?/g, () => `$${++idx}`);
  return { text, values: params };
}

async function getDb() {
  if (db) return db;

  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });

    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS activation_codes (
        id SERIAL PRIMARY KEY,
        code TEXT UNIQUE NOT NULL,
        used INTEGER DEFAULT 0,
        used_by INTEGER REFERENCES users(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS projects (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        image_url TEXT DEFAULT '',
        tags TEXT DEFAULT '[]',
        year TEXT DEFAULT '',
        tech_stack TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_projects (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, project_id)
      )
    `);

    db = {
      run: (sql, params) => pool.query(convertParams(sql, params)),
      get: async (sql, params) => {
        const r = await pool.query(convertParams(sql, params));
        return r.rows[0] || null;
      },
      all: async (sql, params) => {
        const r = await pool.query(convertParams(sql, params));
        return r.rows;
      },
      _close: () => pool.end()
    };
  } else {
    const initSqlJs = require('sql.js');
    const fs = require('fs');
    const dbPath = process.env.DB_PATH || path.resolve(__dirname, 'database.sqlite');

    const SQL = await initSqlJs();
    let sqliteDb;
    if (fs.existsSync(dbPath)) {
      sqliteDb = new SQL.Database(fs.readFileSync(dbPath));
    } else {
      sqliteDb = new SQL.Database();
    }

    function save() {
      fs.writeFileSync(dbPath, Buffer.from(sqliteDb.export()));
    }

    sqliteDb.run('PRAGMA foreign_keys = ON');

    sqliteDb.run(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL, password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user', created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    sqliteDb.run(`CREATE TABLE IF NOT EXISTS activation_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL,
      used INTEGER DEFAULT 0, used_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (used_by) REFERENCES users(id)
    )`);
    sqliteDb.run(`CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
      description TEXT NOT NULL, image_url TEXT DEFAULT '',
      tags TEXT DEFAULT '[]', year TEXT DEFAULT '', tech_stack TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    sqliteDb.run(`CREATE TABLE IF NOT EXISTS user_projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
      project_id INTEGER NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      UNIQUE(user_id, project_id)
    )`);

    save();

    db = {
      run: async (sql, params) => {
        if (params && params.length) {
          sqliteDb.run(sql, params);
        } else {
          sqliteDb.exec(sql);
        }
        save();
      },
      get: async (sql, params) => {
        const stmt = sqliteDb.prepare(sql);
        if (params) stmt.bind(params);
        if (stmt.step()) {
          const r = stmt.getAsObject();
          stmt.free();
          return r;
        }
        stmt.free();
        return null;
      },
      all: async (sql, params) => {
        const stmt = sqliteDb.prepare(sql);
        const results = [];
        if (params) stmt.bind(params);
        while (stmt.step()) {
          results.push(stmt.getAsObject());
        }
        stmt.free();
        return results;
      },
      _close: () => { sqliteDb.close(); }
    };
  }

  return db;
}

module.exports = getDb;
