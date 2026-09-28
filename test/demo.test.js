import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { clearDemoData, findDemoData } from '../src/demo.js';

function legacyDemo(repo) {
  // Base remplie par une ancienne version du seed (sans réglage demo_data)
  const crm = repo.insert('projects', { code: 'CRM', name: 'Refonte CRM commercial' });
  const erp = repo.insert('projects', { code: 'ERP', name: 'Migration ERP finance' });
  const st = repo.addRetroStep({ project_id: erp.id, title: 'Recette' });
  repo.createAction({ project_id: erp.id, step_id: st.id, title: 'a' });
  repo.createRisk({ project_id: crm.id, title: 'r' });
  repo.insert('milestones', { project_id: crm.id, title: 'm' });
  repo.addJournal({ project_id: crm.id, kind: 'change', text: 'c' });
  repo.createAction({ project_id: null, title: 'Rappeler Julie (achats) sur le contrat cadre' });
  repo.insert('emails', { subject: 'CR point hebdo CRM', body: 'x', source: 'demo' });
}

test('données de démo : seules les données de démo sont supprimées', () => {
  const repo = openDb(':memory:');
  legacyDemo(repo);
  // Données réelles de l'utilisateur, dont un projet qui s'appelle aussi CRM
  const mine = repo.insert('projects', { code: 'CRM2', name: 'Refonte CRM commercial' });
  const realCrm = repo.insert('projects', { code: 'ZZ', name: 'Mon projet' });
  repo.createAction({ project_id: mine.id, title: 'vraie action' });
  repo.createAction({ project_id: null, title: 'Rappeler le fournisseur' });
  repo.insert('emails', { subject: 'Vrai mail', body: 'y', source: 'web' });
  repo.setSettings({ me_name: 'Sarah' });

  const found = findDemoData(repo);
  assert.deepEqual(found.projects.map((p) => p.code).sort(), ['CRM', 'ERP']);
  assert.equal(found.counts.actions, 2);

  clearDemoData(repo);
  assert.deepEqual(repo.listProjects({ includeArchived: true }).map((p) => p.id).sort(), [mine.id, realCrm.id].sort());
  assert.deepEqual(repo.all('SELECT title FROM actions ORDER BY title').map((a) => a.title), ['Rappeler le fournisseur', 'vraie action']);
  assert.equal(repo.all('SELECT * FROM risks').length, 0);
  assert.equal(repo.all('SELECT * FROM milestones').length, 0);
  assert.equal(repo.all('SELECT * FROM retro_steps').length, 0);
  assert.equal(repo.all("SELECT * FROM journal WHERE kind = 'change'").length, 0);
  assert.deepEqual(repo.listEmails().map((e) => e.subject), ['Vrai mail']);
  assert.equal(repo.getSettings().me_name, 'Sarah');
  assert.equal(findDemoData(repo).counts.projects, 0);
});

test('données de démo marquées : les identifiants enregistrés priment', () => {
  const repo = openDb(':memory:');
  const renamed = repo.insert('projects', { code: 'CRM', name: 'Nom modifié par la suite' });
  const orphan = repo.createAction({ project_id: null, title: 'démo sans projet' });
  repo.setSettings({ demo_data: JSON.stringify({ projects: [renamed.id], actions: [orphan.id] }) });
  const kept = repo.insert('projects', { code: 'ERP', name: 'Migration ERP finance' }); // créé par l'utilisateur après le seed
  clearDemoData(repo);
  assert.deepEqual(repo.listProjects({ includeArchived: true }).map((p) => p.id), [kept.id]);
  assert.equal(repo.get('actions', orphan.id), undefined);
  assert.equal(repo.getSettings().demo_data, undefined);
});
