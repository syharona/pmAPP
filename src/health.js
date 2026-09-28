// Calcul de la santé des projets et des signaux d'alerte ("vue godmode").
import { addDays, diffDays, formatShort, todayISO } from './dates.js';
import { isMe } from './parser.js';
import { computeRetro } from './retro.js';

const RAG_LABEL = { green: 'Sous contrôle', amber: 'Vigilance', red: 'Critique' };
const OPEN = (a) => a.status !== 'done' && a.status !== 'cancelled';
const RISK_OPEN = (r) => r.status === 'open' || r.status === 'mitigating';

function sqlTs(date) {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

/** Risques dont le score a augmenté sur la fenêtre (ou nouveaux et élevés). */
export function risingRisks(risks, history, now = new Date(), windowDays = 14) {
  const cutoff = sqlTs(new Date(now.getTime() - windowDays * 86400000));
  const recent = sqlTs(new Date(now.getTime() - 7 * 86400000));
  const byRisk = new Map();
  for (const h of history) {
    if (!byRisk.has(h.risk_id)) byRisk.set(h.risk_id, []);
    byRisk.get(h.risk_id).push(h);
  }
  const out = [];
  for (const r of risks.filter(RISK_OPEN)) {
    const score = r.probability * r.impact;
    const hist = byRisk.get(r.id) || [];
    const before = hist.filter((h) => h.at < cutoff);
    const baseline = before.length ? before[before.length - 1].score : hist.length ? hist[0].score : score;
    const isNew = hist.length && hist[0].at >= recent && !before.length;
    if (score > baseline) out.push({ ...r, score, from: baseline, delta: score - baseline });
    else if (isNew && score >= 12) out.push({ ...r, score, from: null, delta: score, isNew: true });
  }
  return out.sort((a, b) => b.score - a.score || b.delta - a.delta);
}

export function projectMetrics(project, { actions, risks, milestones, journal, history, retroSteps = [] }, today = todayISO(), now = new Date()) {
  const open = actions.filter(OPEN);
  const overdue = open.filter((a) => a.due_date && a.due_date < today);
  const dueSoon = open.filter((a) => a.due_date && a.due_date >= today && a.due_date <= addDays(today, 7));
  const waiting = open.filter((a) => a.status === 'waiting');
  const openRisks = risks.filter(RISK_OPEN).map((r) => ({ ...r, score: r.probability * r.impact }));
  const critical = openRisks.filter((r) => r.score >= 15);
  const high = openRisks.filter((r) => r.score >= 10 && r.score < 15);
  const rising = risingRisks(risks, history, now);
  const lateMilestones = milestones.filter((m) => !m.done && m.due_date && m.due_date < today);
  const nextMilestone = milestones.find((m) => !m.done && m.due_date && m.due_date >= today) || null;
  const changes7d = journal.filter((j) => j.kind === 'change' && j.created_at >= sqlTs(new Date(now.getTime() - 7 * 86400000)));

  const daysLeft = project.deadline ? diffDays(today, project.deadline) : null;
  let elapsedPct = null;
  if (project.start_date && project.deadline) {
    const total = diffDays(project.start_date, project.deadline);
    if (total > 0) elapsedPct = Math.max(0, Math.min(100, Math.round((diffDays(project.start_date, today) / total) * 100)));
  }
  const progress = Number(project.progress) || 0;
  const scheduleGap = elapsedPct === null ? null : elapsedPct - progress;

  // Score de santé 100 = sain. Chaque signal retire des points et est expliqué.
  const signals = [];
  let score = 100;
  const hit = (points, level, text) => {
    score -= points;
    signals.push({ level, text, points });
  };

  if (daysLeft !== null && daysLeft < 0 && progress < 100) hit(30, 'critical', `Deadline dépassée de ${-daysLeft} j (avancement ${progress} %)`);
  else if (scheduleGap !== null && scheduleGap > 35) hit(25, 'critical', `Avancement ${progress} % pour ${elapsedPct} % du temps écoulé`);
  else if (scheduleGap !== null && scheduleGap > 20) hit(15, 'warning', `Avancement ${progress} % pour ${elapsedPct} % du temps écoulé`);
  if (daysLeft !== null && daysLeft >= 0 && daysLeft <= 14 && progress < 80) hit(10, 'warning', `Deadline dans ${daysLeft} j, avancement ${progress} %`);
  if (overdue.length) hit(Math.min(32, overdue.length * 8), overdue.length >= 3 ? 'critical' : 'warning', `${overdue.length} action(s) en retard`);
  if (critical.length) hit(Math.min(30, critical.length * 15), 'critical', `${critical.length} risque(s) critique(s) ouvert(s)`);
  if (high.length) hit(Math.min(18, high.length * 6), 'warning', `${high.length} risque(s) élevé(s)`);
  if (rising.length) hit(Math.min(16, rising.length * 8), 'warning', `${rising.length} risque(s) en hausse sur 14 j`);
  if (lateMilestones.length) hit(Math.min(20, lateMilestones.length * 10), 'warning', `${lateMilestones.length} jalon(s) dépassé(s)`);
  if (changes7d.length >= 3) hit(8, 'info', `${changes7d.length} changements en 7 j (instabilité du périmètre)`);

  // Rétroplanning (projets à deadline imposée)
  const retro = retroSteps.length ? computeRetro(retroSteps, project.deadline, today, project.start_date) : null;
  if (retro && retro.buffer !== null && retro.remainingDays > 0) {
    if (retro.buffer < 0) hit(20, 'critical', `Rétroplanning : il manque ${-retro.buffer} j ouvrés pour tenir la deadline`);
    else if (retro.buffer <= 5) hit(10, 'warning', `Rétroplanning : marge de ${retro.buffer} j ouvrés seulement`);
    const late = retro.lateSteps;
    if (late.length) {
      const first = late[0];
      hit(
        Math.min(18, late.length * 6),
        late.some((st) => st.overdue) ? 'critical' : 'warning',
        `Étape « ${first.title} » ${first.overdue ? `aurait dû finir le ${formatShort(first.latest_end)}` : `aurait dû démarrer le ${formatShort(first.latest_start)}`}${late.length > 1 ? ` (+${late.length - 1} autre(s))` : ''}`
      );
    }
    // Actions rattachées aux phases
    for (const st of retro.steps) {
      const mine = open.filter((a) => a.step_id === st.id);
      st.openActions = mine.length;
      st.lateActions = mine.filter((a) => a.due_date && a.due_date < today).length;
      st.beyondActions = mine.filter((a) => a.due_date && a.due_date > st.latest_end).map((a) => a.id);
    }
    const beyond = retro.steps.flatMap((st) => st.beyondActions);
    if (beyond.length) hit(Math.min(12, beyond.length * 4), 'warning', `${beyond.length} action(s) prévue(s) après la fin au plus tard de leur phase`);
    const closedWithOpen = retro.steps.filter((st) => st.status === 'done' && st.openActions);
    if (closedWithOpen.length) signals.push({ level: 'info', text: `Phase « ${closedWithOpen[0].title} » terminée avec ${closedWithOpen[0].openActions} action(s) encore ouverte(s)`, points: 0 });
    if (retro.infeasibleBy > 0) signals.push({ level: 'info', text: `Rétroplanning démarre ${retro.infeasibleBy} j ouvrés avant la date de début du projet`, points: 0 });
  }

  score = Math.max(0, score);
  const health = score >= 75 ? 'green' : score >= 50 ? 'amber' : 'red';
  const ragOrder = { green: 0, amber: 1, red: 2 };
  const mismatch = (ragOrder[health] ?? 0) > (ragOrder[project.rag] ?? 0);
  if (mismatch) signals.push({ level: 'info', text: `Statut déclaré « ${RAG_LABEL[project.rag] || project.rag} » plus optimiste que les signaux`, points: 0 });

  return {
    health,
    score,
    signals,
    openActions: open.length,
    overdueActions: overdue.length,
    dueSoonActions: dueSoon.length,
    waitingActions: waiting.length,
    openRisks: openRisks.length,
    criticalRisks: critical.length,
    highRisks: high.length,
    risingRisks: rising,
    topRisk: openRisks.sort((a, b) => b.score - a.score)[0] || null,
    lateMilestones: lateMilestones.length,
    nextMilestone,
    changes7d: changes7d.length,
    daysLeft,
    elapsedPct,
    scheduleGap,
    retro,
  };
}

function projectData(repo, projectId) {
  const risks = repo.listRisks({ projectId });
  return {
    actions: repo.listActions({ projectId }),
    risks,
    milestones: repo.listMilestones(projectId),
    journal: repo.listJournal({ projectId, sinceDays: 30, limit: 500 }),
    history: repo.riskHistory(risks.map((r) => r.id)),
    retroSteps: repo.listRetroSteps(projectId),
  };
}

export function projectDashboard(repo, projectId, today = todayISO(), now = new Date()) {
  const project = repo.get('projects', projectId);
  if (!project) return null;
  const data = projectData(repo, projectId);
  return {
    project,
    metrics: projectMetrics(project, data, today, now),
    actions: data.actions,
    risks: data.risks,
    milestones: data.milestones,
    journal: repo.listJournal({ projectId, limit: 200 }),
  };
}

export function portfolio(repo, today = todayISO(), now = new Date()) {
  const projects = repo.listProjects().map((p) => {
    const metrics = projectMetrics(p, projectData(repo, p.id), today, now);
    return { ...p, metrics };
  });

  const me = repo.meAliases();
  const allOpen = repo.listActions({ open: true });
  const mine = allOpen.filter((a) => isMe(a.owner, me));

  const upcoming = [];
  for (const p of projects) {
    if (p.deadline && p.deadline >= today && p.deadline <= addDays(today, 60))
      upcoming.push({ date: p.deadline, type: 'deadline', title: `Deadline ${p.name}`, projectId: p.id, projectCode: p.code });
  }
  for (const m of repo.listMilestones()) {
    const p = projects.find((x) => x.id === m.project_id);
    if (p && !m.done && m.due_date && m.due_date >= addDays(today, -14) && m.due_date <= addDays(today, 60))
      upcoming.push({ date: m.due_date, type: 'milestone', title: m.title, projectId: p.id, projectCode: p.code, late: m.due_date < today });
  }
  // Démarrages au plus tard des étapes de rétroplanning non commencées
  for (const p of projects) {
    for (const st of p.metrics.retro?.steps || []) {
      if (st.status === 'todo' && st.latest_start >= addDays(today, -14) && st.latest_start <= addDays(today, 60))
        upcoming.push({ date: st.latest_start, type: 'retro', title: `Démarrer au plus tard : ${st.title}`, projectId: p.id, projectCode: p.code, late: st.latest_start < today });
    }
  }
  upcoming.sort((a, b) => a.date.localeCompare(b.date));

  const rising = projects.flatMap((p) => p.metrics.risingRisks.map((r) => ({ ...r, project_code: p.code })));

  return {
    today,
    kpis: {
      projects: projects.length,
      red: projects.filter((p) => p.metrics.health === 'red').length,
      amber: projects.filter((p) => p.metrics.health === 'amber').length,
      overdueActions: allOpen.filter((a) => a.due_date && a.due_date < today).length,
      myOverdue: mine.filter((a) => a.due_date && a.due_date < today).length,
      myToday: mine.filter((a) => a.due_date === today).length,
      criticalRisks: projects.reduce((n, p) => n + p.metrics.criticalRisks, 0),
      risingRisks: rising.length,
      deadlines14d: projects.filter((p) => p.metrics.daysLeft !== null && p.metrics.daysLeft >= 0 && p.metrics.daysLeft <= 14).length,
      inbox: repo.listActions({ projectId: null, open: true }).length + repo.listEmails().length,
    },
    projects,
    rising: rising.sort((a, b) => b.score - a.score).slice(0, 10),
    upcoming,
    recent: repo.listJournal({ limit: 15 }),
  };
}

/** Regroupe mes actions ouvertes façon ToDo. */
export function todo(repo, today = todayISO()) {
  const me = repo.meAliases();
  const open = repo.listActions({ open: true });
  const mine = open.filter((a) => isMe(a.owner, me) && a.status !== 'waiting');
  const weekEnd = addDays(today, 7);
  const groups = {
    overdue: mine.filter((a) => a.due_date && a.due_date < today),
    today: mine.filter((a) => a.due_date === today),
    week: mine.filter((a) => a.due_date && a.due_date > today && a.due_date <= weekEnd),
    later: mine.filter((a) => a.due_date && a.due_date > weekEnd),
    nodate: mine.filter((a) => !a.due_date),
  };
  // Actions déléguées / en attente : ce que je dois relancer.
  const followUp = open
    .filter((a) => a.status === 'waiting' || !isMe(a.owner, me))
    .map((a) => ({ ...a, needsNudge: Boolean(a.due_date && a.due_date <= addDays(today, 1)) }));
  const doneToday = repo
    .listActions({ status: 'done' })
    .filter((a) => isMe(a.owner, me) && a.done_at && a.done_at.slice(0, 10) === new Date().toISOString().slice(0, 10));
  return { today, groups, followUp, doneToday, load: loadByDay(mine, today) };
}

// Charge des 10 prochains jours ouvrés (nombre d'actions à échéance), pour voir si je suis "sous l'eau".
function loadByDay(actions, today) {
  const days = [];
  let d = today;
  while (days.length < 10) {
    const wd = new Date(d + 'T12:00:00').getDay();
    if (wd !== 0 && wd !== 6) days.push({ date: d, count: actions.filter((a) => a.due_date === d).length });
    d = addDays(d, 1);
  }
  const overdue = actions.filter((a) => a.due_date && a.due_date < today).length;
  if (overdue) days[0].count += overdue;
  days[0].includesOverdue = overdue;
  return days;
}
