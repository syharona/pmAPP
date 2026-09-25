import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { handleText, handleCallback } from '../src/bot.js';
import { heuristicExtract } from '../src/emailExtract.js';
import { portfolio } from '../src/health.js';
import { addDays, todayISO } from '../src/dates.js';

const baseConfig = {
  appPassword: '',
  sessionSecret: 's',
  ingestToken: 'tok',
  telegram: { token: '', allowedChatIds: [], mode: 'polling' },
  whatsapp: {},
  anthropic: { apiKey: '' },
};

async function withServer(config, fn) {
  const repo = openDb(':memory:');
  const server = http.createServer(createApp(repo, config));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  try {
    await fn(call, repo);
  } finally {
    server.close();
  }
}

test('API : projet, capture, todo, portefeuille', async () => {
  await withServer(baseConfig, async (call) => {
    const p = await call('POST', '/api/projects', { code: 'crm', name: 'CRM', start_date: addDays(todayISO(), -30), deadline: addDays(todayISO(), 10), progress: 10 });
    assert.equal(p.status, 200);
    assert.equal(p.body.code, 'CRM');
    const c = await call('POST', '/api/capture', { text: '#CRM valider les maquettes demain !' });
    assert.equal(c.body.item.project_id, p.body.id);
    await call('PATCH', `/api/actions/${c.body.item.id}`, { due_date: addDays(todayISO(), -2) });
    const todo = await call('GET', '/api/todo');
    assert.equal(todo.body.groups.overdue.length, 1);
    await call('POST', '/api/capture', { text: 'r: #CRM API instable p5 i4' });
    const pf = await call('GET', '/api/portfolio');
    const proj = pf.body.projects[0];
    assert.equal(proj.metrics.overdueActions, 1);
    assert.equal(proj.metrics.criticalRisks, 1);
    assert.equal(proj.metrics.health, 'red');
    const dup = await call('POST', '/api/projects', { code: 'CRM', name: 'bis' });
    assert.equal(dup.status, 409);
  });
});

test('API : ingestion protégée par jeton, mot de passe requis', async () => {
  await withServer({ ...baseConfig, appPassword: 'secret' }, async (call) => {
    assert.equal((await call('GET', '/api/portfolio')).status, 401);
    assert.equal((await call('POST', '/api/ingest/email', { body: 'x' })).status, 401);
    const ok = await call('POST', '/api/ingest/email', { subject: 'S', body: '<p>Merci de valider</p>' }, { authorization: 'Bearer tok' });
    assert.equal(ok.status, 200);
    assert.equal((await call('POST', '/api/login', { password: 'nope' })).status, 401);
  });
});

test('bot : capture sans projet puis rangement par bouton', () => {
  const repo = openDb(':memory:');
  const p = repo.insert('projects', { code: 'ERP', name: 'ERP' });
  const r = handleText(repo, 'appeler Julie demain', { channel: 'telegram' });
  assert.match(r.text, /Inbox/);
  const btn = r.buttons.flat().find((b) => b.text === 'ERP');
  const moved = handleCallback(repo, btn.data);
  assert.match(moved.text, /ERP/);
  assert.equal(repo.listActions({ projectId: p.id }).length, 1);
  assert.match(handleText(repo, '/semaine').text, /Appeler Julie/);
});

test('mail : extraction heuristique', () => {
  const projects = [{ id: 1, code: 'CRM', name: 'Refonte CRM', aliases: '' }];
  const res = heuristicExtract(
    {
      subject: 'CR point CRM',
      from: 'Paul Martin <paul@x.fr>',
      body: `Bonjour,\n\nActions :\n- Paul : finaliser le chiffrage pour vendredi\n- Merci de valider les maquettes avant le 15/10\n\nRisque de retard sur l'API, c'est bloquant.\n\nCordialement,\nPaul\n\nDe : Moi\nEnvoyé : hier\nancien message`,
    },
    { projects, today: '2026-09-25' }
  );
  const actions = res.items.filter((i) => i.kind === 'action');
  assert.equal(res.projectId, 1);
  assert.equal(actions.length, 2);
  assert.equal(actions[0].owner, 'Paul');
  assert.equal(actions[0].title, 'Finaliser le chiffrage');
  assert.equal(actions[1].owner, 'moi');
  assert.equal(actions[1].due, '2026-10-15');
  assert.ok(res.items.some((i) => i.kind === 'risk'));
  assert.ok(!res.items.some((i) => /ancien/.test(i.title)));
});

test('santé : risque en hausse détecté', () => {
  const repo = openDb(':memory:');
  const p = repo.insert('projects', { code: 'A', name: 'A' });
  const r = repo.createRisk({ project_id: p.id, title: 'r', probability: 2, impact: 2 });
  repo.db.prepare(`UPDATE risk_history SET at = datetime('now','-30 days')`).run();
  repo.updateRisk(r.id, { probability: 4 });
  const pf = portfolio(repo);
  assert.equal(pf.rising.length, 1);
  assert.equal(pf.rising[0].from, 4);
  assert.equal(pf.rising[0].score, 8);
});
