'use strict';
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const db     = require('./db');

const DATA_DIR   = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

/* ══ HELPERS ══ */
function hashPassword(password) {
  return crypto.createHash('sha256').update(password + 'centralia-salt-2026').digest('hex');
}
function sanitize(u) {
  if (!u) return null;
  const { password_hash, passwordHash, ...rest } = u;
  return rest;
}
function rowToUser(row) {
  return {
    id: row.id, email: row.email,
    passwordHash: row.password_hash,
    name: row.name, plan: row.plan,
    active: row.active, isAdmin: row.is_admin,
    createdAt: row.created_at, lastLoginAt: row.last_login_at
  };
}

/* ══ FILE FALLBACK (dev local sem DATABASE_URL) ══ */
function readUsersFile()      { try { return JSON.parse(fs.readFileSync(USERS_FILE,'utf8')); } catch { return []; } }
function writeUsersFile(arr)  { fs.writeFileSync(USERS_FILE, JSON.stringify(arr,null,2),'utf8'); }

/* ══ USER DIR (local) ══ */
function getUserDir(userId) {
  const dir = path.join(DATA_DIR, 'users', String(userId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function getUserFilePath(userId, filename) {
  return path.join(getUserDir(userId), filename);
}

/* ══ USER DATA (PostgreSQL ou arquivo) ══ */
async function getUserData(userId, key) {
  if (db.isPostgres()) {
    const r = await db.query('SELECT value FROM user_data WHERE user_id=$1 AND key=$2', [userId, key]);
    return r.rows[0]?.value || null;
  }
  try { return JSON.parse(fs.readFileSync(getUserFilePath(userId, key+'.json'),'utf8')); } catch { return null; }
}
async function setUserData(userId, key, value) {
  if (db.isPostgres()) {
    await db.query(`
      INSERT INTO user_data(user_id,key,value,updated_at) VALUES($1,$2,$3,NOW())
      ON CONFLICT(user_id,key) DO UPDATE SET value=$3,updated_at=NOW()
    `, [userId, key, value]);
    return;
  }
  fs.writeFileSync(getUserFilePath(userId, key+'.json'), JSON.stringify(value,null,2),'utf8');
}

/* ══ APP DATA global (para scheduled, etc.) ══ */
async function getAppData(key, fallbackPath) {
  if (db.isPostgres()) {
    const r = await db.query('SELECT value FROM app_data WHERE key=$1', [key]);
    return r.rows[0]?.value ?? null;
  }
  try { return JSON.parse(fs.readFileSync(fallbackPath,'utf8')); } catch { return null; }
}
async function setAppData(key, value, fallbackPath) {
  if (db.isPostgres()) {
    await db.query(`
      INSERT INTO app_data(key,value,updated_at) VALUES($1,$2,NOW())
      ON CONFLICT(key) DO UPDATE SET value=$2,updated_at=NOW()
    `, [key, value]);
    return;
  }
  if (fallbackPath) fs.writeFileSync(fallbackPath, JSON.stringify(value,null,2),'utf8');
}

/* ══ CRUD USUARIOS ══ */
async function readUsers() {
  if (db.isPostgres()) {
    const r = await db.query('SELECT * FROM users ORDER BY created_at');
    return r.rows.map(rowToUser);
  }
  return readUsersFile();
}

async function createUser({ email, password, name, plan = 'basic' }) {
  const e = email.toLowerCase().trim();
  if (db.isPostgres()) {
    const exists = await db.query('SELECT id FROM users WHERE email=$1', [e]);
    if (exists.rows.length) throw new Error('Email já cadastrado.');
    const id = crypto.randomUUID();
    await db.query(
      'INSERT INTO users(id,email,password_hash,name,plan,active,is_admin,created_at) VALUES($1,$2,$3,$4,$5,true,false,NOW())',
      [id, e, hashPassword(password), name||e.split('@')[0], plan]
    );
    return { id, email:e, name:name||e.split('@')[0], plan, active:true, isAdmin:false };
  }
  const users = readUsersFile();
  if (users.find(u=>u.email===e)) throw new Error('Email já cadastrado.');
  const user = { id:crypto.randomUUID(), email:e, passwordHash:hashPassword(password),
    name:name||e.split('@')[0], plan, active:true, isAdmin:false,
    createdAt:new Date().toISOString(), lastLoginAt:null };
  users.push(user);
  writeUsersFile(users);
  getUserDir(user.id);
  return sanitize(user);
}

async function authenticate(email, password) {
  const e = email.toLowerCase().trim();
  if (db.isPostgres()) {
    const r = await db.query('SELECT * FROM users WHERE email=$1', [e]);
    const row = r.rows[0];
    if (!row || !row.active) throw new Error('Usuário não encontrado ou inativo.');
    if (row.password_hash !== hashPassword(password)) throw new Error('Senha incorreta.');
    await db.query('UPDATE users SET last_login_at=NOW() WHERE id=$1', [row.id]);
    return sanitize(rowToUser(row));
  }
  const users = readUsersFile();
  const user  = users.find(u=>u.email===e);
  if (!user||!user.active) throw new Error('Usuário não encontrado ou inativo.');
  if (user.passwordHash!==hashPassword(password)) throw new Error('Senha incorreta.');
  user.lastLoginAt = new Date().toISOString();
  writeUsersFile(users);
  return sanitize(user);
}

async function getUserById(id) {
  if (db.isPostgres()) {
    const r = await db.query('SELECT * FROM users WHERE id=$1', [id]);
    return r.rows[0] ? sanitize(rowToUser(r.rows[0])) : null;
  }
  const u = readUsersFile().find(u=>u.id===id);
  return u ? sanitize(u) : null;
}

async function getAllUsers() {
  if (db.isPostgres()) {
    const r = await db.query('SELECT * FROM users ORDER BY created_at');
    return r.rows.map(row=>sanitize(rowToUser(row)));
  }
  return readUsersFile().map(u=>sanitize(u));
}

async function updateUser(id, fields) {
  if (db.isPostgres()) {
    if (fields.password) { fields.password_hash = hashPassword(fields.password); delete fields.password; }
    if (fields.isAdmin !== undefined) { fields.is_admin = fields.isAdmin; delete fields.isAdmin; }
    const sets = Object.keys(fields).map((k,i)=>`${k}=$${i+2}`).join(',');
    const vals = Object.values(fields);
    const r = await db.query(`UPDATE users SET ${sets} WHERE id=$1 RETURNING *`,[id,...vals]);
    if (!r.rows[0]) throw new Error('Usuário não encontrado.');
    return sanitize(rowToUser(r.rows[0]));
  }
  const users = readUsersFile();
  const idx   = users.findIndex(u=>u.id===id);
  if (idx===-1) throw new Error('Usuário não encontrado.');
  if (fields.password) { fields.passwordHash=hashPassword(fields.password); delete fields.password; }
  users[idx] = {...users[idx],...fields,id};
  writeUsersFile(users);
  return sanitize(users[idx]);
}

async function deleteUser(id) {
  if (db.isPostgres()) {
    await db.query('DELETE FROM users WHERE id=$1',[id]);
    await db.query('DELETE FROM user_data WHERE user_id=$1',[id]);
    return;
  }
  writeUsersFile(readUsersFile().filter(u=>u.id!==id));
}

/* ══ TOKEN ══ */
function generateToken(userId) {
  return crypto.createHmac('sha256', process.env.APP_SECRET||'centralia-secret-2026')
    .update(userId+':'+Date.now()).digest('hex')
    + '.' + Buffer.from(userId).toString('base64');
}

async function verifyToken(token) {
  if (!token) return null;
  try {
    const parts  = token.split('.');
    if (parts.length<2) return null;
    const userId = Buffer.from(parts[parts.length-1],'base64').toString('utf8');
    const user   = await getUserById(userId);
    return user?.active ? user : null;
  } catch { return null; }
}

/* ══ SEED ADMIN ══ */
async function seedAdmin() {
  try {
    const adminEmail = (process.env.ADMIN_EMAIL||'').trim().toLowerCase();
    const adminPass  = (process.env.ADMIN_PASSWORD||'').trim();
    if (!adminEmail||!adminPass) { console.log('⚠️  ADMIN_EMAIL/ADMIN_PASSWORD não configurados.'); return; }

    const users = await readUsers();
    if (users.find(u=>u.email===adminEmail)) { console.log(`✅ Admin já existe: ${adminEmail}`); return; }

    if (db.isPostgres()) {
      const id = crypto.randomUUID();
      await db.query(
        'INSERT INTO users(id,email,password_hash,name,plan,active,is_admin,created_at) VALUES($1,$2,$3,$4,$5,true,true,NOW())',
        [id,adminEmail,hashPassword(adminPass),'Admin','admin']
      );
    } else {
      const admin = { id:crypto.randomUUID(), email:adminEmail, passwordHash:hashPassword(adminPass),
        name:'Admin', plan:'admin', active:true, isAdmin:true,
        createdAt:new Date().toISOString(), lastLoginAt:null };
      const arr = readUsersFile(); arr.push(admin); writeUsersFile(arr);
      getUserDir(admin.id);
    }
    console.log(`✅ Admin criado: ${adminEmail}`);
  } catch(err) { console.error('❌ Erro ao criar admin:', err.message); }
}

module.exports = {
  hashPassword, getUserDir, getUserFilePath,
  getUserData, setUserData, getAppData, setAppData,
  readUsers, createUser, authenticate, getUserById,
  getAllUsers, updateUser, deleteUser,
  generateToken, verifyToken, seedAdmin
};
