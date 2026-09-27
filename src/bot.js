// Logique conversationnelle commune à Telegram et WhatsApp.
// Chaque message texte = une capture. Les commandes /xxx donnent des vues rapides.
import { captureContext, deleteItem, moveItem, saveItem } from './capture.js';
import { addDays, formatShort, todayISO } from './dates.js';
import { heuristicExtract } from './emailExtract.js';
import { HELP_TEXT, parseCapture } from './parser.js';
import { portfolio, projectDashboard, todo } from './health.js';
import { renderText, reportContent } from './report.js';

const KIND_LABEL = { action: 'Action', risk: 'Risque', change: 'Changement', decision: 'Décision', note: 'Note' };
const PRIO = { critical: '🔴 ', high: '🟠 ', normal: '', low: '' };
const HEALTH = { green: '🟢', amber: '🟠', red: '🔴' };

function line(a, today) {
  const late = a.due_date && a.due_date < today ? '⚠️ ' : '';
  const due = a.due_date ? ` — ${formatShort(a.due_date)}` : '';
  const proj = a.project_code ? `[${a.project_code}] ` : '';
  const owner = a.owner && a.owner !== 'moi' ? ` (@${a.owner})` : '';
  return `${late}${PRIO[a.priority] || ''}#${a.id} ${proj}${a.title}${owner}${due}`;
}

function describe(kind, item, repo) {
  const p = item.project_id ? repo.get('projects', item.project_id) : null;
  const parts = [`✅ ${KIND_LABEL[kind] || kind} #${item.id} enregistrée`];
  parts.push(`« ${item.title || item.text} »`);
  parts.push(`📁 ${p ? `${p.code} — ${p.name}` : 'Inbox (sans projet)'}`);
  if (kind === 'action') {
    parts.push(`👤 ${item.owner === 'moi' ? 'Moi' : item.owner}${item.status === 'waiting' ? ' (en attente / à relancer)' : ''}`);
    if (item.due_date) parts.push(`📅 ${formatShort(item.due_date)}`);
    if (item.priority !== 'normal') parts.push(`⚡ ${item.priority}`);
  }
  if (kind === 'risk') parts.push(`🎯 P${item.probability} × I${item.impact} = ${item.probability * item.impact}`);
  return parts.join('\n');
}

function projectButtons(repo, kind, id) {
  const projects = repo.listProjects().slice(0, 12);
  const rows = [];
  for (let i = 0; i < projects.length; i += 3) {
    rows.push(projects.slice(i, i + 3).map((p) => ({ text: p.code, data: `mv:${kind}:${id}:${p.id}` })));
  }
  rows.push([{ text: '📥 Laisser en inbox', data: `ok:${kind}:${id}` }, { text: '↩️ Annuler', data: `del:${kind}:${id}` }]);
  return rows;
}

function listReply(title, actions, today, empty = 'Rien 🎉') {
  if (!actions.length) return `${title}\n${empty}`;
  return `${title}\n${actions.slice(0, 25).map((a) => line(a, today)).join('\n')}${actions.length > 25 ? `\n… +${actions.length - 25}` : ''}`;
}

/**
 * @returns {{text: string, buttons?: Array<Array<{text:string,data:string}>>}}
 */
export function handleText(repo, rawText, { channel = 'telegram', ref = '' } = {}) {
  const text = String(rawText || '').trim();
  const today = todayISO();
  if (!text) return { text: 'Message vide.' };

  if (text.startsWith('/')) {
    const [cmdRaw, ...args] = text.split(/\s+/);
    const cmd = cmdRaw.slice(1).split('@')[0].toLowerCase();
    const arg = args.join(' ');
    switch (cmd) {
      case 'start':
      case 'aide':
      case 'help':
        return { text: HELP_TEXT + '\n\nCommandes : /todo /retard /semaine /attente /projets /inbox /fait <n°> /report <n°> <date> /p <CODE> /rapport <CODE>' };
      case 'todo':
      case 'jour': {
        const t = todo(repo, today);
        return {
          text: [
            listReply('⚠️ En retard', t.groups.overdue, today, '—'),
            listReply("📌 Aujourd'hui", t.groups.today, today, '—'),
            `\n${t.groups.week.length} cette semaine · ${t.groups.nodate.length} sans date · ${t.followUp.filter((a) => a.needsNudge).length} relance(s) à faire`,
          ].join('\n\n'),
        };
      }
      case 'retard': {
        const late = repo.listActions({ open: true }).filter((a) => a.due_date && a.due_date < today);
        return { text: listReply('⚠️ Actions en retard (tous porteurs)', late, today) };
      }
      case 'semaine': {
        const t = todo(repo, today);
        return { text: listReply('🗓️ Mes 7 prochains jours', [...t.groups.overdue, ...t.groups.today, ...t.groups.week], today) };
      }
      case 'attente':
      case 'relances': {
        const t = todo(repo, today);
        return { text: listReply('⏳ À relancer / en attente', t.followUp, today) };
      }
      case 'projets': {
        const pf = portfolio(repo, today);
        if (!pf.projects.length) return { text: 'Aucun projet. Crée-les depuis l\'app web.' };
        return {
          text:
            '📊 Portefeuille\n' +
            pf.projects
              .map((p) => `${HEALTH[p.metrics.health]} ${p.code} — ${p.name} · ${p.metrics.daysLeft ?? '?'} j · ${p.metrics.overdueActions} retard · ${p.metrics.criticalRisks} risque(s) crit.`)
              .join('\n'),
        };
      }
      case 'p':
      case 'projet': {
        const pf = portfolio(repo, today);
        const p = pf.projects.find((x) => x.code.toLowerCase() === arg.toLowerCase());
        if (!p) return { text: `Projet inconnu : ${arg || '(vide)'}` };
        const m = p.metrics;
        return {
          text: `${HEALTH[m.health]} ${p.code} — ${p.name}\nSanté ${m.score}/100 · deadline ${p.deadline ? formatShort(p.deadline) : '?'} (${m.daysLeft ?? '?'} j) · avancement ${p.progress} %\n${m.signals.map((s) => '• ' + s.text).join('\n') || '• RAS'}`,
        };
      }
      case 'rapport':
      case 'statut': {
        const p = repo.listProjects().find((x) => x.code.toLowerCase() === arg.toLowerCase());
        if (!p) return { text: `Usage : /rapport <CODE> (ex. /rapport CRM)` };
        const d = projectDashboard(repo, p.id, today);
        return { text: renderText(reportContent(d, { meName: repo.getSettings().me_name, today })) };
      }
      case 'inbox': {
        const inbox = repo.listActions({ projectId: null, open: true });
        return { text: listReply('📥 Inbox (sans projet)', inbox, today) };
      }
      case 'fait':
      case 'done': {
        const id = Number(arg.replace('#', ''));
        const a = id && repo.get('actions', id);
        if (!a) return { text: `Action introuvable : ${arg}` };
        repo.updateAction(id, { status: 'done' });
        return { text: `✔️ #${id} terminée : ${a.title}` };
      }
      case 'report': {
        const [idRaw, ...rest] = args;
        const id = Number(String(idRaw || '').replace('#', ''));
        const a = id && repo.get('actions', id);
        if (!a) return { text: 'Usage : /report <n°> <date> (ex. /report 12 lundi)' };
        const parsed = parseCapture(rest.join(' ') || '+1j', { today });
        const due = parsed.due || addDays(today, 1);
        repo.updateAction(id, { due_date: due });
        return { text: `📅 #${id} reportée au ${formatShort(due)}` };
      }
      default:
        return { text: `Commande inconnue. /aide pour la liste.` };
    }
  }

  // Long texte collé / transféré (ex. un mail partagé depuis Outlook mobile) → file "Mails".
  if (/^(mail|email)\s*:/i.test(text) || text.length > 400) {
    const body = text.replace(/^(mail|email)\s*:\s*/i, '');
    const email = repo.insert('emails', { subject: body.split('\n')[0].slice(0, 120), sender: '', body, source: channel });
    const ext = heuristicExtract({ body }, captureContext(repo));
    const counts = ext.items.reduce((acc, i) => ((acc[i.kind] = (acc[i.kind] || 0) + 1), acc), {});
    const summary = Object.entries(counts).map(([k, n]) => `${n} ${KIND_LABEL[k].toLowerCase()}(s)`).join(', ') || 'aucun élément détecté';
    return {
      text: `📧 Mail reçu (${summary}).\nÀ valider dans l'app, onglet « Mails ».\n${ext.items.slice(0, 5).map((i) => `• ${KIND_LABEL[i.kind]} : ${i.title}`).join('\n')}`,
      buttons: ext.items.length ? [[{ text: '➕ Tout ajouter maintenant', data: `mail:${email.id}` }]] : undefined,
    };
  }

  const ctx = captureContext(repo);
  const parsed = parseCapture(text, ctx);
  if (!parsed.title) return { text: 'Je n\'ai pas compris le contenu. /aide' };
  const { kind, item } = saveItem(repo, parsed, { source: channel, sourceRef: ref });
  let reply = describe(kind, item, repo);
  if (parsed.unknownTag) reply += `\n❓ Projet « #${parsed.unknownTag} » inconnu`;
  const buttons = item.project_id
    ? [[{ text: '↩️ Annuler', data: `del:${kind}:${item.id}` }, ...(kind === 'action' ? [{ text: '✔️ Fait', data: `done:action:${item.id}` }] : [])]]
    : projectButtons(repo, kind, item.id);
  if (!item.project_id) reply += '\n\n👇 Choisis le projet :';
  return { text: reply, buttons };
}

export function handleCallback(repo, data, { channel = 'telegram' } = {}) {
  const [op, kind, idRaw, extra] = String(data).split(':');
  const id = Number(idRaw);
  if (op === 'mv') {
    const item = moveItem(repo, kind, id, Number(extra));
    if (!item) return { text: 'Élément introuvable.' };
    return { text: describe(kind, item, repo), buttons: [[{ text: '↩️ Annuler', data: `del:${kind}:${id}` }]] };
  }
  if (op === 'ok') return { text: '📥 Laissé dans l\'inbox — à trier depuis l\'app.' };
  if (op === 'del') return { text: deleteItem(repo, kind, id) ? '🗑️ Annulé.' : 'Déjà supprimé.' };
  if (op === 'done') {
    const a = repo.updateAction(id, { status: 'done' });
    return { text: a ? `✔️ #${id} terminée : ${a.title}` : 'Action introuvable.' };
  }
  if (op === 'mail') {
    const mailId = Number(kind);
    const email = repo.get('emails', mailId);
    if (!email || email.status !== 'pending') return { text: 'Mail déjà traité.' };
    const ext = heuristicExtract({ subject: email.subject, from: email.sender, body: email.body }, captureContext(repo));
    for (const it of ext.items) saveItem(repo, it, { source: channel, sourceRef: `mail:${mailId}` });
    repo.update('emails', mailId, { status: 'processed' });
    return { text: `➕ ${ext.items.length} élément(s) ajouté(s) depuis le mail.` };
  }
  return { text: 'Action inconnue.' };
}
