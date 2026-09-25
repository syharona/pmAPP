// Mail → actions / risques / changements.
// Deux moteurs : une heuristique locale (toujours disponible, aucune donnée ne sort
// du poste) et, si ANTHROPIC_API_KEY est configurée, une extraction par Claude.
import { extractDate, fold, todayISO } from './dates.js';
import { guessProject, isMe, ME } from './parser.js';

const has = (f, words) => words.some((w) => f.includes(w));

const ACTION_CUES = [
  'merci de ', "merci d'", 'pourrais-tu', 'pourrais tu', 'pourriez-vous', 'pourriez vous', 'peux-tu', 'peux tu',
  'pouvez-vous', 'pouvez vous', 'il faut ', 'il faudrait', 'a faire', 'action :', 'action:', 'todo', 'to do',
  'je vais ', "je m'occupe", 'je me charge', 'nous devons', 'vous devez', 'tu dois', ' doit ', ' devra ', ' devront ',
  'please', 'could you', 'can you', 'need to', 'action item', 'en charge de', 'a prevoir', 'penser a ',
];
const ACTION_VERBS = [
  'relancer', 'envoyer', 'valider', 'preparer', 'organiser', 'planifier', 'mettre a jour', 'verifier', 'confirmer',
  'transmettre', 'faire un point', 'revenir vers', 'caler', 'partager', 'rediger', 'finaliser', 'contacter', 'appeler',
  'livrer', 'produire', 'completer', 'corriger', 'analyser', 'chiffrer', 'estimer', 'lancer', 'fournir', 'signer',
  'send', 'review', 'update', 'check', 'prepare', 'schedule', 'share', 'follow up',
];
const RISK_CUES = [
  'risque', 'retard', 'bloquant', 'bloque', 'blocage', 'alerte', 'inquiet', 'inquietude', 'derive', 'depassement',
  'pas en mesure', 'impossible', 'menace', 'escalade', 'escalader', 'tension', 'penurie', 'indisponib', 'risk', 'delay',
  'blocker', 'at risk', 'critique',
];
const CHANGE_CUES = [
  'changement', 'modification', 'desormais', 'decale', 'reporte', 'report ', 'avance au', 'nouveau perimetre',
  'hors perimetre', 'ajout ', 'supprime', 'remplace', 'nouvelle date', 'change request', 'nouvelle version',
  'repousse', 'glisse', 'change de', 'est modifie',
];
const DECISION_CUES = ['decide', 'decision', 'acte ', 'arbitrage', 'arbitre', 'go pour', 'no go', 'valide par', 'nous retenons'];
const URGENT_CUES = ['urgent', 'asap', 'au plus vite', 'imperatif', 'rapidement', 'sans faute', 'des que possible'];
const ME_CUES = ['merci de', "merci d'", 'pourrais-tu', 'pourrais tu', 'pourriez-vous', 'pourriez vous', 'peux-tu', 'peux tu',
  'pouvez-vous', 'pouvez vous', 'tu dois', 'vous devez', 'could you', 'can you', 'please'];
const SELF_CUES = ['je vais ', "je m'occupe", 'je me charge', 'je reviens vers', "je t'envoie", 'je vous envoie', 'je te transmets'];
const SKIP_RE = /^(bonjour|hello|salut|hi|coucou|bonsoir|cher|chère|merci( beaucoup| par avance| d'avance)?[ ,.!]*$|bonne (journée|soirée|semaine)|cordialement|bien à (toi|vous)|best|regards|à bientôt|@\S+\s*$)/i;

function senderName(from) {
  if (!from) return '';
  const m = String(from).match(/^\s*"?([^"<]+?)"?\s*</);
  if (m) return m[1].trim();
  if (from.includes('@')) {
    const local = from.split('@')[0].replace(/[._-]+/g, ' ');
    return local.replace(/\b\w/g, (c) => c.toUpperCase()).trim();
  }
  return from.trim();
}

// Retire l'historique cité et la signature.
export function cleanBody(body) {
  let text = String(body || '').replace(/\r\n/g, '\n');
  const sep = /^(?:-{2,}\s*(?:original message|message d'origine|message transféré|forwarded message)[\s\S]*?$|(?:de|from)\s*:\s.+$|le .+ a écrit\s*:$|on .+ wrote:$|_{5,})/im;
  const m = text.match(sep);
  if (m && m.index > 0 && text.slice(0, m.index).replace(/\s/g, '').length > 40) text = text.slice(0, m.index);
  else if (m) {
    // Mail transféré sans commentaire : on garde le contenu mais on retire les en-têtes.
    text = text.replace(/^(?:de|from|envoyé|sent|à|to|cc|objet|subject|date)\s*:.*$/gim, '');
  }
  const sig = text.search(/^\s*(?:--\s*$|cordialement|bien (?:à|a) (?:vous|toi)|bien cordialement|best regards|regards,|sent from my|envoyé de mon)/im);
  if (sig > 0) text = text.slice(0, sig);
  return text
    .split('\n')
    .filter((l) => !l.trim().startsWith('>'))
    .join('\n')
    .trim();
}

function units(text) {
  const out = [];
  let section = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const f = fold(line);
    if (/^[^a-z0-9]*(actions?|prochaines? etapes?|next steps?|a faire|todo|to do|suite a donner|plan d'action)\b[^.]*:?\s*$/.test(f)) {
      section = 'action';
      continue;
    }
    if (/^[^a-z0-9]*(risques?|points? d'attention|alertes?|risks?)\s*:?\s*$/.test(f)) {
      section = 'risk';
      continue;
    }
    const bullet = /^\s*(?:[-*•▪◦–]|\d+[.)]|\[ ?\])\s+/.test(raw);
    if (bullet) {
      out.push({ text: line.replace(/^(?:[-*•▪◦–]|\d+[.)]|\[ ?\])\s+/, ''), section, bullet: true });
      continue;
    }
    if (line.endsWith(':')) section = '';
    for (const s of line.split(/(?<=[.!?])\s+(?=[A-ZÀ-Ý])/)) out.push({ text: s.trim(), section: '', bullet: false });
  }
  return out;
}

function cleanTitle(s) {
  let t = s
    .replace(/^(?:merci (?:de|d')|pourrais[- ]tu|pourriez[- ]vous|peux[- ]tu|pouvez[- ]vous|est-ce que tu peux|est-ce que vous pouvez|il faut(?:drait)?(?: que)?|please|could you|can you|je vais|je me charge de|action\s*:|todo\s*:|a faire\s*:|à faire\s*:)\s*/i, '')
    .replace(/\s*(?:stp|svp|s'il te plaît|s'il vous plaît|merci|please|thanks)\s*[.!?]*\s*$/i, '')
    .replace(/[?!.;:,\s]+$/, '')
    .trim();
  if (t.length > 160) t = t.slice(0, 157).replace(/\s+\S*$/, '') + '…';
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

function detectOwner(unit, f, sender, meAliases) {
  const at = unit.match(/@([\p{L}\-.]+)/u);
  if (at) return isMe(at[1], meAliases) ? ME : at[1];
  const named = unit.match(/^([A-ZÀ-Ý][\p{L}\-]+(?:\s[A-ZÀ-Ý][\p{L}\-]+)?)\s*(?::|–|-|\(|doit|va |devra|se charge|s'occupe)/u);
  if (named && !/^(Action|Todo|Merci|Il|Nous|Vous|Je|Tu|On|Le|La|Les|Pour|Point|Risque)$/i.test(named[1].split(' ')[0])) {
    return isMe(named[1], meAliases) ? ME : named[1];
  }
  if (has(f, SELF_CUES)) return sender || 'expéditeur';
  if (has(f, ME_CUES)) return ME;
  for (const alias of meAliases) if (alias && f.includes(fold(alias)) && alias.length > 2) return ME;
  return null;
}

/**
 * Extraction heuristique.
 * @returns {{projectId:number|null, items:Array}}
 */
export function heuristicExtract({ subject = '', from = '', body = '' }, ctx = {}) {
  const { projects = [], meAliases = [], today = todayISO() } = ctx;
  const sender = senderName(from);
  const cleaned = cleanBody(body);
  const mailProject = guessProject(subject, projects) || guessProject(cleaned, projects);
  const items = [];
  const seen = new Set();

  for (const u of units(cleaned)) {
    if (u.text.length < 8 || SKIP_RE.test(u.text)) continue;
    const f = ' ' + fold(u.text) + ' ';
    const firstWord = f.trim().split(/\s+/)[0];
    const startsWithVerb = ACTION_VERBS.some((v) => f.trim().startsWith(v)) || /^[a-z]+(er|ir|re)$/.test(firstWord) && u.bullet;

    let kind = null;
    let confidence = 0;
    if (u.section === 'action' || has(f, ACTION_CUES) || (u.bullet && startsWithVerb)) {
      kind = 'action';
      confidence = u.section === 'action' ? 0.9 : has(f, ACTION_CUES) ? 0.75 : 0.6;
    }
    if (u.section === 'risk' || (has(f, RISK_CUES) && !has(f, ['sans risque', 'aucun risque', 'pas de risque']))) {
      if (!kind || !has(f, ACTION_CUES)) {
        kind = 'risk';
        confidence = u.section === 'risk' ? 0.85 : 0.6;
      }
    }
    if (!kind && has(f, CHANGE_CUES)) {
      kind = 'change';
      confidence = 0.6;
    }
    if (!kind && has(f, DECISION_CUES)) {
      kind = 'decision';
      confidence = 0.55;
    }
    if (!kind && startsWithVerb && extractDate(u.text, today).date) {
      kind = 'action';
      confidence = 0.5;
    }
    if (!kind) continue;

    const { date, text: withoutDate } = extractDate(u.text, today);
    const owner = kind === 'action' ? detectOwner(u.text, f, sender, meAliases) : null;
    let base = kind === 'action' ? withoutDate : u.text;
    if (owner && owner !== ME) base = base.replace(new RegExp(`^@?${owner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:–-]\\s*`, 'i'), '');
    const title = cleanTitle(base.replace(/^(?:point d'attention|attention|alerte|risque)\s*:\s*/i, ''));
    const key = fold(title);
    if (!title || title.length < 5 || seen.has(key)) continue;
    seen.add(key);

    const urgent = has(f, URGENT_CUES);
    const itemProject = mailProject || guessProject(u.text, projects);
    const item = {
      kind,
      title,
      projectId: itemProject ? itemProject.id : null,
      confidence,
      excerpt: u.text,
    };
    if (kind === 'action') {
      item.owner = owner || ME;
      item.due = date;
      item.priority = urgent ? 'high' : 'normal';
      item.status = item.owner === ME ? 'todo' : 'waiting';
    }
    if (kind === 'risk') {
      const severe = has(f, ['bloquant', 'blocage', 'critique', 'impossible', 'escalade', 'blocker']);
      item.probability = severe ? 4 : 3;
      item.impact = severe || urgent ? 4 : 3;
    }
    items.push(item);
  }

  return { engine: 'heuristique', projectId: mailProject ? mailProject.id : null, items };
}

// ---------------------------------------------------------------- Claude

const ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    projectCode: { type: ['string', 'null'], description: 'Code du projet principal du mail, ou null' },
    summary: { type: 'string', description: 'Résumé du mail en une phrase' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['action', 'risk', 'change', 'decision'] },
          title: { type: 'string', description: 'Formulation courte et actionnable, commençant par un verbe pour une action' },
          projectCode: { type: ['string', 'null'] },
          owner: { type: ['string', 'null'], description: '"moi" si l\'utilisateur doit agir, sinon le prénom/nom du porteur' },
          due: { type: ['string', 'null'], description: 'Échéance AAAA-MM-JJ ou null' },
          priority: { type: 'string', enum: ['low', 'normal', 'high', 'critical'] },
          probability: { type: ['integer', 'null'], description: 'Risque uniquement : probabilité 1-5' },
          impact: { type: ['integer', 'null'], description: 'Risque uniquement : impact 1-5' },
          excerpt: { type: 'string', description: 'Phrase du mail justifiant l\'élément' },
        },
        required: ['kind', 'title', 'projectCode', 'owner', 'due', 'priority', 'probability', 'impact', 'excerpt'],
      },
    },
  },
  required: ['projectCode', 'summary', 'items'],
};

let clientPromise;
async function getClient(apiKey) {
  clientPromise ??= import('@anthropic-ai/sdk')
    .then(({ default: Anthropic }) => new Anthropic({ apiKey }))
    .catch(() => null);
  return clientPromise;
}

export async function claudeExtract(mail, ctx, { apiKey, model }) {
  const client = await getClient(apiKey);
  if (!client) throw new Error('SDK @anthropic-ai/sdk non installé (npm install)');
  const { projects = [], meAliases = [], today = todayISO() } = ctx;
  const projectList = projects.map((p) => `- ${p.code} : ${p.name}${p.aliases ? ` (alias : ${p.aliases})` : ''}`).join('\n');

  const response = await client.beta.messages.create({
    model,
    max_tokens: 8000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: ITEM_SCHEMA } },
    system:
      `Tu aides un chef de projet / Scrum Master à transformer ses mails en éléments de suivi. ` +
      `L'utilisateur s'appelle ${meAliases[0] || 'Moi'} (alias : ${meAliases.join(', ') || 'aucun'}). ` +
      `Extrais uniquement les actions concrètes (qui fait quoi, pour quand), les risques, les changements et les décisions ` +
      `présents dans le mail ; ignore les politesses et l'historique cité. owner = "moi" quand c'est à l'utilisateur d'agir. ` +
      `Les dates relatives se calculent à partir d'aujourd'hui : ${today}. ` +
      `Projets connus :\n${projectList || '(aucun)'}`,
    messages: [
      {
        role: 'user',
        content: `De : ${mail.from || ''}\nObjet : ${mail.subject || ''}\n\n${mail.body || ''}`,
      },
    ],
  });

  if (response.stop_reason === 'refusal') throw new Error('Extraction refusée par le modèle');
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const data = JSON.parse(text);
  const byCode = (code) => (code ? projects.find((p) => p.code.toLowerCase() === String(code).toLowerCase()) : null);
  const mailProject = byCode(data.projectCode);
  return {
    engine: 'claude',
    summary: data.summary,
    projectId: mailProject ? mailProject.id : null,
    items: data.items.map((it) => {
      const p = byCode(it.projectCode) || mailProject;
      const owner = it.owner && isMe(it.owner, meAliases) ? ME : it.owner;
      return {
        kind: it.kind,
        title: it.title,
        projectId: p ? p.id : null,
        owner: it.kind === 'action' ? owner || ME : owner,
        due: it.due,
        priority: it.priority,
        status: it.kind === 'action' && owner && owner !== ME ? 'waiting' : 'todo',
        probability: it.probability,
        impact: it.impact,
        excerpt: it.excerpt,
        confidence: 0.9,
      };
    }),
  };
}

export async function extractFromEmail(mail, ctx, anthropic = {}) {
  if (anthropic.apiKey && !anthropic.disabled) {
    try {
      return await claudeExtract(mail, ctx, anthropic);
    } catch (err) {
      const res = heuristicExtract(mail, ctx);
      res.warning = `Extraction IA indisponible (${String(err.status || err.message).slice(0, 120)}) — heuristique utilisée.`;
      return res;
    }
  }
  return heuristicExtract(mail, ctx);
}
