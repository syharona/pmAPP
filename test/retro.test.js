import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeRetro, frenchHolidays, isWorkingDay, workingDaysBetween } from '../src/retro.js';
import { openDb } from '../src/db.js';
import { openSqlite } from '../src/sqlite.js';
import { createApp } from '../src/app.js';
import { handleText } from '../src/bot.js';

test('jours fériés français et jours ouvrés', () => {
  const h = frenchHolidays(2026);
  assert.ok(h.has('2026-04-06')); // lundi de Pâques
  assert.ok(h.has('2026-05-14')); // Ascension
  assert.ok(h.has('2026-05-25')); // lundi de Pentecôte
  assert.equal(isWorkingDay('2026-11-11'), false);
  assert.equal(isWorkingDay('2026-09-26'), false); // samedi
  assert.equal(workingDaysBetween('2026-09-28', '2026-10-02'), 5);
});

test('calcul à rebours depuis la deadline', () => {
  const steps = [
    { id: 1, position: 1, title: 'Specs', duration_days: 5, status: 'done' },
    { id: 2, position: 2, title: 'Dev', duration_days: 10, status: 'todo' },
    { id: 3, position: 3, title: 'MEP', duration_days: 1, status: 'todo' },
  ];
  // Deadline samedi 17/10/2026 → dernière étape le vendredi 16/10
  const r = computeRetro(steps, '2026-10-17', '2026-09-28');
  assert.equal(r.steps[2].latest_end, '2026-10-16');
  assert.equal(r.steps[2].latest_start, '2026-10-16');
  assert.equal(r.steps[1].latest_end, '2026-10-15');
  assert.equal(r.steps[1].latest_start, '2026-10-02');
  assert.equal(r.steps[0].latest_start, '2026-09-25');
  assert.equal(r.remainingDays, 11);
  assert.equal(r.availableDays, 15);
  assert.equal(r.buffer, 4);
  assert.equal(r.lateSteps.length, 0);
});

test('étape en retard, reste à faire, infaisabilité', () => {
  const steps = [
    { id: 1, position: 1, title: 'Dev', duration_days: 10, status: 'doing', remaining_days: 3 },
    { id: 2, position: 2, title: 'Recette', duration_days: 10, status: 'todo' },
  ];
  const r = computeRetro(steps, '2026-10-16', '2026-10-12', '2026-10-01');
  assert.equal(r.steps[1].latest_start, '2026-10-05');
  assert.equal(r.steps[1].late, true); // aurait dû démarrer le 05/10
  assert.equal(r.remainingDays, 13);
  assert.equal(r.availableDays, 5);
  assert.equal(r.buffer, -8);
  assert.ok(r.infeasibleBy > 0); // le plan démarre avant le début du projet
});

test('API : modèle TTM, étapes, export du statut, santé', async () => {
  const repo = openDb(':memory:');
  const server = http.createServer(createApp(repo, { appPassword: '', sessionSecret: 's', ingestToken: '', telegram: { allowedChatIds: [] }, whatsapp: {}, anthropic: {} }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, url, body) =>
    fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  try {
    const p = await (await call('POST', '/api/projects', { code: 'TTM', name: 'Lancement', deadline: '2026-10-09', status_note: 'Tenue <b>critique</b>' })).json();
    const steps = await (await call('POST', `/api/projects/${p.id}/retro/template`)).json();
    assert.equal(steps.length, 6);
    assert.equal(repo.get('projects', p.id).ttm, 1);
    assert.equal((await call('POST', `/api/projects/${p.id}/retro/template`)).status, 409);
    await call('POST', `/api/retro-steps/${steps[5].id}/move`, { delta: -1 });
    assert.equal(repo.listRetroSteps(p.id)[4].id, steps[5].id);
    assert.equal((await call('PATCH', `/api/retro-steps/${steps[0].id}`, { duration_days: 0 })).status, 400);

    const dash = await (await call('GET', `/api/projects/${p.id}`)).json();
    assert.equal(dash.metrics.retro.steps.length, 6);

    const html = await call('GET', `/api/projects/${p.id}/report.html?download=1`);
    assert.match(html.headers.get('content-disposition'), /statut-TTM-/);
    const body = await html.text();
    assert.match(body, /Rétroplanning/);
    assert.match(body, /Tenue &lt;b&gt;critique&lt;\/b&gt;/); // contenu échappé
    const txt = await (await call('GET', `/api/projects/${p.id}/report.txt`)).text();
    assert.match(txt, /TTM — Lancement/);
    assert.match(handleText(repo, '/rapport ttm').text, /Message clé/);
    const csv = await call('GET', `/api/projects/${p.id}/actions.csv`);
    assert.equal(csv.status, 200);
  } finally {
    server.close();
  }
});

test('migration : une base existante reçoit les nouvelles colonnes', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pmapp-')), 'old.db');
  const old = openSqlite(file);
  old.exec(`CREATE TABLE projects (id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, aliases TEXT DEFAULT '', description TEXT DEFAULT '', sponsor TEXT DEFAULT '', phase TEXT DEFAULT '', rag TEXT DEFAULT 'green', progress INTEGER DEFAULT 0, start_date TEXT, deadline TEXT, archived INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT);
    INSERT INTO projects (code, name) VALUES ('OLD', 'Ancien');`);
  old.flush?.(); // sql.js : écrit le fichier
  old.close?.();
  const repo = openDb(file);
  const p = repo.listProjects()[0];
  assert.equal(p.ttm, 0);
  assert.equal(p.status_note, '');
});

test('actions rattachées à une phase : capture ~phase, contrôle, signaux', async () => {
  const { parseCapture } = await import('../src/parser.js');
  const { quickCapture, moveItem } = await import('../src/capture.js');
  const { projectDashboard } = await import('../src/health.js');
  const { todayISO, addDays } = await import('../src/dates.js');
  const repo = openDb(':memory:');
  const today = todayISO();
  const p = repo.insert('projects', { code: 'ERP', name: 'ERP', deadline: addDays(today, 30), ttm: 1 });
  const other = repo.insert('projects', { code: 'CRM', name: 'CRM' });
  const recette = repo.addRetroStep({ project_id: p.id, title: 'Recette utilisateurs', duration_days: 5 });
  repo.addRetroStep({ project_id: p.id, title: 'Mise en production', duration_days: 1 });

  const parsed = parseCapture('#ERP ~recette préparer les jeux de test lundi', { projects: repo.listProjects(), steps: repo.listRetroSteps(), today });
  assert.equal(parsed.stepId, recette.id);
  assert.equal(parsed.title, 'Préparer les jeux de test');
  assert.equal(parseCapture('#ERP ~inconnue truc', { projects: repo.listProjects(), steps: repo.listRetroSteps(), today }).unknownStep, 'inconnue');

  // échéance après la fin au plus tard de la phase → signal
  const { item } = quickCapture(repo, `#ERP ~recette tout valider ${addDays(today, 30).split('-').reverse().join('/')}`);
  assert.equal(item.step_id, recette.id);
  const d = projectDashboard(repo, p.id, today);
  const st = d.metrics.retro.steps.find((x) => x.id === recette.id);
  assert.equal(st.openActions, 1);
  assert.deepEqual(st.beyondActions, [item.id]);
  assert.ok(d.metrics.signals.some((s) => /après la fin au plus tard/.test(s.text)));
  assert.equal(d.actions[0].step_title, 'Recette utilisateurs');

  // changement de projet → la phase est retirée ; suppression de la phase → lien remis à null
  moveItem(repo, 'action', item.id, other.id);
  assert.equal(repo.get('actions', item.id).step_id, null);
  const a2 = repo.createAction({ project_id: p.id, step_id: recette.id, title: 'x' });
  repo.remove('retro_steps', recette.id);
  assert.equal(repo.get('actions', a2.id).step_id, null);
});

test('API : une action ne peut pas pointer vers la phase d’un autre projet', async () => {
  const repo = openDb(':memory:');
  const server = http.createServer(createApp(repo, { appPassword: '', sessionSecret: 's', ingestToken: '', telegram: { allowedChatIds: [] }, whatsapp: {}, anthropic: {} }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, url, body) => fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const a = repo.insert('projects', { code: 'A', name: 'A' });
    const b = repo.insert('projects', { code: 'B', name: 'B' });
    const stA = repo.addRetroStep({ project_id: a.id, title: 'Build' });
    assert.equal((await call('POST', '/api/actions', { title: 't', project_id: b.id, step_id: stA.id })).status, 400);
    const ok = await (await call('POST', '/api/actions', { title: 't', project_id: a.id, step_id: stA.id })).json();
    assert.equal(ok.step_id, stA.id);
    const moved = await (await call('PATCH', `/api/actions/${ok.id}`, { project_id: b.id })).json();
    assert.equal(moved.step_id, null);
  } finally {
    server.close();
  }
});
