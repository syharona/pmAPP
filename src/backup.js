// Sauvegarde / restauration complète de la base au format JSON, et sauvegardes
// automatiques quotidiennes (les 14 dernières sont conservées).
import fs from 'node:fs';
import path from 'node:path';
import { todayISO } from './dates.js';

// Ordre parents → enfants (insertion) ; la suppression se fait dans l'ordre inverse.
const TABLES = ['projects', 'retro_steps', 'milestones', 'risks', 'risk_history', 'actions', 'journal', 'emails', 'settings'];
// Propres à cette installation : jamais exportés ni écrasés par une restauration.
const PRIVATE_SETTINGS = ['session_secret', 'session_epoch'];

export function exportAll(repo) {
  const tables = {};
  for (const t of TABLES) tables[t] = repo.all(`SELECT * FROM ${t}`);
  tables.settings = tables.settings.filter((r) => !PRIVATE_SETTINGS.includes(r.key));
  return { app: 'pmapp', version: 1, exported_at: new Date().toISOString(), tables };
}

export function restoreAll(repo, data) {
  if (!data || data.app !== 'pmapp' || typeof data.tables !== 'object') {
    throw Object.assign(new Error("Fichier de sauvegarde invalide (ce n'est pas un export PM Cockpit)"), { status: 400 });
  }
  const db = repo.db;
  const columns = Object.fromEntries(TABLES.map((t) => [t, db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name)]));
  const counts = {};
  db.exec('BEGIN');
  try {
    for (const t of [...TABLES].reverse()) {
      if (t === 'settings') db.prepare(`DELETE FROM settings WHERE key NOT IN (${PRIVATE_SETTINGS.map(() => '?').join(',')})`).run(...PRIVATE_SETTINGS);
      else db.prepare(`DELETE FROM ${t}`).run();
    }
    for (const t of TABLES) {
      const rows = Array.isArray(data.tables[t]) ? data.tables[t] : [];
      counts[t] = 0;
      for (const row of rows) {
        if (t === 'settings' && PRIVATE_SETTINGS.includes(row.key)) continue;
        // Seules les colonnes connues sont reprises (un export plus ancien ou plus récent reste lisible).
        const keys = Object.keys(row).filter((k) => columns[t].includes(k));
        if (!keys.length) continue;
        db.prepare(`INSERT INTO ${t} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => row[k]));
        counts[t]++;
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw Object.assign(new Error(`Restauration impossible : ${err.message}`), { status: 400 });
  }
  return counts;
}

/** Écrit au plus une sauvegarde par jour dans `dir` et garde les `keep` plus récentes. */
export function dailyBackup(repo, dir, keep = 14) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `pmapp-${todayISO()}.json`);
  if (!fs.existsSync(file)) {
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(exportAll(repo)));
    fs.renameSync(`${file}.tmp`, file);
  }
  const files = fs.readdirSync(dir).filter((f) => /^pmapp-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  for (const old of files.slice(0, Math.max(0, files.length - keep))) fs.rmSync(path.join(dir, old));
  return file;
}

export function scheduleBackups(repo, dir) {
  const run = () => {
    try {
      dailyBackup(repo, dir);
    } catch (err) {
      console.error('[sauvegarde]', err.message);
    }
  };
  run();
  setInterval(run, 3600000).unref(); // vérifie toutes les heures, écrit une fois par jour
}
