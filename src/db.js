import fs from 'node:fs';
import path from 'node:path';
import { openSqlite } from './sqlite.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  aliases TEXT DEFAULT '',
  description TEXT DEFAULT '',
  sponsor TEXT DEFAULT '',
  phase TEXT DEFAULT '',
  rag TEXT DEFAULT 'green',          -- statut déclaré : green / amber / red
  progress INTEGER DEFAULT 0,        -- avancement 0-100
  start_date TEXT,
  deadline TEXT,
  archived INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  details TEXT DEFAULT '',
  owner TEXT DEFAULT 'moi',
  due_date TEXT,
  priority TEXT DEFAULT 'normal',    -- low / normal / high / critical
  status TEXT DEFAULT 'todo',        -- todo / doing / waiting / done / cancelled
  source TEXT DEFAULT 'web',         -- web / telegram / whatsapp / email / api
  source_ref TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  done_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_actions_project ON actions(project_id);
CREATE INDEX IF NOT EXISTS idx_actions_status ON actions(status);

CREATE TABLE IF NOT EXISTS risks (
  id INTEGER PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  probability INTEGER DEFAULT 3,     -- 1-5
  impact INTEGER DEFAULT 3,          -- 1-5
  status TEXT DEFAULT 'open',        -- open / mitigating / closed / occurred
  owner TEXT DEFAULT '',
  mitigation TEXT DEFAULT '',
  source TEXT DEFAULT 'web',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS risk_history (
  id INTEGER PRIMARY KEY,
  risk_id INTEGER NOT NULL REFERENCES risks(id) ON DELETE CASCADE,
  score INTEGER NOT NULL,
  at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS journal (
  id INTEGER PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  kind TEXT DEFAULT 'note',          -- change / decision / note / risk / system
  text TEXT NOT NULL,
  source TEXT DEFAULT 'web',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS milestones (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  due_date TEXT,
  done INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS emails (
  id INTEGER PRIMARY KEY,
  subject TEXT DEFAULT '',
  sender TEXT DEFAULT '',
  body TEXT NOT NULL,
  source TEXT DEFAULT 'web',
  status TEXT DEFAULT 'pending',     -- pending / processed / ignored
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = openSqlite(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return createRepo(db);
}

const plain = (row) => (row ? { ...row } : row);
const plainAll = (rows) => rows.map((r) => ({ ...r }));

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k] === '' && k.endsWith('_date') ? null : obj[k];
  return out;
}

const FIELDS = {
  projects: ['code', 'name', 'aliases', 'description', 'sponsor', 'phase', 'rag', 'progress', 'start_date', 'deadline', 'archived'],
  actions: ['project_id', 'title', 'details', 'owner', 'due_date', 'priority', 'status', 'source', 'source_ref'],
  risks: ['project_id', 'title', 'description', 'probability', 'impact', 'status', 'owner', 'mitigation', 'source'],
  journal: ['project_id', 'kind', 'text', 'source'],
  milestones: ['project_id', 'title', 'due_date', 'done'],
  emails: ['subject', 'sender', 'body', 'source', 'status'],
};
const TOUCH = new Set(['projects', 'actions', 'risks']);

function createRepo(db) {
  function insert(table, data) {
    const row = pick(data, FIELDS[table]);
    const keys = Object.keys(row);
    const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
    const { lastInsertRowid } = db.prepare(sql).run(...keys.map((k) => row[k]));
    return get(table, Number(lastInsertRowid));
  }

  function update(table, id, data) {
    const row = pick(data, FIELDS[table]);
    const keys = Object.keys(row);
    if (!keys.length) return get(table, id);
    const sets = keys.map((k) => `${k} = ?`);
    if (TOUCH.has(table)) sets.push(`updated_at = datetime('now')`);
    db.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`).run(...keys.map((k) => row[k]), id);
    return get(table, id);
  }

  function get(table, id) {
    return plain(db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id));
  }

  function remove(table, id) {
    return db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id).changes > 0;
  }

  const all = (sql, ...params) => plainAll(db.prepare(sql).all(...params));

  const repo = {
    db,
    insert,
    update,
    get,
    remove,
    all,

    // --- projets
    listProjects({ includeArchived = false } = {}) {
      return all(`SELECT * FROM projects ${includeArchived ? '' : 'WHERE archived = 0'} ORDER BY deadline IS NULL, deadline, name`);
    },

    // --- actions
    createAction(data) {
      return insert('actions', data);
    },
    updateAction(id, data) {
      const patch = { ...data };
      const current = get('actions', id);
      if (!current) return null;
      const row = update('actions', id, patch);
      if (patch.status && patch.status !== current.status) {
        const doneAt = patch.status === 'done' ? new Date().toISOString() : null;
        db.prepare('UPDATE actions SET done_at = ? WHERE id = ?').run(doneAt, id);
      }
      return get('actions', id) || row;
    },
    listActions({ projectId, open, owner, status } = {}) {
      const where = [];
      const params = [];
      if (projectId === null) where.push('a.project_id IS NULL');
      else if (projectId !== undefined) {
        where.push('a.project_id = ?');
        params.push(projectId);
      }
      if (open) where.push(`a.status NOT IN ('done','cancelled')`);
      if (status) {
        where.push('a.status = ?');
        params.push(status);
      }
      if (owner) {
        where.push('lower(a.owner) = lower(?)');
        params.push(owner);
      }
      return all(
        `SELECT a.*, p.code AS project_code, p.name AS project_name
         FROM actions a LEFT JOIN projects p ON p.id = a.project_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY a.status IN ('done','cancelled'), a.due_date IS NULL, a.due_date,
           CASE a.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, a.id DESC`,
        ...params
      );
    },

    // --- risques (avec historique de score pour détecter les risques qui montent)
    createRisk(data) {
      const r = insert('risks', data);
      db.prepare('INSERT INTO risk_history (risk_id, score) VALUES (?, ?)').run(r.id, r.probability * r.impact);
      return r;
    },
    updateRisk(id, data) {
      const before = get('risks', id);
      if (!before) return null;
      const r = update('risks', id, data);
      const score = r.probability * r.impact;
      if (score !== before.probability * before.impact) {
        db.prepare('INSERT INTO risk_history (risk_id, score) VALUES (?, ?)').run(id, score);
      }
      return r;
    },
    listRisks({ projectId, open } = {}) {
      const where = [];
      const params = [];
      if (projectId !== undefined && projectId !== null) {
        where.push('r.project_id = ?');
        params.push(projectId);
      }
      if (open) where.push(`r.status IN ('open','mitigating')`);
      return all(
        `SELECT r.*, r.probability * r.impact AS score, p.code AS project_code, p.name AS project_name
         FROM risks r LEFT JOIN projects p ON p.id = r.project_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY r.status IN ('closed','occurred'), score DESC, r.updated_at DESC`,
        ...params
      );
    },
    riskHistory(riskIds) {
      if (!riskIds.length) return [];
      return all(
        `SELECT * FROM risk_history WHERE risk_id IN (${riskIds.map(() => '?').join(',')}) ORDER BY at, id`,
        ...riskIds
      );
    },

    // --- journal
    addJournal(data) {
      return insert('journal', data);
    },
    listJournal({ projectId, limit = 100, sinceDays } = {}) {
      const where = [];
      const params = [];
      if (projectId !== undefined && projectId !== null) {
        where.push('j.project_id = ?');
        params.push(projectId);
      }
      if (sinceDays) {
        where.push(`j.created_at >= datetime('now', ?)`);
        params.push(`-${Number(sinceDays)} days`);
      }
      return all(
        `SELECT j.*, p.code AS project_code FROM journal j LEFT JOIN projects p ON p.id = j.project_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY j.created_at DESC, j.id DESC LIMIT ?`,
        ...params,
        limit
      );
    },

    // --- jalons
    listMilestones(projectId) {
      if (projectId === undefined) return all('SELECT * FROM milestones ORDER BY due_date IS NULL, due_date');
      return all('SELECT * FROM milestones WHERE project_id = ? ORDER BY due_date IS NULL, due_date', projectId);
    },

    // --- mails en attente de traitement
    listEmails(status = 'pending') {
      return all('SELECT * FROM emails WHERE status = ? ORDER BY created_at DESC', status);
    },

    // --- paramètres
    getSettings() {
      const out = { me_name: 'Moi', me_aliases: '' };
      for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
      return out;
    },
    setSettings(obj) {
      const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
      for (const [k, v] of Object.entries(obj)) stmt.run(k, String(v ?? ''));
      return repo.getSettings();
    },
    meAliases() {
      const s = repo.getSettings();
      return [s.me_name, ...String(s.me_aliases || '').split(',')].map((x) => x && x.trim()).filter(Boolean);
    },
  };
  return repo;
}
