// Parseur de capture rapide : une ligne de texte libre → un élément structuré.
//
//   "#CRM @Paul envoyer le planning révisé vendredi !"
//   → action, projet CRM, porteur Paul, échéance vendredi, priorité haute
//
// Préfixes de type (optionnels, en début de message) :
//   r: / risque:        → risque          (ex. "r: #ERP fournisseur en retard p4 i5")
//   c: / chgt:          → changement      (journal)
//   d: / décision:      → décision        (journal)
//   n: / note:          → note            (journal)
//   w: / attente:       → action déléguée "en attente de" (à relancer)
//   (rien) / a: / todo: → action
import { extractDate, fold, todayISO } from './dates.js';

export const ME = 'moi';

const KIND_PREFIXES = [
  { re: /^(?:r|risque|risk)\s*[:>]\s*/i, kind: 'risk' },
  { re: /^(?:c|chgt|changement|change|modif)\s*[:>]\s*/i, kind: 'change' },
  { re: /^(?:d|decision|décision)\s*[:>]\s*/i, kind: 'decision' },
  { re: /^(?:n|note|info|i)\s*[:>]\s*/i, kind: 'note' },
  { re: /^(?:w|attente|wait|relance)\s*[:>]\s*/i, kind: 'waiting' },
  { re: /^(?:a|action|todo|t)\s*[:>]\s*/i, kind: 'action' },
];

const PRIORITY_TOKENS = [
  { re: /(?:^|\s)(?:!!+|!urgent|!critique|!crit)(?=\s|$)/i, priority: 'critical' },
  { re: /(?:^|\s)(?:!haute|!high|!important|!)(?=\s|$)/i, priority: 'high' },
  { re: /(?:^|\s)(?:!basse|!low|!bas)(?=\s|$)/i, priority: 'low' },
];

const norm = (s) => fold(String(s || '')).replace(/[^a-z0-9]/g, '');

export function projectKeys(p) {
  return [p.code, p.name, ...String(p.aliases || '').split(',')]
    .map(norm)
    .filter((k) => k.length >= 2);
}

export function findProjectByTag(tag, projects) {
  const t = norm(tag);
  if (!t) return null;
  return (
    projects.find((p) => norm(p.code) === t) ||
    projects.find((p) => projectKeys(p).includes(t)) ||
    projects.find((p) => norm(p.name).startsWith(t) && t.length >= 3) ||
    null
  );
}

// Devine le projet à partir des mots du texte (code, nom ou alias cités tels quels).
export function guessProject(text, projects) {
  const words = new Set(fold(text).split(/[^a-z0-9]+/).filter(Boolean));
  const flat = norm(text);
  const hits = projects.filter((p) =>
    projectKeys(p).some((k) => words.has(k) || (k.length >= 5 && flat.includes(k)))
  );
  return hits.length === 1 ? hits[0] : null;
}

export function isMe(owner, meAliases = []) {
  if (!owner) return false;
  const o = norm(owner);
  return ['moi', 'me', 'je', ME].includes(o) || meAliases.map(norm).includes(o);
}

function tidy(s) {
  const t = s.replace(/\s{2,}/g, ' ').replace(/^[\s,;:.\-–]+|[\s,;:\-–]+$/g, '').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

/**
 * @param {string} input
 * @param {{projects?: Array, today?: string, meAliases?: string[]}} ctx
 */
export function parseCapture(input, ctx = {}) {
  const { projects = [], today = todayISO(), meAliases = [] } = ctx;
  let text = String(input || '').replace(/\s+/g, ' ').trim();
  const result = {
    kind: 'action',
    title: '',
    projectId: null,
    projectCode: null,
    unknownTag: null,
    owner: null,
    due: null,
    priority: 'normal',
    status: 'todo',
    probability: null,
    impact: null,
  };

  for (const { re, kind } of KIND_PREFIXES) {
    if (re.test(text)) {
      result.kind = kind;
      text = text.replace(re, '');
      break;
    }
  }

  // #projet
  text = text.replace(/(?:^|\s)#([\p{L}\p{N}_\-.]+)/gu, (all, tag) => {
    if (result.projectId) return ' ';
    const p = findProjectByTag(tag, projects);
    if (p) {
      result.projectId = p.id;
      result.projectCode = p.code;
    } else {
      result.unknownTag = tag;
    }
    return ' ';
  });

  // @porteur
  text = text.replace(/(?:^|\s)@([\p{L}\p{N}_\-.]+)/gu, (all, who) => {
    if (!result.owner) result.owner = isMe(who, meAliases) ? ME : who;
    return ' ';
  });

  // !priorité
  for (const { re, priority } of PRIORITY_TOKENS) {
    if (re.test(text)) {
      result.priority = priority;
      text = text.replace(re, ' ');
      break;
    }
  }

  // Probabilité / impact d'un risque : "p4 i5", "4x5", "P3/I4"
  const pi =
    text.match(/(?:^|\s)p([1-5])\s*[/ ]?\s*i([1-5])(?=\s|$)/i) ||
    text.match(/(?:^|\s)([1-5])\s*[x×*]\s*([1-5])(?=\s|$)/i);
  if (pi) {
    result.probability = Number(pi[1]);
    result.impact = Number(pi[2]);
    text = text.replace(pi[0], ' ');
  }

  const { date, text: rest } = extractDate(text, today);
  result.due = date;
  text = rest;

  if (!result.projectId) {
    const g = guessProject(text, projects);
    if (g) {
      result.projectId = g.id;
      result.projectCode = g.code;
    }
  }

  if (result.kind === 'waiting') {
    result.kind = 'action';
    result.status = 'waiting';
  }
  if (result.kind === 'action' && !result.owner) result.owner = ME;
  if (result.kind === 'risk') {
    result.probability ??= result.priority === 'critical' ? 4 : 3;
    result.impact ??= result.priority === 'critical' ? 5 : result.priority === 'high' ? 4 : 3;
  }

  result.title = tidy(text);
  return result;
}

export const HELP_TEXT = `Capture rapide — écris naturellement :
• Action : "#CRM relancer Paul sur le budget vendredi"
• Pour quelqu'un : "#CRM @Paul envoyer le planning demain !"
• En attente de : "w: #ERP @Sophie retour juridique 12/10"
• Risque : "r: #ERP fournisseur en retard p4 i5"
• Changement : "c: #CRM go-live décalé au 15/11"
• Décision / note : "d: ..." / "n: ..."
Dates : aujourd'hui, demain, lundi…, fin de semaine, fin du mois, +3j, +2s, 12/10, 12 octobre
Priorité : ! (haute), !! (critique), !basse`;
