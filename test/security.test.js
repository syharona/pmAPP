import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { configErrors } from '../src/config.js';
import { dailyBackup, exportAll, restoreAll } from '../src/backup.js';

const base = {
  appPassword: 'un-mot-de-passe-solide',
  sessionSecret: '',
  ingestToken: '',
  trustProxy: true,
  telegram: { token: '', allowedChatIds: [], mode: 'polling', webhookSecret: '' },
  whatsapp: {},
  anthropic: {},
};

async function serve(config, repo = openDb(':memory:')) {
  const server = http.createServer(createApp(repo, config));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = (method, p, body, headers = {}) =>
    fetch(url + p, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { call, repo, close: () => server.close() };
}

test('configuration refusée en ligne sans mot de passe solide', () => {
  const c = { ...base, exposed: true, appPassword: 'court' };
  assert.match(configErrors(c).join(), /APP_PASSWORD/);
  assert.deepEqual(configErrors({ ...base, exposed: true }), []);
  assert.deepEqual(configErrors({ ...c, exposed: false }), []); // en local, rien n'est imposé
  assert.match(configErrors({ ...base, exposed: true, telegram: { ...base.telegram, token: 'x', mode: 'webhook' } }).join(), /TELEGRAM_WEBHOOK_SECRET/);
});

test('connexion : cookie Secure derrière HTTPS, blocage après 5 échecs, santé publique', async () => {
  const s = await serve(base);
  try {
    assert.equal((await s.call('GET', '/api/health')).status, 200);
    assert.equal((await s.call('GET', '/api/portfolio')).status, 401);
    const ok = await s.call('POST', '/api/login', { password: base.appPassword }, { 'x-forwarded-proto': 'https', 'x-forwarded-for': '1.1.1.1' });
    assert.match(ok.headers.get('set-cookie'), /HttpOnly; SameSite=Strict.*; Secure/);
    const plain = await s.call('POST', '/api/login', { password: base.appPassword }, { 'x-forwarded-for': '1.1.1.1' });
    assert.doesNotMatch(plain.headers.get('set-cookie'), /Secure/);

    for (let i = 0; i < 5; i++) assert.equal((await s.call('POST', '/api/login', { password: 'faux' }, { 'x-forwarded-for': '6.6.6.6' })).status, 401);
    const blocked = await s.call('POST', '/api/login', { password: base.appPassword }, { 'x-forwarded-for': '6.6.6.6' });
    assert.equal(blocked.status, 429); // même le bon mot de passe est refusé pendant le blocage
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    assert.equal((await s.call('POST', '/api/login', { password: base.appPassword }, { 'x-forwarded-for': '2.2.2.2' })).status, 200);
  } finally {
    s.close();
  }
});

test('anti-force brute : X-Forwarded-For falsifié ne contourne pas le blocage, plafond global', async () => {
  const s = await serve({ ...base, loginDelayMs: 0 });
  try {
    // Le client invente la 1re adresse ; le proxy ajoute la vraie (9.9.9.9) à la fin.
    for (let i = 0; i < 5; i++) await s.call('POST', '/api/login', { password: 'faux' }, { 'x-forwarded-for': `10.0.0.${i}, 9.9.9.9` });
    assert.equal((await s.call('POST', '/api/login', { password: 'faux' }, { 'x-forwarded-for': '10.0.0.99, 9.9.9.9' })).status, 429);
    // Plafond global : 100 échecs par heure, même depuis des adresses toutes différentes
    for (let i = 0; i < 95; i++) await s.call('POST', '/api/login', { password: 'faux' }, { 'x-forwarded-for': `20.0.${i >> 8}.${i & 255}` });
    assert.equal((await s.call('POST', '/api/login', { password: base.appPassword }, { 'x-forwarded-for': '30.0.0.1' })).status, 429);
  } finally {
    s.close();
  }
});

test('session : secret stocké, jamais exposé ; « déconnecter tous les appareils »', async () => {
  const s = await serve(base);
  try {
    const login = async () => (await s.call('POST', '/api/login', { password: base.appPassword })).headers.get('set-cookie').split(';')[0];
    const phone = await login();
    const laptop = await login();
    const settings = await (await s.call('GET', '/api/settings', undefined, { cookie: laptop })).json();
    assert.equal(settings.session_secret, undefined);
    assert.ok(s.repo.getSettings().session_secret.length >= 32);

    const res = await s.call('POST', '/api/logout-all', {}, { cookie: laptop });
    const renewed = res.headers.get('set-cookie').split(';')[0];
    assert.equal((await s.call('GET', '/api/portfolio', undefined, { cookie: phone })).status, 401);
    assert.equal((await s.call('GET', '/api/portfolio', undefined, { cookie: renewed })).status, 200);
  } finally {
    s.close();
  }
});

test('sauvegarde : aller-retour complet, fichier invalide refusé, secrets conservés', async () => {
  const repo = openDb(':memory:');
  const p = repo.insert('projects', { code: 'A', name: 'Projet A', ttm: 1 });
  const st = repo.addRetroStep({ project_id: p.id, title: 'Build' });
  repo.createAction({ project_id: p.id, step_id: st.id, title: 'act' });
  repo.createRisk({ project_id: p.id, title: 'r', probability: 4, impact: 4 });
  repo.setSettings({ me_name: 'Sarah', session_secret: 'secret-de-cette-installation' });
  const backup = JSON.parse(JSON.stringify(exportAll(repo)));
  assert.ok(!backup.tables.settings.some((r) => r.key === 'session_secret'));

  const other = openDb(':memory:');
  other.setSettings({ session_secret: 'autre-secret' });
  other.insert('projects', { code: 'OLD', name: 'à écraser' });
  const counts = restoreAll(other, backup);
  assert.equal(counts.projects, 1);
  assert.deepEqual(other.listProjects().map((x) => x.code), ['A']);
  assert.equal(other.listActions({})[0].step_title, 'Build');
  assert.equal(other.riskHistory([other.listRisks()[0].id]).length, 1);
  assert.equal(other.getSettings().me_name, 'Sarah');
  assert.equal(other.getSettings().session_secret, 'autre-secret');

  assert.throws(() => restoreAll(other, { foo: 1 }), /invalide/);
  assert.deepEqual(other.listProjects().map((x) => x.code), ['A']); // rien n'a bougé
});

test('sauvegardes quotidiennes : une par jour, 14 conservées', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmapp-bk-'));
  for (let d = 1; d <= 20; d++) fs.writeFileSync(path.join(dir, `pmapp-2026-01-${String(d).padStart(2, '0')}.json`), '{}');
  const repo = openDb(':memory:');
  const file = dailyBackup(repo, dir);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).app, 'pmapp');
  const left = fs.readdirSync(dir);
  assert.equal(left.length, 14);
  assert.ok(left.includes(path.basename(file)));
});
