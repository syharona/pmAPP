// Pilote SQLite : node:sqlite (Node >= 22.13) si disponible, sinon sql.js
// (SQLite compilé en WebAssembly, installé par `npm install`, sans compilation native).
// Les deux exposent la même petite API : exec(), prepare().run/get/all().
import fs from 'node:fs';

let driver = null;

async function loadDriver() {
  if (process.env.PMAPP_SQLITE !== 'sqljs') {
    try {
      const { DatabaseSync } = await import('node:sqlite');
      return { name: 'node:sqlite', open: (file) => new DatabaseSync(file) };
    } catch {
      // Node < 22 : on bascule sur sql.js
    }
  }
  let initSqlJs;
  try {
    initSqlJs = (await import('sql.js')).default;
  } catch {
    throw new Error(
      `SQLite indisponible : Node ${process.versions.node} n'a pas node:sqlite. ` +
        'Lance `npm install` (installe sql.js) ou passe à Node 22 LTS.'
    );
  }
  const SQL = await initSqlJs();
  return { name: 'sql.js', open: (file) => new SqlJsDatabase(SQL, file) };
}

driver = await loadDriver();

export const driverName = driver.name;
export const openSqlite = (file) => driver.open(file);

// sql.js travaille en mémoire : on réécrit le fichier (écriture atomique) après chaque modification.
class SqlJsDatabase {
  constructor(SQL, file) {
    this.file = file === ':memory:' ? null : file;
    this.db = new SQL.Database(this.file && fs.existsSync(this.file) ? fs.readFileSync(this.file) : undefined);
    this.pragmas = [];
    this.timer = null;
    if (this.file) {
      const flush = () => this.flush();
      process.once('exit', flush);
      for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => process.exit(0));
    }
  }

  exec(sql) {
    // WAL n'a pas de sens pour une base en mémoire ; on retient les autres PRAGMA
    // car export() rouvre la connexion et les réinitialise.
    const cleaned = sql.replace(/PRAGMA\s+journal_mode\s*=\s*\w+\s*;?/gi, '');
    for (const m of cleaned.matchAll(/PRAGMA\s+[^;]+;?/gi)) this.pragmas.push(m[0]);
    this.db.exec(cleaned);
    this.touch();
  }

  prepare(sql) {
    const self = this;
    return {
      run(...params) {
        self.db.run(sql, params);
        const changes = self.db.getRowsModified();
        const lastInsertRowid = self.db.exec('SELECT last_insert_rowid()')[0].values[0][0];
        self.touch();
        return { changes, lastInsertRowid };
      },
      all(...params) {
        const stmt = self.db.prepare(sql);
        try {
          stmt.bind(params);
          const rows = [];
          while (stmt.step()) rows.push(stmt.getAsObject());
          return rows;
        } finally {
          stmt.free();
        }
      },
      get(...params) {
        return this.all(...params)[0];
      },
    };
  }

  touch() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => this.flush(), 200);
    this.timer.unref();
  }

  flush() {
    if (!this.file) return;
    clearTimeout(this.timer);
    this.timer = null;
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, Buffer.from(this.db.export()));
    fs.renameSync(tmp, this.file);
    for (const p of this.pragmas) this.db.exec(p);
  }
}
