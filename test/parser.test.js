import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCapture } from '../src/parser.js';
import { extractDate } from '../src/dates.js';

const today = '2026-09-25'; // vendredi
const projects = [
  { id: 1, code: 'CRM', name: 'Refonte CRM', aliases: 'salesforce' },
  { id: 2, code: 'ERP', name: 'Migration ERP', aliases: 'sap' },
];

test('dates relatives en français', () => {
  const cases = {
    demain: '2026-09-26',
    "aujourd'hui": '2026-09-25',
    lundi: '2026-09-28',
    vendredi: '2026-10-02',
    'fin de semaine': '2026-10-02',
    'fin du mois': '2026-09-30',
    '+3j': '2026-09-28',
    '+2s': '2026-10-09',
    'dans 3 jours': '2026-09-28',
    '12/10': '2026-10-12',
    '12 octobre': '2026-10-12',
    '2026-11-03': '2026-11-03',
    '15/01': '2027-01-15',
  };
  for (const [txt, expected] of Object.entries(cases)) {
    assert.equal(extractDate(`faire un truc ${txt}`, today).date, expected, txt);
  }
  assert.equal(extractDate('version 2.1 du livrable', today).date, null);
  assert.equal(extractDate('rendu avant le 12/10 stp', today).text, 'rendu stp');
  // "le" à l'intérieur d'un mot n'est pas un mot de liaison
  assert.equal(extractDate('répéter la bascule jeudi', today).text, 'répéter la bascule');
});

test('action complète', () => {
  const r = parseCapture('#CRM @Paul envoyer le planning révisé vendredi !', { projects, today });
  assert.equal(r.kind, 'action');
  assert.equal(r.projectId, 1);
  assert.equal(r.owner, 'Paul');
  assert.equal(r.due, '2026-10-02');
  assert.equal(r.priority, 'high');
  assert.equal(r.title, 'Envoyer le planning révisé');
});

test('action pour moi par défaut, projet deviné par alias', () => {
  const r = parseCapture('relancer le support salesforce demain', { projects, today });
  assert.equal(r.owner, 'moi');
  assert.equal(r.projectId, 1);
});

test('@alias = moi', () => {
  const r = parseCapture('#ERP @sarah préparer le copil', { projects, today, meAliases: ['Sarah'] });
  assert.equal(r.owner, 'moi');
});

test('risque avec probabilité / impact', () => {
  const r = parseCapture('r: #ERP fournisseur en retard p4 i5', { projects, today });
  assert.equal(r.kind, 'risk');
  assert.equal(r.probability, 4);
  assert.equal(r.impact, 5);
  assert.equal(r.title, 'Fournisseur en retard');
});

test('en attente, changement, tag inconnu', () => {
  const w = parseCapture('w: #ERP @Sophie retour juridique 12/10', { projects, today });
  assert.equal(w.status, 'waiting');
  assert.equal(w.owner, 'Sophie');
  const c = parseCapture('c: #CRM go-live décalé', { projects, today });
  assert.equal(c.kind, 'change');
  const u = parseCapture('#XYZ truc à faire', { projects, today });
  assert.equal(u.projectId, null);
  assert.equal(u.unknownTag, 'XYZ');
});
