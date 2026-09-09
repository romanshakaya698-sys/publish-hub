/**
 * 简单 JSON 数据持久化（articles / records / settings）
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const PROFILE_DIR = path.join(__dirname, '..', 'profiles');

for (const dir of [DATA_DIR, UPLOAD_DIR, PROFILE_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

function fileOf(name) {
  return path.join(DATA_DIR, name + '.json');
}

function readJson(name, fallback) {
  const f = fileOf(name);
  if (!fs.existsSync(f)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(f, 'utf-8'));
  } catch {
    return fallback;
  }
}

function writeJson(name, value) {
  const f = fileOf(name);
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf-8');
  fs.renameSync(tmp, f);
}

// ---------- articles ----------
function listArticles() {
  return readJson('articles', []);
}
function saveArticle(article) {
  const list = listArticles();
  const idx = list.findIndex((a) => a.id === article.id);
  if (idx >= 0) list[idx] = article;
  else list.unshift(article);
  writeJson('articles', list);
  return article;
}
function getArticle(id) {
  return listArticles().find((a) => a.id === id) || null;
}
function deleteArticle(id) {
  const list = listArticles().filter((a) => a.id !== id);
  writeJson('articles', list);
}

// ---------- records ----------
function listRecords() {
  return readJson('records', []);
}
function saveRecord(record) {
  const list = listRecords();
  const idx = list.findIndex((r) => r.id === record.id);
  if (idx >= 0) list[idx] = record;
  else list.unshift(record);
  writeJson('records', list);
  return record;
}
function getRecord(id) {
  return listRecords().find((r) => r.id === id) || null;
}
function deleteRecord(id) {
  const list = listRecords().filter((r) => r.id !== id);
  writeJson('records', list);
}

// ---------- settings（平台覆盖配置） ----------
function getSettings() {
  return readJson('settings', { platforms: {} });
}
function saveSettings(settings) {
  writeJson('settings', settings);
}

function uid(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

module.exports = {
  DATA_DIR,
  UPLOAD_DIR,
  PROFILE_DIR,
  listArticles,
  saveArticle,
  getArticle,
  deleteArticle,
  listRecords,
  saveRecord,
  getRecord,
  deleteRecord,
  getSettings,
  saveSettings,
  uid,
};
