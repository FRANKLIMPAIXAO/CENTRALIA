'use strict';
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR  = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

function readUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
  catch { return []; }
}
function writeUsers(arr) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(arr, null, 2), 'utf8');
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(password + 'centralia-salt-2026').digest('hex');
}

function getUserDir(userId) {
  const dir = path.join(DATA_DIR, 'users', String(userId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getUserFilePath(userId, filename) {
  return path.join(getUserDir(userId), filename);
}

function createUser({ email, password, name, plan = 'basic' }) {
  const users = readUsers();
  if (users.find(u => u.email === email)) throw new Error('Email já cadastrado.');
  const user = {
    id: crypto.randomUUID(),
    email: email.toLowerCase().trim(),
    passwordHash: hashPassword(password),
    name: name || email.split('@')[0],
    plan,
    active: true,
    isAdmin: false,
    createdAt: new Date().toISOString(),
    lastLoginAt: null
  };
  users.push(user);
  writeUsers(users);
  getUserDir(user.id); // cria diretório do usuário
  return { ...user, passwordHash: undefined };
}

function authenticate(email, password) {
  const users = readUsers();
  const user  = users.find(u => u.email === email.toLowerCase().trim());
  if (!user || !user.active) throw new Error('Usuário não encontrado ou inativo.');
  if (user.passwordHash !== hashPassword(password)) throw new Error('Senha incorreta.');
  // Atualiza lastLoginAt
  user.lastLoginAt = new Date().toISOString();
  writeUsers(users);
  return { ...user, passwordHash: undefined };
}

function getUserById(id) {
  const u = readUsers().find(u => u.id === id);
  if (!u) return null;
  return { ...u, passwordHash: undefined };
}

function getAllUsers() {
  return readUsers().map(u => ({ ...u, passwordHash: undefined }));
}

function updateUser(id, fields) {
  const users = readUsers();
  const idx   = users.findIndex(u => u.id === id);
  if (idx === -1) throw new Error('Usuário não encontrado.');
  if (fields.password) {
    fields.passwordHash = hashPassword(fields.password);
    delete fields.password;
  }
  users[idx] = { ...users[idx], ...fields, id };
  writeUsers(users);
  return { ...users[idx], passwordHash: undefined };
}

function deleteUser(id) {
  const users = readUsers().filter(u => u.id !== id);
  writeUsers(users);
}

function generateToken(userId) {
  return crypto.createHmac('sha256', process.env.APP_SECRET || 'centralia-secret-2026')
    .update(userId + ':' + Date.now())
    .digest('hex') + '.' + Buffer.from(userId).toString('base64');
}

function verifyToken(token) {
  if (!token) return null;
  try {
    const parts  = token.split('.');
    if (parts.length < 2) return null;
    const userId = Buffer.from(parts[parts.length - 1], 'base64').toString('utf8');
    const user   = getUserById(userId);
    return user?.active ? user : null;
  } catch { return null; }
}

// Seed admin na primeira execução
function seedAdmin() {
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPass  = process.env.ADMIN_PASSWORD;
  if (!adminEmail || !adminPass) return;
  const users = readUsers();
  if (users.find(u => u.email === adminEmail)) return;
  const admin = {
    id: crypto.randomUUID(),
    email: adminEmail.toLowerCase(),
    passwordHash: hashPassword(adminPass),
    name: 'Admin',
    plan: 'admin',
    active: true,
    isAdmin: true,
    createdAt: new Date().toISOString(),
    lastLoginAt: null
  };
  users.push(admin);
  writeUsers(users);
  getUserDir(admin.id);
  console.log(`✅ Admin criado: ${adminEmail}`);
}

module.exports = {
  readUsers, writeUsers, hashPassword,
  getUserDir, getUserFilePath,
  createUser, authenticate, getUserById,
  getAllUsers, updateUser, deleteUser,
  generateToken, verifyToken, seedAdmin
};
