'use strict';
/**
 * db.js — Conexão PostgreSQL com fallback para armazenamento em arquivo
 * Usa DATABASE_URL (Railway) quando disponível, senão usa arquivos JSON locais.
 */
const { Pool } = require('pg');

let pool = null;

function getPool() {
  if (!pool && process.env.DATABASE_URL) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
    });
    pool.on('error', (err) => console.error('PostgreSQL erro:', err.message));
  }
  return pool;
}

function isPostgres() {
  return !!process.env.DATABASE_URL;
}

async function query(sql, params = []) {
  const p = getPool();
  if (!p) throw new Error('DATABASE_URL não configurado.');
  const res = await p.query(sql, params);
  return res;
}

async function initSchema() {
  if (!isPostgres()) return;
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS users (
        id           TEXT PRIMARY KEY,
        email        TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        name         TEXT,
        plan         TEXT DEFAULT 'basic',
        active       BOOLEAN DEFAULT true,
        is_admin     BOOLEAN DEFAULT false,
        created_at   TIMESTAMPTZ DEFAULT NOW(),
        last_login_at TIMESTAMPTZ
      );
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS user_data (
        user_id    TEXT NOT NULL,
        key        TEXT NOT NULL,
        value      JSONB,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (user_id, key)
      );
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS app_data (
        key        TEXT PRIMARY KEY,
        value      JSONB,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('✅ PostgreSQL: schema inicializado.');
  } catch (err) {
    console.error('❌ PostgreSQL schema erro:', err.message);
  }
}

module.exports = { getPool, isPostgres, query, initSchema };
