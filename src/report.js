// Export du statut d'un projet : rapport HTML autonome (à envoyer, ou à imprimer
// en PDF) et résumé texte à coller dans Teams / Outlook / Telegram.
import { addDays, diffDays, formatShort, todayISO } from './dates.js';

const RAG = { green: 'Sous contrôle', amber: 'Vigilance', red: 'Critique' };
const RAG_EMOJI = { green: '🟢', amber: '🟠', red: '🔴' };
const PRIO = { critical: 'Critique', high: 'Haute', normal: 'Normale', low: 'Basse' };
const STATUS = { todo: 'À faire', doing: 'En cours', waiting: 'En attente', done: 'Fait', cancelled: 'Annulé' };
const STEP_STATUS = { todo: 'À venir', doing: 'En cours', done: 'Terminée' };
const KIND = { change: 'Changement', decision: 'Décision', note: 'Note', risk: 'Risque' };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Sélectionne ce qui compte pour un lecteur externe (sponsor, comité). */
export function reportContent(d, { meName = 'Moi', today = todayISO() } = {}) {
  const open = d.actions.filter((a) => a.status !== 'done' && a.status !== 'cancelled');
  const who = (a) => (a.owner === 'moi' ? meName : a.owner);
  return {
    project: d.project,
    metrics: d.metrics,
    today,
    overdue: open.filter((a) => a.due_date && a.due_date < today).map((a) => ({ ...a, who: who(a) })),
    upcoming: open.filter((a) => a.due_date && a.due_date >= today && a.due_date <= addDays(today, 14)).map((a) => ({ ...a, who: who(a) })),
    risks: d.risks.filter((r) => r.status === 'open' || r.status === 'mitigating').slice(0, 8),
    milestones: d.milestones,
    decisions: d.journal.filter((j) => ['change', 'decision'].includes(j.kind) && j.created_at >= `${addDays(today, -30)}`).slice(0, 12),
    retro: d.metrics.retro,
  };
}

export function renderText(c) {
  const p = c.project;
  const m = c.metrics;
  const lines = [];
  lines.push(`${RAG_EMOJI[m.health]} ${p.code} — ${p.name} · statut au ${formatShort(c.today)}`);
  lines.push(`Santé : ${RAG[m.health]} (${m.score}/100) · déclaré : ${RAG[p.rag] || p.rag}`);
  const dl = p.deadline ? `${formatShort(p.deadline)} (${m.daysLeft < 0 ? `dépassée de ${-m.daysLeft} j` : `J-${m.daysLeft}`})` : 'non fixée';
  lines.push(`Deadline : ${dl} · avancement ${p.progress} %${m.elapsedPct !== null ? ` pour ${m.elapsedPct} % du temps écoulé` : ''}`);
  if (p.status_note) lines.push('', `Message clé : ${p.status_note}`);
  if (c.retro && c.retro.remainingDays) {
    lines.push('', `Rétroplanning : ${c.retro.remainingDays} j ouvrés de travail restant pour ${c.retro.availableDays} disponibles → ${c.retro.buffer >= 0 ? `marge ${c.retro.buffer} j` : `manque ${-c.retro.buffer} j`}`);
    if (c.retro.nextStep) lines.push(`Étape en cours / suivante : ${c.retro.nextStep.title} (démarrage au plus tard ${formatShort(c.retro.nextStep.latest_start)})`);
  }
  const signals = m.signals.filter((s) => s.level !== 'info');
  if (signals.length) lines.push('', 'Points d’attention :', ...signals.map((s) => `• ${s.text}`));
  if (c.risks.length) lines.push('', 'Principaux risques :', ...c.risks.slice(0, 5).map((r) => `• [${r.probability * r.impact}] ${r.title}${r.mitigation ? ` → ${r.mitigation}` : ''}`));
  if (c.overdue.length) lines.push('', 'Actions en retard :', ...c.overdue.map((a) => `• ${a.title}${a.step_title ? ` [${a.step_title}]` : ''} — ${a.who}, prévu ${formatShort(a.due_date)}`));
  if (c.upcoming.length) lines.push('', 'Prochaines échéances (14 j) :', ...c.upcoming.map((a) => `• ${formatShort(a.due_date)} — ${a.title}${a.step_title ? ` [${a.step_title}]` : ''} (${a.who})`));
  const nextMs = c.milestones.filter((ms) => !ms.done && ms.due_date).slice(0, 3);
  if (nextMs.length) lines.push('', 'Jalons :', ...nextMs.map((ms) => `• ${formatShort(ms.due_date)} — ${ms.title}`));
  if (c.decisions.length) lines.push('', 'Décisions & changements (30 j) :', ...c.decisions.slice(0, 6).map((j) => `• ${KIND[j.kind] || j.kind} : ${j.text}`));
  return lines.join('\n');
}

function gantt(retro, today) {
  const steps = retro.steps;
  const from = [steps[0].latest_start, today].sort()[0];
  const to = [retro.deadline, today].sort()[1];
  const span = Math.max(1, diffDays(from, to) + 1);
  const x = (iso) => (diffDays(from, iso) / span) * 100;
  const rows = steps
    .map((s) => {
      const left = x(s.latest_start);
      const width = Math.max(0.8, x(addDays(s.latest_end, 1)) - left);
      const cls = s.status === 'done' ? 'done' : s.late || s.overdue ? 'late' : s.status === 'doing' ? 'doing' : 'todo';
      return `<div class="g-row"><div class="g-label">${esc(s.title)}<small>${formatShort(s.latest_start)} → ${formatShort(s.latest_end)} · ${s.duration_days} j · ${STEP_STATUS[s.status] || s.status}${s.owner ? ` · ${esc(s.owner)}` : ''}${s.openActions ? ` · ${s.openActions} action(s) ouverte(s)${s.lateActions ? `, <span class="crit">${s.lateActions} en retard</span>` : ''}` : ''}</small></div>
        <div class="g-track"><i class="g-bar ${cls}" style="left:${left}%;width:${width}%"></i></div></div>`;
    })
    .join('');
  const todayLine = today >= from && today <= to ? `<b class="g-today" style="left:${x(today)}%"><span>Aujourd'hui</span></b>` : '';
  return `<div class="gantt"><div class="g-lines"><div></div><div class="g-overlay">${todayLine}<b class="g-deadline" style="left:${x(addDays(retro.deadline, 1))}%"><span>Deadline ${formatShort(retro.deadline)}</span></b></div></div>${rows}</div>`;
}

export function renderHtml(c) {
  const p = c.project;
  const m = c.metrics;
  const table = (head, rows) => (rows.length ? `<table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>` : '<p class="muted">—</p>');
  const actionRows = (list) => list.map((a) => `<tr><td>${esc(a.title)}${a.step_title ? `<br><small class="muted">▸ ${esc(a.step_title)}</small>` : ''}</td><td>${esc(a.who)}</td><td class="nw">${formatShort(a.due_date)}</td><td>${PRIO[a.priority]}</td><td>${STATUS[a.status]}</td></tr>`);
  const r = c.retro;

  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Statut ${esc(p.code)} — ${formatShort(c.today)}</title>
<style>
  :root { --ink:#0b0b0b; --ink2:#52514e; --muted:#6f6d68; --grid:#e1e0d9; --accent:#256abf; --soft:#cde2fb; --good:#0ca30c; --warn:#fab219; --crit:#d03b3b; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #f9f9f7; color: var(--ink); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 960px; margin: 0 auto; padding: 28px 24px 40px; background: #fff; }
  h1 { font-size: 22px; margin: 4px 0 2px; } h2 { font-size: 15px; margin: 26px 0 8px; padding-bottom: 4px; border-bottom: 1px solid var(--grid); }
  .muted { color: var(--muted); } .nw { white-space: nowrap; }
  .tag { display:inline-block; font-size:12px; font-weight:700; padding:1px 7px; border-radius:4px; background:var(--soft); color:var(--accent); }
  .badge { display:inline-flex; gap:6px; align-items:center; padding:2px 10px; border-radius:999px; background:#f3f2ef; font-weight:600; font-size:13px; }
  .dot { width:9px; height:9px; border-radius:50%; } .green .dot{background:var(--good)} .amber .dot{background:var(--warn)} .red .dot{background:var(--crit)}
  .kpis { display:grid; grid-template-columns:repeat(4,1fr); gap:10px; margin-top:16px; }
  .kpi { border:1px solid var(--grid); border-radius:8px; padding:10px 12px; } .kpi b { display:block; font-size:22px; } .kpi span { color:var(--ink2); font-size:12px; }
  .note { margin-top:16px; padding:12px 14px; border-left:4px solid var(--accent); background:#f3f7fd; }
  table { width:100%; border-collapse:collapse; } th { text-align:left; font-size:12px; color:var(--ink2); border-bottom:1px solid #c3c2b7; padding:5px 6px; } td { padding:6px; border-bottom:1px solid var(--grid); vertical-align:top; }
  ul.sig { padding-left:18px; margin:0; } ul.sig li { margin:2px 0; } .crit { color:#b02a2a; font-weight:600; }
  .gantt { position:relative; padding-top:18px; } .g-row, .g-lines { display:grid; grid-template-columns: 38% 62%; align-items:center; }
  .g-row { border-bottom:1px solid var(--grid); padding:5px 0; } .g-label small { display:block; color:var(--muted); font-size:11px; }
  .g-track { position:relative; height:14px; background:#f3f2ef; border-radius:4px; }
  .g-bar { position:absolute; top:0; bottom:0; border-radius:4px; } .g-bar.todo { background:var(--soft); box-shadow:inset 0 0 0 1px var(--accent); } .g-bar.doing { background:var(--accent); } .g-bar.done { background:#c3c2b7; } .g-bar.late { background:var(--crit); }
  .g-lines { position:absolute; inset:0; pointer-events:none; } .g-overlay { position:relative; height:100%; }
  .g-today, .g-deadline { position:absolute; top:0; bottom:0; width:0; border-left:2px dashed var(--ink); } .g-deadline { border-left:2px solid var(--crit); }
  .g-today span, .g-deadline span { position:absolute; top:0; left:4px; font-size:10px; white-space:nowrap; background:#fff; } .g-deadline span { color:#b02a2a; right:4px; left:auto; }
  .legend { font-size:11px; color:var(--muted); margin-top:6px; }
  .printbar { background:#0b0b0b; color:#fff; padding:8px 16px; font-size:13px; text-align:center; }
  footer { margin-top:30px; font-size:11px; color:var(--muted); }
  @media (max-width: 640px) { .kpis { grid-template-columns:repeat(2,1fr); } .g-row, .g-lines { grid-template-columns: 1fr; } .g-lines { display:none; } }
  @media print { body { background:#fff; } .printbar { display:none; } main { padding:0; } h2 { break-after: avoid; } tr, .g-row { break-inside: avoid; } }
</style></head>
<body>
<div class="printbar">Statut généré le ${formatShort(c.today)} — Ctrl+P / Cmd+P pour l’enregistrer en PDF</div>
<main>
  <div><span class="tag">${esc(p.code)}</span>${p.ttm ? ' <span class="tag">Deadline imposée</span>' : ''}</div>
  <h1>${esc(p.name)}</h1>
  <div class="muted">${esc(p.phase || '')}${p.sponsor ? ` · Sponsor : ${esc(p.sponsor)}` : ''} · Statut au ${formatShort(c.today)}</div>
  <div style="margin-top:10px"><span class="badge ${m.health}"><span class="dot"></span>Santé calculée : ${RAG[m.health]} · ${m.score}/100</span>
  <span class="badge ${esc(p.rag)}"><span class="dot"></span>Statut déclaré : ${RAG[p.rag] || esc(p.rag)}</span></div>
  ${p.status_note ? `<div class="note"><b>Message clé</b><br>${esc(p.status_note).replace(/\n/g, '<br>')}</div>` : ''}
  <div class="kpis">
    <div class="kpi"><b>${p.deadline ? formatShort(p.deadline) : '—'}</b><span>Deadline${m.daysLeft !== null ? ` · ${m.daysLeft < 0 ? `dépassée de ${-m.daysLeft} j` : `J-${m.daysLeft}`}` : ''}</span></div>
    <div class="kpi"><b>${p.progress} %</b><span>Avancement${m.elapsedPct !== null ? ` · ${m.elapsedPct} % du temps écoulé` : ''}</span></div>
    <div class="kpi"><b>${m.openActions}</b><span>Actions ouvertes · ${m.overdueActions} en retard</span></div>
    <div class="kpi"><b>${m.openRisks}</b><span>Risques ouverts · ${m.criticalRisks} critique(s)</span></div>
  </div>

  ${m.signals.length ? `<h2>Points d’attention</h2><ul class="sig">${m.signals.map((s) => `<li class="${s.level === 'critical' ? 'crit' : ''}">${esc(s.text)}</li>`).join('')}</ul>` : ''}

  ${
    r && r.steps.length && r.deadline
      ? `<h2>Rétroplanning</h2>
    <p>${r.remainingDays} j ouvrés de travail restant pour ${r.availableDays} j ouvrés disponibles d’ici la deadline → <b class="${r.buffer < 0 ? 'crit' : ''}">${r.buffer >= 0 ? `marge de ${r.buffer} j` : `il manque ${-r.buffer} j`}</b>.</p>
    ${gantt(r, c.today)}
    <div class="legend">Dates au plus tard calculées à rebours depuis la deadline, en jours ouvrés (week-ends et jours fériés exclus). Rouge = étape en retard sur son démarrage ou sa fin au plus tard.</div>`
      : ''
  }

  <h2>Jalons</h2>
  ${table(['Jalon', 'Date', 'État'], c.milestones.map((ms) => `<tr><td>${esc(ms.title)}</td><td class="nw">${formatShort(ms.due_date)}</td><td>${ms.done ? 'Atteint' : ms.due_date && ms.due_date < c.today ? '<span class="crit">Dépassé</span>' : 'À venir'}</td></tr>`))}

  <h2>Risques ouverts</h2>
  ${table(['Score', 'Risque', 'P × I', 'Mitigation'], c.risks.map((x) => `<tr><td><b>${x.probability * x.impact}</b></td><td>${esc(x.title)}</td><td class="nw">${x.probability} × ${x.impact}</td><td>${esc(x.mitigation)}</td></tr>`))}

  <h2>Actions en retard</h2>
  ${table(['Action', 'Porteur', 'Prévue', 'Priorité', 'Statut'], actionRows(c.overdue))}

  <h2>Prochaines échéances (14 jours)</h2>
  ${table(['Action', 'Porteur', 'Échéance', 'Priorité', 'Statut'], actionRows(c.upcoming))}

  <h2>Décisions et changements (30 jours)</h2>
  ${table(['Date', 'Type', 'Description'], c.decisions.map((j) => `<tr><td class="nw">${esc(j.created_at.slice(8, 10))}/${esc(j.created_at.slice(5, 7))}</td><td>${KIND[j.kind] || esc(j.kind)}</td><td>${esc(j.text)}</td></tr>`))}

  <footer>Généré par PM Cockpit le ${formatShort(c.today)}. Santé calculée à partir des retards, risques, jalons, du rétroplanning et de l’écart avancement / temps écoulé.</footer>
</main></body></html>`;
}

