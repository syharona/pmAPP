// Repérage et suppression des données de démonstration créées par `npm run seed`.
// Depuis cette version, le seed enregistre les identifiants qu'il crée (réglage
// `demo_data`). Pour les bases remplies avant, on reconnaît les éléments de démo
// à leur code ET leur nom exacts : un vrai projet « CRM » n'est jamais touché.

const LEGACY_PROJECTS = [
  ['CRM', 'Refonte CRM commercial'],
  ['ERP', 'Migration ERP finance'],
  ['OFFRE', 'Lancement offre Pro 2027'],
  ['DATA', 'Plateforme data RH'],
  ['M365', 'Déploiement Teams / M365'],
];
const LEGACY_ORPHAN_ACTIONS = ['Rappeler Julie (achats) sur le contrat cadre'];

const placeholders = (ids) => ids.map(() => '?').join(',');

function marked(repo) {
  try {
    return JSON.parse(repo.getSettings().demo_data || 'null');
  } catch {
    return null;
  }
}

/** Ce qui serait supprimé (aperçu). */
export function findDemoData(repo) {
  const m = marked(repo);
  const all = repo.listProjects({ includeArchived: true });
  const projects = m
    ? all.filter((p) => m.projects?.includes(p.id))
    : all.filter((p) => LEGACY_PROJECTS.some(([code, name]) => p.code === code && p.name === name));
  const projectIds = projects.map((p) => p.id);

  const orphanActions = m
    ? (m.actions || []).map((id) => repo.get('actions', id)).filter((a) => a && a.project_id === null)
    : repo
        .all(`SELECT * FROM actions WHERE project_id IS NULL AND title IN (${placeholders(LEGACY_ORPHAN_ACTIONS)})`, ...LEGACY_ORPHAN_ACTIONS);
  const emails = repo.all(`SELECT id, subject FROM emails WHERE source = 'demo'`);

  const count = (table) =>
    projectIds.length ? repo.all(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id IN (${placeholders(projectIds)})`, ...projectIds)[0].n : 0;

  return {
    projects: projects.map((p) => ({ id: p.id, code: p.code, name: p.name })),
    orphanActionIds: orphanActions.map((a) => a.id),
    emailIds: emails.map((e) => e.id),
    counts: {
      projects: projects.length,
      actions: count('actions') + orphanActions.length,
      risks: count('risks'),
      journal: count('journal'),
      milestones: count('milestones'),
      steps: count('retro_steps'),
      emails: emails.length,
    },
  };
}

export function clearDemoData(repo) {
  const found = findDemoData(repo);
  const ids = found.projects.map((p) => p.id);
  const run = (sql, list) => (list.length ? repo.db.prepare(sql.replace('%', placeholders(list))).run(...list) : null);
  repo.db.exec('BEGIN');
  try {
    // Les enfants d'abord : sinon actions, risques et journal deviendraient orphelins (inbox).
    for (const table of ['actions', 'risks', 'journal']) run(`DELETE FROM ${table} WHERE project_id IN (%)`, ids);
    run('DELETE FROM projects WHERE id IN (%)', ids); // jalons et étapes : ON DELETE CASCADE
    run('DELETE FROM actions WHERE id IN (%)', found.orphanActionIds);
    run('DELETE FROM emails WHERE id IN (%)', found.emailIds);
    repo.db.prepare(`DELETE FROM settings WHERE key = 'demo_data'`).run();
    repo.db.exec('COMMIT');
  } catch (err) {
    repo.db.exec('ROLLBACK');
    throw err;
  }
  return found.counts;
}

export function describeCounts(c) {
  const parts = [
    [c.projects, 'projet(s)'],
    [c.actions, 'action(s)'],
    [c.risks, 'risque(s)'],
    [c.milestones, 'jalon(s)'],
    [c.steps, 'étape(s) de rétroplanning'],
    [c.journal, 'entrée(s) de journal'],
    [c.emails, 'mail(s)'],
  ].filter(([n]) => n);
  return parts.length ? parts.map(([n, l]) => `${n} ${l}`).join(', ') : 'rien';
}
