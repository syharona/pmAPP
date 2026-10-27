import test from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { openDb } from '../src/db.js';
import { claudeExtract, extractFromEmail } from '../src/emailExtract.js';

const mail = { subject: 'CR', from: 'Paul', body: 'SECRET-CONTENU Merci de valider le budget demain' };
const ctx = { projects: [{ id: 1, code: 'CRM', name: 'CRM', aliases: '' }], meAliases: ['Moi'], today: '2026-10-27' };
const apiError = (Cls, status, message, requestId) =>
  new Cls(status, { type: 'error', error: { type: 'invalid_request_error', message } }, undefined, new Headers({ 'request-id': requestId }));
const okResponse = (data) =>
  Object.assign(
    { model: 'claude-opus-5-5', stop_reason: 'end_turn', usage: { input_tokens: 120, output_tokens: 40 }, content: [{ type: 'text', text: JSON.stringify(data) }] },
    { _request_id: 'req_ok' }
  );
const data = {
  projectCode: 'CRM',
  summary: 'Validation du budget',
  items: [{ kind: 'action', title: 'Valider le budget', projectCode: null, owner: 'moi', due: '2026-10-28', priority: 'normal', probability: null, impact: null, excerpt: 'Merci de valider le budget demain' }],
};

function fakeClient({ beta, plain }) {
  const calls = [];
  return {
    calls,
    beta: { messages: { create: async (req) => (calls.push({ kind: 'beta', req }), beta(req)) } },
    messages: { create: async (req) => (calls.push({ kind: 'plain', req }), plain(req)) },
  };
}

test('400 avec options bêta → nouvelle tentative sans elles, les deux journalisées', async () => {
  const logs = [];
  const client = fakeClient({
    beta: () => { throw apiError(Anthropic.BadRequestError, 400, 'fallbacks: Extra inputs are not permitted', 'req_400'); },
    plain: () => okResponse(data),
  });
  const res = await claudeExtract(mail, ctx, { model: 'claude-opus-5-5', client, log: (e) => logs.push(e) });
  assert.equal(res.items.length, 1);
  assert.equal(res.projectId, 1);
  assert.deepEqual(client.calls.map((c) => c.kind), ['beta', 'plain']);
  assert.equal(client.calls[0].req.fallbacks, 'default');
  assert.equal(client.calls[1].req.fallbacks, undefined);
  assert.equal(client.calls[1].req.betas, undefined);
  assert.equal(logs.length, 2);
  assert.equal(logs[0].ok, false);
  assert.equal(logs[0].status, 400);
  assert.match(logs[0].error, /fallbacks: Extra inputs/);
  assert.equal(logs[0].request_id, 'req_400');
  assert.equal(logs[1].ok, true);
  assert.equal(logs[1].request_id, 'req_ok');
  assert.equal(logs[1].input_tokens, 120);
  assert.equal(logs[1].items, 1);
  assert.ok(!JSON.stringify(logs).includes('SECRET-CONTENU')); // le contenu du mail n'est jamais journalisé
});

test('schéma : aucun type combiné, les champs facultatifs passent par anyOf', async () => {
  const client = fakeClient({ beta: () => okResponse(data), plain: () => okResponse(data) });
  await claudeExtract(mail, ctx, { model: 'm', client });
  const schema = client.calls[0].req.output_config.format.schema;
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    assert.ok(!Array.isArray(node.type), `type combiné : ${JSON.stringify(node.type)}`);
    Object.values(node).forEach(walk);
  };
  walk(schema);
  assert.deepEqual(schema.properties.projectCode.anyOf, [{ type: 'string' }, { type: 'null' }]);
});

test('401 : pas de nouvelle tentative ; repli sur l’heuristique avec le vrai message', async () => {
  const logs = [];
  const client = fakeClient({ beta: () => { throw apiError(Anthropic.AuthenticationError, 401, 'invalid x-api-key', 'req_401'); }, plain: () => okResponse(data) });
  const res = await extractFromEmail(mail, ctx, { apiKey: 'k', model: 'm', client, log: (e) => logs.push(e) });
  assert.equal(client.calls.length, 1);
  assert.equal(res.engine, 'heuristique');
  assert.match(res.warning, /HTTP 401.*invalid x-api-key/);
  assert.equal(logs.length, 1);
});

test('refus du modèle et réponse illisible : journalisés comme échecs', async () => {
  for (const [response, expected] of [
    [{ ...okResponse(data), stop_reason: 'refusal', stop_details: { category: 'cyber' } }, /refusée.*cyber/],
    [{ ...okResponse(data), content: [{ type: 'text', text: '{pas du json' }] }, /illisible/],
  ]) {
    const logs = [];
    const client = fakeClient({ beta: () => response, plain: () => response });
    await assert.rejects(claudeExtract(mail, ctx, { model: 'm', client, log: (e) => logs.push(e) }));
    assert.equal(logs.length, 1);
    assert.equal(logs[0].ok, false);
    assert.match(logs[0].error, expected);
  }
});

test('journal en base : entrées conservées, limitées à 500', () => {
  const repo = openDb(':memory:');
  for (let i = 0; i < 505; i++) repo.addAiLog({ model: 'm', attempt: 'a', ok: i % 2 === 0, status: 200 });
  const rows = repo.listAiLogs(1000);
  assert.equal(rows.length, 500);
  assert.equal(rows[0].ok, 1); // la plus récente : i = 504, un succès
  assert.equal(rows[1].ok, 0);
});
