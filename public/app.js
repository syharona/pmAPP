// PM Cockpit — interface web (vanilla JS, aucune dépendance).
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const view = $('#view');

const state = { projects: [], settings: null };

// ------------------------------------------------------------------ utils
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && !url.startsWith('/api/login')) {
    renderLogin();
    throw new Error('auth');
  }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const pad = (n) => String(n).padStart(2, '0');
const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => toISO(new Date());
const parseISO = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const daysBetween = (a, b) => Math.round((parseISO(b) - parseISO(a)) / 86400000);
const DAYS = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'];
function fmtDate(iso) {
  if (!iso) return '';
  const d = parseISO(iso);
  return `${DAYS[d.getDay()]} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
}
function relDate(iso) {
  if (!iso) return '<span class="muted">—</span>';
  const n = daysBetween(today(), iso);
  const label = n === 0 ? "aujourd'hui" : n === 1 ? 'demain' : n === -1 ? 'hier' : n < 0 ? `il y a ${-n} j` : n < 7 ? fmtDate(iso) : `${fmtDate(iso)}`;
  return `<span class="${n < 0 ? 'late' : ''}" title="${esc(iso)}">${n < 0 ? '⚠ ' : ''}${esc(label)}</span>`;
}
function fmtTs(ts) {
  if (!ts) return '';
  const d = new Date(ts.replace(' ', 'T') + (ts.includes('Z') || ts.includes('+') ? '' : 'Z'));
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const senderName = (s) => String(s || '').replace(/\s*<[^>]*>\s*/, '').trim();
const RAG = { green: 'Sous contrôle', amber: 'Vigilance', red: 'Critique' };
const ragBadge = (rag, extra = '') => `<span class="badge st-${esc(rag)}"><span class="dot"></span>${RAG[rag] || esc(rag)}${extra}</span>`;
const PRIO_LABEL = { critical: 'Critique', high: 'Haute', normal: 'Normale', low: 'Basse' };
const STATUS_LABEL = { todo: 'À faire', doing: 'En cours', waiting: 'En attente', done: 'Fait', cancelled: 'Annulé' };
const RISK_STATUS = { open: 'Ouvert', mitigating: 'En traitement', closed: 'Clos', occurred: 'Survenu' };
const KIND_LABEL = { action: 'Action', risk: 'Risque', change: 'Changement', decision: 'Décision', note: 'Note', system: 'Système' };
const SOURCE_ICON = { telegram: '✈︎', whatsapp: '☏', email: '✉', web: '', api: '⚙', ingest: '✉' };
const scoreCls = (s) => (s >= 15 ? 's-crit' : s >= 10 ? 's-high' : 's-mid');
const projTag = (code, id) => (code ? `<a class="tag" href="#/p/${id}">${esc(code)}</a>` : '<span class="tag" style="opacity:.6">INBOX</span>');
const ownerLabel = (o) => (o === 'moi' ? 'Moi' : esc(o || '—'));
const options = (map, sel) => Object.entries(map).map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${v}</option>`).join('');
const projectOptions = (sel, withNone = true) =>
  (withNone ? `<option value="">— Inbox (sans projet) —</option>` : '') +
  state.projects.map((p) => `<option value="${p.id}" ${Number(sel) === p.id ? 'selected' : ''}>${esc(p.code)} — ${esc(p.name)}</option>`).join('');

let toastTimer;
function toast(msg, undo) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button type="button">Annuler</button>' : ''}`;
  if (undo) $('button', el).onclick = async () => {
    el.classList.remove('show');
    await undo();
    route();
  };
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), undo ? 6000 : 3000);
}

function modal(title, body, { submit = 'Enregistrer', onSubmit, extra = '' } = {}) {
  const dlg = $('#modal');
  dlg.innerHTML = `<form method="dialog">
    <div class="m-head"><h2>${esc(title)}</h2><button class="btn ghost" type="button" data-close aria-label="Fermer">✕</button></div>
    <div class="m-body">${body}</div>
    <div class="m-foot">${extra}<span class="spacer"></span><button class="btn" type="button" data-close>Annuler</button>${onSubmit ? `<button class="btn primary" value="ok">${esc(submit)}</button>` : ''}</div>
  </form>`;
  const form = $('form', dlg);
  $$('[data-close]', dlg).forEach((b) => b.addEventListener('click', () => dlg.close()));
  form.addEventListener('submit', async (e) => {
    if (e.submitter?.value !== 'ok' || !onSubmit) return;
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    try {
      await onSubmit(data, form);
      dlg.close();
      route();
    } catch (err) {
      if (err.message !== 'auth') toast(err.message);
    }
  });
  dlg.showModal();
  $('input, select, textarea', dlg)?.focus();
  return dlg;
}

async function loadProjects() {
  state.projects = await api('GET', '/api/projects');
}

// ------------------------------------------------------------ capture bar
const capInput = $('#capture-input');
const capPreview = $('#capture-preview');
let previewTimer;
capInput.addEventListener('input', () => {
  clearTimeout(previewTimer);
  const text = capInput.value.trim();
  if (!text) return (capPreview.innerHTML = '');
  previewTimer = setTimeout(async () => {
    const p = await api('POST', '/api/capture/preview', { text }).catch(() => null);
    if (!p || capInput.value.trim() !== text) return;
    const proj = state.projects.find((x) => x.id === p.projectId);
    const chips = [
      `<span class="chip"><b>${KIND_LABEL[p.kind]}${p.status === 'waiting' ? ' (en attente)' : ''}</b></span>`,
      `<span class="chip ${proj ? '' : 'warn'}">📁 ${proj ? esc(proj.code) : p.unknownTag ? `#${esc(p.unknownTag)} inconnu → Inbox` : 'Inbox'}</span>`,
      p.kind === 'action' ? `<span class="chip">👤 ${ownerLabel(p.owner)}</span>` : '',
      p.due ? `<span class="chip">📅 ${fmtDate(p.due)}</span>` : '',
      p.priority !== 'normal' ? `<span class="chip">⚡ ${PRIO_LABEL[p.priority]}</span>` : '',
      p.kind === 'risk' ? `<span class="chip">🎯 P${p.probability}×I${p.impact} = ${p.probability * p.impact}</span>` : '',
      `<span class="chip">« ${esc(p.title)} »</span>`,
    ];
    capPreview.innerHTML = chips.join('');
  }, 150);
});
capInput.addEventListener('blur', () => setTimeout(() => (capPreview.innerHTML = ''), 200));
$('#capture').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = capInput.value.trim();
  if (!text) return;
  try {
    const r = await api('POST', '/api/capture', { text });
    capInput.value = '';
    capPreview.innerHTML = '';
    const proj = state.projects.find((x) => x.id === r.item.project_id);
    toast(`${KIND_LABEL[r.kind]} ajouté(e) → ${proj ? proj.code : 'Inbox'}`, () => api('POST', '/api/items/delete', { kind: r.kind, id: r.item.id }));
    route();
  } catch (err) {
    if (err.message !== 'auth') toast(err.message);
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) && !$('#modal').open) {
    e.preventDefault();
    capInput.focus();
  }
});

// ---------------------------------------------------------- action modals
function actionForm(a = {}) {
  return `<div class="form">
    <label class="full">Action<input name="title" required value="${esc(a.title)}"></label>
    <label>Projet<select name="project_id">${projectOptions(a.project_id)}</select></label>
    <label>Porteur<input name="owner" value="${esc(a.owner ?? 'moi')}" placeholder="moi, Paul…"></label>
    <label>Échéance<input type="date" name="due_date" value="${esc(a.due_date || '')}"></label>
    <label>Priorité<select name="priority">${options(PRIO_LABEL, a.priority || 'normal')}</select></label>
    <label>Statut<select name="status">${options(STATUS_LABEL, a.status || 'todo')}</select></label>
    <label class="full">Détails<textarea name="details" rows="3">${esc(a.details)}</textarea></label>
    ${a.id ? `<div class="full small muted">Créée ${fmtTs(a.created_at)} via ${esc(a.source)}${a.source_ref ? ` (${esc(a.source_ref)})` : ''}</div>` : ''}
  </div>`;
}
function editAction(a) {
  modal(a.id ? `Action #${a.id}` : 'Nouvelle action', actionForm(a), {
    extra: a.id ? '<button class="btn danger" value="delete" type="button" id="del-action">Supprimer</button>' : '',
    onSubmit: (data) => (a.id ? api('PATCH', `/api/actions/${a.id}`, data) : api('POST', '/api/actions', data)),
  });
  $('#del-action')?.addEventListener('click', async () => {
    if (!confirm('Supprimer cette action ?')) return;
    await api('DELETE', `/api/actions/${a.id}`);
    $('#modal').close();
    route();
  });
}
function riskForm(r = {}) {
  const sel = (name, v) => `<select name="${name}">${[1, 2, 3, 4, 5].map((n) => `<option ${n === (v || 3) ? 'selected' : ''}>${n}</option>`).join('')}</select>`;
  return `<div class="form">
    <label class="full">Risque<input name="title" required value="${esc(r.title)}"></label>
    <label>Projet<select name="project_id">${projectOptions(r.project_id)}</select></label>
    <label>Statut<select name="status">${options(RISK_STATUS, r.status || 'open')}</select></label>
    <label>Probabilité (1-5)${sel('probability', r.probability)}</label>
    <label>Impact (1-5)${sel('impact', r.impact)}</label>
    <label>Porteur<input name="owner" value="${esc(r.owner)}"></label>
    <label class="full">Plan de mitigation<textarea name="mitigation" rows="2">${esc(r.mitigation)}</textarea></label>
    <label class="full">Description<textarea name="description" rows="2">${esc(r.description)}</textarea></label>
  </div>`;
}
function editRisk(r) {
  modal(r.id ? `Risque #${r.id}` : 'Nouveau risque', riskForm(r), {
    extra: r.id ? '<button class="btn danger" type="button" id="del-risk">Supprimer</button>' : '',
    onSubmit: (data) => (r.id ? api('PATCH', `/api/risks/${r.id}`, data) : api('POST', '/api/risks', data)),
  });
  $('#del-risk')?.addEventListener('click', async () => {
    if (!confirm('Supprimer ce risque ?')) return;
    await api('DELETE', `/api/risks/${r.id}`);
    $('#modal').close();
    route();
  });
}
function projectForm(p = {}) {
  return `<div class="form">
    <label>Code (tag #)<input name="code" required value="${esc(p.code)}" placeholder="CRM" maxlength="16"></label>
    <label>Nom<input name="name" required value="${esc(p.name)}"></label>
    <label class="full">Alias / mots-clés (séparés par des virgules — servent à reconnaître le projet dans les mails)<input name="aliases" value="${esc(p.aliases)}" placeholder="salesforce, crm"></label>
    <label>Sponsor<input name="sponsor" value="${esc(p.sponsor)}"></label>
    <label>Phase<input name="phase" value="${esc(p.phase)}" placeholder="Cadrage, Build, Recette…"></label>
    <label>Début<input type="date" name="start_date" value="${esc(p.start_date || '')}"></label>
    <label>Deadline<input type="date" name="deadline" value="${esc(p.deadline || '')}"></label>
    <label>Statut déclaré<select name="rag">${options(RAG, p.rag || 'green')}</select></label>
    <label>Avancement (%)<input type="number" min="0" max="100" name="progress" value="${esc(p.progress ?? 0)}"></label>
    <label class="full check-label"><input type="checkbox" name="ttm" ${p.ttm ? 'checked' : ''}> Deadline imposée (TTM) : planifier à rebours depuis la deadline (rétroplanning)</label>
    <label class="full">Message clé pour le reporting (repris dans l'export du statut)<textarea name="status_note" rows="2" placeholder="Ex. Go-live maintenu au 07/10, recette sous tension : arbitrage attendu en COPIL">${esc(p.status_note)}</textarea></label>
    <label class="full">Description<textarea name="description" rows="2">${esc(p.description)}</textarea></label>
  </div>`;
}
function editProject(p = {}) {
  modal(p.id ? `Projet ${p.code}` : 'Nouveau projet', projectForm(p), {
    extra: p.id ? '<button class="btn danger" type="button" id="archive-project">Archiver</button>' : '',
    onSubmit: async (data) => {
      data.progress = Number(data.progress) || 0;
      data.ttm = data.ttm ? 1 : 0;
      const saved = p.id ? await api('PATCH', `/api/projects/${p.id}`, data) : await api('POST', '/api/projects', data);
      await loadProjects();
      if (!p.id) location.hash = `#/p/${saved.id}`;
    },
  });
  $('#archive-project')?.addEventListener('click', async () => {
    if (!confirm(`Archiver ${p.code} ?`)) return;
    await api('DELETE', `/api/projects/${p.id}`);
    $('#modal').close();
    await loadProjects();
    location.hash = '#/';
  });
}

async function setStatus(id, status) {
  await api('PATCH', `/api/actions/${id}`, { status });
  if (status === 'done') toast('Action terminée ✔', () => api('PATCH', `/api/actions/${id}`, { status: 'todo' }));
  route();
}

// Délégation globale des clics sur les éléments data-act
const handlers = {};
view.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || !view.contains(el)) return;
  const fn = handlers[el.dataset.act];
  if (!fn) return;
  e.preventDefault();
  try {
    await fn(el, e);
  } catch (err) {
    if (err.message !== 'auth') toast(err.message);
  }
});
view.addEventListener('change', async (e) => {
  const el = e.target.closest('[data-change]');
  if (!el) return;
  try {
    await handlers[el.dataset.change](el, e);
  } catch (err) {
    if (err.message !== 'auth') toast(err.message);
  }
});
const cache = { actions: new Map(), risks: new Map() };
const remember = (kind, rows) => rows.forEach((r) => cache[kind].set(r.id, r));

handlers['edit-action'] = (el) => editAction(cache.actions.get(Number(el.dataset.id)) || {});
handlers['new-action'] = (el) => editAction({ project_id: el.dataset.project ? Number(el.dataset.project) : null });
handlers['done'] = (el) => setStatus(el.dataset.id, 'done');
handlers['reopen'] = (el) => setStatus(el.dataset.id, 'todo');
handlers['snooze'] = async (el) => {
  const a = await api('POST', `/api/actions/${el.dataset.id}/snooze`, { days: Number(el.dataset.days) });
  toast(`Reportée au ${fmtDate(a.due_date)}`);
  route();
};
handlers['edit-risk'] = (el) => editRisk(cache.risks.get(Number(el.dataset.id)) || {});
handlers['new-risk'] = (el) => editRisk({ project_id: el.dataset.project ? Number(el.dataset.project) : null });
handlers['new-project'] = () => editProject();
handlers['goto'] = (el) => (location.hash = el.dataset.href);
handlers['action-status'] = async (el) => {
  await api('PATCH', `/api/actions/${el.dataset.id}`, { status: el.value });
  route();
};
handlers['assign'] = async (el) => {
  await api('POST', '/api/items/move', { kind: el.dataset.kind, id: Number(el.dataset.id), project_id: el.value || null });
  toast('Projet assigné');
  route();
};
handlers['del-item'] = async (el) => {
  await api('POST', '/api/items/delete', { kind: el.dataset.kind, id: Number(el.dataset.id) });
  route();
};

// ----------------------------------------------------------------- views
function kpi(label, value, sub = '', href = '', bad = false) {
  const tag = href ? 'a' : 'div';
  return `<${tag} class="kpi ${bad ? 'bad' : ''}" ${href ? `href="${href}"` : ''}><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></${tag}>`;
}

function progressBar(progress, elapsed) {
  const title = `Avancement ${progress} %${elapsed !== null ? ` — temps écoulé ${elapsed} %` : ''}`;
  return `<div class="prog" title="${esc(title)}" role="img" aria-label="${esc(title)}"><i style="width:${Math.max(0, Math.min(100, progress))}%"></i>${elapsed !== null ? `<b style="left:calc(${elapsed}% - 1px)"></b>` : ''}</div>`;
}

let sortKey = 'score';
async function renderHome() {
  const pf = await api('GET', '/api/portfolio');
  const k = pf.kpis;
  const sorters = {
    score: (a, b) => a.metrics.score - b.metrics.score,
    deadline: (a, b) => (a.deadline || '9999').localeCompare(b.deadline || '9999'),
    code: (a, b) => a.code.localeCompare(b.code),
  };
  const projects = [...pf.projects].sort(sorters[sortKey]);
  handlers['sort'] = (el) => {
    sortKey = el.dataset.key;
    renderHome();
  };

  const rows = projects
    .map((p) => {
      const m = p.metrics;
      const decl = p.rag !== m.health ? `<div class="small muted">déclaré : ${RAG[p.rag]}</div>` : '';
      return `<tr class="clickable" data-act="goto" data-href="#/p/${p.id}">
        <td><span class="tag">${esc(p.code)}</span>${p.ttm ? '<div><span class="tag ttm" title="Deadline imposée">TTM</span></div>' : ''}</td>
        <td class="title"><b>${esc(p.name)}</b><div class="small muted">${esc(p.phase || '')}${p.sponsor ? ' · ' + esc(p.sponsor) : ''}</div></td>
        <td>${ragBadge(m.health, ` <span class="num">${m.score}</span>`)}${decl}</td>
        <td class="num nw">${p.deadline ? `${fmtDate(p.deadline)}<div class="small ${m.daysLeft < 0 ? 'late' : 'muted'}">${m.daysLeft < 0 ? `dépassée de ${-m.daysLeft} j` : `J-${m.daysLeft}`}</div>${m.retro && m.retro.remainingDays ? `<div class="small ${m.retro.buffer < 0 ? 'late' : m.retro.buffer <= 5 ? 'prio-high' : 'muted'}">marge ${m.retro.buffer} j</div>` : ''}` : '<span class="muted">—</span>'}</td>
        <td>${progressBar(p.progress, m.elapsedPct)}<div class="small muted num">${p.progress} %${m.elapsedPct !== null ? ` / ${m.elapsedPct} % du temps` : ''}</div></td>
        <td class="num nw">${m.openActions} ouvertes${m.overdueActions ? `<div class="small late">${m.overdueActions} en retard</div>` : ''}${m.waitingActions ? `<div class="small muted">${m.waitingActions} en attente</div>` : ''}</td>
        <td class="num nw">${m.openRisks} ouverts${m.criticalRisks ? `<div class="small late">${m.criticalRisks} critique(s)</div>` : ''}${m.risingRisks.length ? `<div class="small late">↗ ${m.risingRisks.length} en hausse</div>` : ''}</td>
        <td class="small">${m.nextMilestone ? `${esc(m.nextMilestone.title)}<div class="muted">${fmtDate(m.nextMilestone.due_date)}</div>` : '<span class="muted">—</span>'}</td>
      </tr>`;
    })
    .join('');

  const alertProjects = [...pf.projects].sort((a, b) => a.metrics.score - b.metrics.score).filter((p) => p.metrics.signals.length);
  const icon = (lvl) => `<span class="alert-ic ${lvl}" aria-label="${lvl}">${lvl === 'critical' ? '●' : lvl === 'warning' ? '▲' : 'i'}</span>`;
  const alerts = alertProjects
    .map(
      (p) => `<li><div class="grow"><div class="row"><a class="tag" href="#/p/${p.id}">${esc(p.code)}</a>${ragBadge(p.metrics.health, ` <span class="num">${p.metrics.score}</span>`)}</div>
      <ul class="sig">${p.metrics.signals.map((s) => `<li>${icon(s.level)}<span>${esc(s.text)}</span></li>`).join('')}</ul></div></li>`
    )
    .join('');

  const rising = pf.rising
    .map(
      (r) => `<li><span class="score ${scoreCls(r.score)}">${r.score}</span><div class="grow">${projTag(r.project_code, r.project_id)} ${esc(r.title)}
        <div class="small muted">${r.isNew ? 'nouveau risque' : `score ${r.from} → ${r.score}`}</div></div></li>`
    )
    .join('');

  let lastWeek = '';
  const upcoming = pf.upcoming
    .map((u) => {
      const d = parseISO(u.date);
      const monday = new Date(d);
      monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      const wk = `Semaine du ${pad(monday.getDate())}/${pad(monday.getMonth() + 1)}`;
      const head = wk !== lastWeek ? `<div class="tl-week">${wk}</div>` : '';
      lastWeek = wk;
      return `${head}<div class="row small" style="padding:3px 0"><span class="num ${u.late ? 'late' : ''}" style="min-width:76px">${fmtDate(u.date)}</span><a class="tag" href="#/p/${u.projectId}">${esc(u.projectCode)}</a><span>${u.type === 'deadline' ? '🏁 ' : u.type === 'retro' ? '▶ ' : '◆ '}${esc(u.title)}${u.late ? ' <span class="late">(en retard)</span>' : ''}</span></div>`;
    })
    .join('');

  const feed = pf.recent.map(feedItem).join('');

  view.innerHTML = `
    <div class="page-head"><h1>Portefeuille</h1><div class="row"><button class="btn" data-act="new-action">+ Action</button><button class="btn primary" data-act="new-project">+ Projet</button></div></div>
    <section class="kpis">
      ${kpi('Projets actifs', k.projects, `${k.red} critique(s) · ${k.amber} en vigilance`, '', k.red > 0)}
      ${kpi('Actions en retard', k.overdueActions, `dont ${k.myOverdue} à moi`, '#/todo', k.overdueActions > 0)}
      ${kpi("Mes actions aujourd'hui", k.myToday, 'voir ma ToDo', '#/todo')}
      ${kpi('Risques critiques', k.criticalRisks, `${k.risingRisks} en hausse sur 14 j`, '', k.criticalRisks > 0)}
      ${kpi('Deadlines ≤ 14 j', k.deadlines14d, 'projets concernés')}
      ${kpi('À trier', k.inbox, 'inbox + mails', '#/inbox', k.inbox > 0)}
    </section>
    <div class="stack">
      <section class="card">
        <header><h2>Vue godmode</h2><div class="seg" role="group" aria-label="Tri">
          ${[['score', 'Santé'], ['deadline', 'Deadline'], ['code', 'Code']].map(([key, l]) => `<button data-act="sort" data-key="${key}" class="${sortKey === key ? 'on' : ''}">${l}</button>`).join('')}
        </div></header>
        <div class="table-wrap">${
          projects.length
            ? `<table class="table"><thead><tr><th></th><th>Projet</th><th>Santé calculée</th><th>Deadline</th><th>Avancement <span class="muted" title="la barre verticale = temps écoulé">│ temps</span></th><th>Actions</th><th>Risques</th><th>Prochain jalon</th></tr></thead><tbody>${rows}</tbody></table>`
            : `<div class="empty">Aucun projet. <a href="#" data-act="new-project">Créer le premier projet</a> ou lancer <code>npm run seed</code> pour une démo.</div>`
        }</div>
      </section>
      <div class="grid cols-3">
        <section class="card"><header><h2>Alertes</h2><span class="small muted">calculées, par projet</span></header><ul class="list">${alerts || '<li class="empty">Aucune alerte 🎉</li>'}</ul></section>
        <section class="card"><header><h2>Risques qui montent</h2><span class="small muted">14 derniers jours</span></header><ul class="list">${rising || '<li class="empty">Aucun risque en hausse.</li>'}</ul></section>
        <section class="card"><header><h2>Échéances à venir</h2><span class="small muted">60 j</span></header>${upcoming || '<div class="empty">Aucune échéance.</div>'}</section>
      </div>
      <section class="card"><header><h2>Derniers mouvements</h2><a href="#/journal" class="small">Tout le journal →</a></header><ul class="list">${feed || '<li class="empty">Rien pour l’instant.</li>'}</ul></section>
    </div>`;
}

function feedItem(j) {
  return `<li><span class="feed-kind">${KIND_LABEL[j.kind] || esc(j.kind)}</span><div class="grow">${j.project_code ? `<a class="tag" href="#/p/${j.project_id}">${esc(j.project_code)}</a> ` : ''}${esc(j.text)}</div><span class="small muted num" title="${esc(j.source)}">${SOURCE_ICON[j.source] || ''} ${fmtTs(j.created_at)}</span></li>`;
}

function actionRow(a, { showProject = false } = {}) {
  const done = a.status === 'done' || a.status === 'cancelled';
  return `<tr class="${done ? 'done' : ''}">
    <td><button class="check" title="${done ? 'Rouvrir' : 'Marquer fait'}" aria-label="${done ? 'Rouvrir' : 'Marquer fait'}" data-act="${done ? 'reopen' : 'done'}" data-id="${a.id}">${done ? '✓' : ''}</button></td>
    ${showProject ? `<td>${projTag(a.project_code, a.project_id)}</td>` : ''}
    <td class="title"><a href="#" class="t" data-act="edit-action" data-id="${a.id}">${esc(a.title)}</a>${a.details ? `<div class="small muted">${esc(a.details.slice(0, 120))}</div>` : ''}</td>
    <td>${ownerLabel(a.owner)}</td>
    <td class="num">${done ? fmtDate(a.due_date) : relDate(a.due_date)}</td>
    <td class="prio-${a.priority}">${PRIO_LABEL[a.priority]}</td>
    <td><select data-change="action-status" data-id="${a.id}" aria-label="Statut">${options(STATUS_LABEL, a.status)}</select></td>
    <td class="small muted" title="${esc(a.source)}">${SOURCE_ICON[a.source] || ''}</td>
  </tr>`;
}

function riskMatrix(risks) {
  const open = risks.filter((r) => r.status === 'open' || r.status === 'mitigating');
  const cells = [];
  for (let p = 5; p >= 1; p--) {
    cells.push(`<div class="ax">${p}</div>`);
    for (let i = 1; i <= 5; i++) {
      const list = open.filter((r) => r.probability === p && r.impact === i);
      const lvl = Math.min(5, list.length ? 1 + Math.floor(list.length * 1.5) : 0);
      const title = list.length ? list.map((r) => `• ${r.title}`).join('\n') : `P${p} × I${i}`;
      cells.push(`<div class="cell ${lvl ? 'l' + lvl : ''} ${p * i >= 15 ? 'zone' : ''}" title="${esc(title)}">${list.length || ''}</div>`);
    }
  }
  cells.push('<div></div>', ...[1, 2, 3, 4, 5].map((i) => `<div class="ax">${i}</div>`));
  return `<div class="matrix" role="img" aria-label="Matrice probabilité × impact des risques ouverts">${cells.join('')}</div>
    <div class="small muted" style="margin-top:4px">↑ Probabilité · Impact → · cadre rouge = zone critique (score ≥ 15)</div>`;
}

const STEP_STATUS = { todo: 'À venir', doing: 'En cours', done: 'Terminée' };

// Diagramme de Gantt du rétroplanning : barres = fenêtre au plus tard de chaque étape.
function ganttBounds(retros) {
  const t = today();
  let from = addDaysISO(t, -7);
  let to = addDaysISO(t, 14);
  for (const r of retros) {
    if (r.steps[0]?.latest_start && r.steps[0].latest_start < from) from = r.steps[0].latest_start;
    if (r.deadline && r.deadline > to) to = r.deadline;
  }
  return { from, to: addDaysISO(to, 3) };
}
function addDaysISO(iso, n) {
  const d = parseISO(iso);
  d.setDate(d.getDate() + n);
  return toISO(d);
}
const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
function ganttAxis({ from, to }) {
  const span = daysBetween(from, to) + 1;
  const x = (iso) => (daysBetween(from, iso) / span) * 100;
  const ticks = [];
  const d = parseISO(from);
  d.setDate(1);
  d.setMonth(d.getMonth() + 1);
  for (; toISO(d) <= to; d.setMonth(d.getMonth() + 1)) ticks.push(`<span style="left:${x(toISO(d))}%">${MONTHS[d.getMonth()]}${d.getMonth() === 0 ? ' ' + d.getFullYear() : ''}</span>`);
  return `<div class="g-row g-axis"><div></div><div class="g-track">${ticks.join('')}</div><div></div></div>`;
}
function ganttRows(retro, bounds, { editable = false } = {}) {
  const t = today();
  const span = daysBetween(bounds.from, bounds.to) + 1;
  const x = (iso) => Math.max(0, Math.min(100, (daysBetween(bounds.from, iso) / span) * 100));
  const lines = `${t >= bounds.from && t <= bounds.to ? `<b class="gl today" style="left:${x(t)}%"></b>` : ''}${retro.deadline ? `<b class="gl deadline" style="left:${x(addDaysISO(retro.deadline, 1))}%"></b>` : ''}`;
  return retro.steps
    .map((st, i) => {
      const cls = st.status === 'done' ? 'done' : st.late || st.overdue ? 'late' : st.status === 'doing' ? 'doing' : 'todo';
      const left = x(st.latest_start);
      const width = Math.max(0.6, x(addDaysISO(st.latest_end, 1)) - left);
      const warn = st.overdue ? `aurait dû finir le ${fmtDate(st.latest_end)}` : st.late ? `aurait dû démarrer le ${fmtDate(st.latest_start)}` : '';
      const tip = `${st.title}\nAu plus tard : ${fmtDate(st.latest_start)} → ${fmtDate(st.latest_end)} (${st.duration_days} j ouvrés)\n${STEP_STATUS[st.status]}${st.owner ? ' · ' + st.owner : ''}${warn ? '\n⚠ ' + warn : ''}`;
      return `<div class="g-row">
        <div class="g-label">${editable ? `<a href="#" data-act="edit-step" data-id="${st.id}">${esc(st.title)}</a>` : esc(st.title)}
          <small>${st.duration_days} j${st.status === 'doing' && st.remaining_days != null ? ` (reste ${st.remaining_days})` : ''} · ${fmtDate(st.latest_start)} → ${fmtDate(st.latest_end)}${st.owner ? ` · ${esc(st.owner)}` : ''}${warn ? ` · <span class="late">${esc(warn)}</span>` : ''}</small></div>
        <div class="g-track" title="${esc(tip)}">${lines}<i class="g-bar ${cls}" style="left:${left}%;width:${width}%"></i></div>
        <div class="g-ctl">${
          editable
            ? `<select data-change="step-status" data-id="${st.id}" aria-label="Statut de l'étape">${options(STEP_STATUS, st.status)}</select>
               <button class="btn ghost sm" data-act="move-step" data-id="${st.id}" data-delta="-1" aria-label="Monter" ${i === 0 ? 'disabled' : ''}>↑</button><button class="btn ghost sm" data-act="move-step" data-id="${st.id}" data-delta="1" aria-label="Descendre" ${i === retro.steps.length - 1 ? 'disabled' : ''}>↓</button>`
            : `<span class="small muted">${STEP_STATUS[st.status]}</span>`
        }</div>
      </div>`;
    })
    .join('');
}
function retroSummary(r) {
  if (!r || !r.remainingDays) return '';
  const cls = r.buffer < 0 ? 'late' : r.buffer <= 5 ? 'prio-high' : '';
  return `<div class="row small" style="margin-bottom:8px;gap:14px">
    <span>Travail restant : <b>${r.remainingDays} j ouvrés</b></span>
    <span>Disponible d'ici la deadline : <b>${r.availableDays} j</b></span>
    <span class="${cls}">Marge : <b>${r.buffer >= 0 ? `${r.buffer} j` : `−${-r.buffer} j (infaisable en l'état)`}</b></span>
    ${r.nextStep ? `<span>Prochaine étape : <b>${esc(r.nextStep.title)}</b>, au plus tard le ${fmtDate(r.nextStep.latest_start)}</span>` : ''}
  </div>`;
}
const GANTT_LEGEND = `<div class="small muted g-legend"><span><i class="g-bar todo"></i>À venir</span><span><i class="g-bar doing"></i>En cours</span><span><i class="g-bar done"></i>Terminée</span><span><i class="g-bar late"></i>En retard</span><span><b class="gl today"></b>Aujourd'hui</span><span><b class="gl deadline"></b>Deadline</span></div>`;

function stepForm(st = {}) {
  return `<div class="form">
    <label class="full">Étape<input name="title" required value="${esc(st.title)}" placeholder="Recette utilisateurs"></label>
    <label>Durée (jours ouvrés)<input type="number" name="duration_days" min="1" max="1000" required value="${esc(st.duration_days ?? 5)}"></label>
    <label>Porteur<input name="owner" value="${esc(st.owner)}"></label>
    ${st.id ? `<label>Statut<select name="status">${options(STEP_STATUS, st.status)}</select></label>
    <label>Reste à faire (j ouvrés, si en cours)<input type="number" name="remaining_days" min="0" max="1000" value="${esc(st.remaining_days ?? '')}" placeholder="durée complète"></label>` : ''}
    <div class="full small muted">Les étapes s'enchaînent dans l'ordre de la liste ; la dernière se termine à la deadline.</div>
  </div>`;
}

async function shareProject(p) {
  const text = await api('GET', `/api/projects/${p.id}/report.txt`);
  modal(`Partager le statut — ${p.code}`, `
    <p class="small muted" style="margin-top:0">Instantané de l'état actuel du projet : à envoyer au sponsor, en COPIL ou dans un canal Teams.</p>
    <div class="row" style="margin-bottom:12px">
      <a class="btn primary" href="/api/projects/${p.id}/report.html" target="_blank" rel="noopener">Ouvrir le rapport (→ PDF via Imprimer)</a>
      <a class="btn" href="/api/projects/${p.id}/report.html?download=1">Télécharger (.html)</a>
      <a class="btn" href="/api/projects/${p.id}/actions.csv">Actions (.csv)</a>
    </div>
    <label class="small muted" for="share-text">Résumé texte (Teams, Outlook, Telegram)</label>
    <textarea id="share-text" rows="14" readonly>${esc(text)}</textarea>`, {
    extra: '<button class="btn" type="button" id="copy-share">Copier le texte</button>',
  });
  $('#copy-share').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      $('#share-text').select();
      document.execCommand('copy');
    }
    toast('Résumé copié — colle-le dans Teams ou un mail');
  });
}

let projectFilter = 'open';
async function renderProject(id) {
  const d = await api('GET', `/api/projects/${id}`);
  const p = d.project;
  const m = d.metrics;
  remember('actions', d.actions);
  remember('risks', d.risks);
  handlers['edit-project'] = () => editProject(p);
  handlers['pfilter'] = (el) => {
    projectFilter = el.dataset.v;
    renderProject(id);
  };
  handlers['add-journal'] = async () => {
    const text = $('#journal-text').value.trim();
    if (!text) return;
    await api('POST', '/api/journal', { project_id: p.id, kind: $('#journal-kind').value, text });
    renderProject(id);
  };
  handlers['add-milestone'] = () =>
    modal('Nouveau jalon', `<div class="form"><label class="full">Jalon<input name="title" required></label><label>Date<input type="date" name="due_date"></label></div>`, {
      onSubmit: (data) => api('POST', '/api/milestones', { ...data, project_id: p.id }),
    });
  handlers['toggle-milestone'] = async (el) => {
    await api('PATCH', `/api/milestones/${el.dataset.id}`, { done: el.dataset.done === '1' ? 0 : 1 });
    renderProject(id);
  };
  handlers['del-milestone'] = async (el) => {
    if (!confirm('Supprimer ce jalon ?')) return;
    await api('DELETE', `/api/milestones/${el.dataset.id}`);
    renderProject(id);
  };
  handlers['quick-progress'] = async (el) => {
    await api('PATCH', `/api/projects/${p.id}`, { progress: Number(el.value) });
    renderProject(id);
  };
  handlers['quick-rag'] = async (el) => {
    await api('PATCH', `/api/projects/${p.id}`, { rag: el.value });
    renderProject(id);
  };
  handlers['share'] = () => shareProject(p);
  const retro = m.retro;
  const steps = retro ? retro.steps : [];
  handlers['add-step'] = () => modal('Nouvelle étape', stepForm(), { onSubmit: (data) => api('POST', `/api/projects/${p.id}/retro`, data) });
  handlers['edit-step'] = (el) => {
    const st = steps.find((x) => x.id === Number(el.dataset.id));
    modal('Étape du rétroplanning', stepForm(st), {
      extra: '<button class="btn danger" type="button" id="del-step">Supprimer</button>',
      onSubmit: (data) => api('PATCH', `/api/retro-steps/${st.id}`, data),
    });
    $('#del-step').addEventListener('click', async () => {
      if (!confirm('Supprimer cette étape ?')) return;
      await api('DELETE', `/api/retro-steps/${st.id}`);
      $('#modal').close();
      renderProject(id);
    });
  };
  handlers['step-status'] = async (el) => {
    await api('PATCH', `/api/retro-steps/${el.dataset.id}`, { status: el.value });
    renderProject(id);
  };
  handlers['move-step'] = async (el) => {
    await api('POST', `/api/retro-steps/${el.dataset.id}/move`, { delta: Number(el.dataset.delta) });
    renderProject(id);
  };
  handlers['retro-template'] = async () => {
    await api('POST', `/api/projects/${p.id}/retro/template`, {});
    toast('Modèle ajouté : ajuste les durées');
    renderProject(id);
  };
  const bounds = retro && steps.length ? ganttBounds([retro]) : null;
  const retroCard = `<section class="card">
    <header><h2>Rétroplanning${p.deadline ? ` <span class="small muted">— à rebours depuis le ${fmtDate(p.deadline)}</span>` : ''}</h2>
      <div class="row">${steps.length ? '' : '<button class="btn sm" data-act="retro-template">Partir du modèle TTM</button>'}<button class="btn sm" data-act="add-step">+ Étape</button></div></header>
    ${
      !p.deadline
        ? '<div class="empty">Renseigne la deadline du projet (Modifier) pour calculer le rétroplanning.</div>'
        : steps.length
          ? `${retroSummary(retro)}<div class="gantt">${ganttAxis(bounds)}${ganttRows(retro, bounds, { editable: true })}</div>${GANTT_LEGEND}`
          : '<div class="empty">Aucune étape. Liste les étapes et leur durée en jours ouvrés : l\'app calcule les dates de démarrage au plus tard (week-ends et jours fériés exclus).</div>'
    }
  </section>`;

  const actions = d.actions.filter((a) =>
    projectFilter === 'open' ? a.status !== 'done' && a.status !== 'cancelled' : projectFilter === 'late' ? a.due_date && a.due_date < today() && a.status !== 'done' && a.status !== 'cancelled' : true
  );
  const risks = d.risks
    .map(
      (r) => `<tr class="${r.status === 'closed' ? 'done' : ''}"><td><span class="score ${scoreCls(r.score)}">${r.score}</span></td>
      <td class="title"><a href="#" class="t" data-act="edit-risk" data-id="${r.id}">${esc(r.title)}</a>${r.mitigation ? `<div class="small muted">↳ ${esc(r.mitigation)}</div>` : ''}</td>
      <td class="num small nw">P${r.probability} × I${r.impact}</td><td class="small">${RISK_STATUS[r.status]}</td>
      <td class="small">${m.risingRisks.some((x) => x.id === r.id) ? '<span class="late">↗ en hausse</span>' : ''}</td></tr>`
    )
    .join('');

  view.innerHTML = `
    <div class="page-head">
      <div><div class="row"><span class="tag">${esc(p.code)}</span>${p.ttm ? '<span class="tag ttm">Deadline imposée</span>' : ''}<h1>${esc(p.name)}</h1>${ragBadge(m.health, ` <span class="num">${m.score}/100</span>`)}</div>
      <div class="small muted" style="margin-top:4px">${esc(p.phase || 'Phase ?')} · Sponsor : ${esc(p.sponsor || '—')} · Deadline : ${p.deadline ? `${fmtDate(p.deadline)} (${m.daysLeft < 0 ? `dépassée de ${-m.daysLeft} j` : `J-${m.daysLeft}`})` : '—'}${p.aliases ? ` · alias : ${esc(p.aliases)}` : ''}</div></div>
      <div class="row">
        <label class="small">Statut déclaré <select data-change="quick-rag">${options(RAG, p.rag)}</select></label>
        <label class="small">Avancement <input type="number" min="0" max="100" value="${p.progress}" data-change="quick-progress" style="width:70px"> %</label>
        <button class="btn" data-act="edit-project">Modifier</button>
        <button class="btn primary" data-act="share">Partager le statut</button>
      </div>
    </div>
    ${p.status_note ? `<div class="note-card"><b>Message clé</b> ${esc(p.status_note)}</div>` : ''}
    ${p.ttm ? `<div class="mb">${retroCard}</div>` : ''}
    <section class="kpis">
      ${kpi('Actions ouvertes', m.openActions, `${m.dueSoonActions} dans les 7 j · ${m.waitingActions} en attente`)}
      ${kpi('En retard', m.overdueActions, 'actions dépassées', '', m.overdueActions > 0)}
      ${kpi('Risques ouverts', m.openRisks, `${m.criticalRisks} critique(s) · ${m.risingRisks.length} en hausse`, '', m.criticalRisks > 0)}
      ${kpi('Avancement', `${p.progress} %`, m.elapsedPct !== null ? `${m.elapsedPct} % du temps écoulé` : 'dates non renseignées', '', m.scheduleGap > 20)}
      ${kpi('Changements 7 j', m.changes7d, 'stabilité du périmètre', '', m.changes7d >= 3)}
    </section>
    <div class="grid cols-main">
      <div class="stack">
        <section class="card">
          <header><h2>Actions</h2><div class="row">
            <div class="seg">${[['open', 'Ouvertes'], ['late', 'En retard'], ['all', 'Toutes']].map(([v, l]) => `<button data-act="pfilter" data-v="${v}" class="${projectFilter === v ? 'on' : ''}">${l}</button>`).join('')}</div>
            <button class="btn sm" data-act="new-action" data-project="${p.id}">+ Action</button></div></header>
          <div class="table-wrap">${actions.length ? `<table class="table"><thead><tr><th></th><th>Action</th><th>Porteur</th><th>Échéance</th><th>Priorité</th><th>Statut</th><th></th></tr></thead><tbody>${actions.map((a) => actionRow(a)).join('')}</tbody></table>` : '<div class="empty">Aucune action.</div>'}</div>
        </section>
        <section class="card">
          <header><h2>Risques</h2><button class="btn sm" data-act="new-risk" data-project="${p.id}">+ Risque</button></header>
          <div class="grid" style="grid-template-columns:minmax(200px,320px) minmax(0,1fr);align-items:start">
            <div>${riskMatrix(d.risks)}</div>
            <div class="table-wrap">${risks ? `<table class="table"><tbody>${risks}</tbody></table>` : '<div class="empty">Aucun risque identifié.</div>'}</div>
          </div>
        </section>
        ${p.ttm ? '' : retroCard}
      </div>
      <div class="stack">
        <section class="card"><header><h2>Signaux</h2></header><ul class="list">${
          m.signals.map((s) => `<li><span class="alert-ic ${s.level}">${s.level === 'critical' ? '●' : s.level === 'warning' ? '▲' : 'i'}</span><div class="grow">${esc(s.text)}</div>${s.points ? `<span class="small muted num">−${s.points}</span>` : ''}</li>`).join('') || '<li class="empty">RAS — projet sous contrôle.</li>'
        }</ul></section>
        <section class="card"><header><h2>Jalons</h2><button class="btn sm" data-act="add-milestone">+ Jalon</button></header><ul class="list">${
          d.milestones
            .map(
              (ms) => `<li><button class="check" data-act="toggle-milestone" data-id="${ms.id}" data-done="${ms.done}" aria-label="Basculer">${ms.done ? '✓' : ''}</button>
              <div class="grow ${ms.done ? 'muted' : ''}">${esc(ms.title)}</div><span class="small num">${ms.done ? fmtDate(ms.due_date) : relDate(ms.due_date)}</span><button class="btn ghost sm" data-act="del-milestone" data-id="${ms.id}" aria-label="Supprimer">✕</button></li>`
            )
            .join('') || '<li class="empty">Aucun jalon.</li>'
        }</ul></section>
        <section class="card"><header><h2>Journal du projet</h2></header>
          <div class="row" style="margin-bottom:8px"><select id="journal-kind"><option value="change">Changement</option><option value="decision">Décision</option><option value="note">Note</option></select>
          <input id="journal-text" placeholder="Consigner un changement, une décision…" style="flex:1"><button class="btn sm" data-act="add-journal">OK</button></div>
          <ul class="list">${d.journal.slice(0, 40).map(feedItem).join('') || '<li class="empty">Vide.</li>'}</ul>
        </section>
      </div>
    </div>`;
  $('#journal-text').addEventListener('keydown', (e) => e.key === 'Enter' && handlers['add-journal']());
}

async function renderTodo() {
  const t = await api('GET', '/api/todo');
  const all = [...Object.values(t.groups).flat(), ...t.followUp];
  remember('actions', all);
  const item = (a, follow = false) => `<div class="todo-item">
      <button class="check" data-act="done" data-id="${a.id}" aria-label="Marquer fait" title="Marquer fait"></button>
      <div class="grow"><div><a href="#" class="t" data-act="edit-action" data-id="${a.id}" style="color:inherit">${esc(a.title)}</a></div>
        <div class="meta">${projTag(a.project_code, a.project_id)}<span>${relDate(a.due_date)}</span>${a.priority !== 'normal' ? `<span class="prio-${a.priority}">${PRIO_LABEL[a.priority]}</span>` : ''}${follow ? `<span>👤 ${ownerLabel(a.owner)}</span>` : ''}${follow && a.needsNudge ? '<span class="late">à relancer</span>' : ''}${SOURCE_ICON[a.source] ? `<span title="${esc(a.source)}">${SOURCE_ICON[a.source]}</span>` : ''}</div></div>
      <div class="acts"><button class="btn sm" data-act="snooze" data-id="${a.id}" data-days="1" title="Reporter d'un jour">+1j</button><button class="btn sm" data-act="snooze" data-id="${a.id}" data-days="7" title="Reporter d'une semaine">+1s</button></div>
    </div>`;
  const group = (title, list, cls = '') =>
    `<div class="todo-group"><h3 class="${cls}">${title} <span class="count">${list.length}</span></h3>${list.map((a) => item(a)).join('') || '<div class="small muted" style="margin:0 0 10px">—</div>'}</div>`;

  const max = Math.max(3, ...t.load.map((d) => d.count));
  const bars = t.load
    .map(
      (d) => `<div class="bar ${d.count > 5 ? 'over' : ''}" title="${fmtDate(d.date)} : ${d.count} action(s)${d.includesOverdue ? ` dont ${d.includesOverdue} en retard` : ''}">
      <span style="bottom:calc(${(d.count / max) * 100}% + 2px)">${d.count || ''}</span><i style="height:${(d.count / max) * 100}%"></i></div>`
    )
    .join('');
  const axis = t.load.map((d, i) => `<div>${i === 0 ? 'Auj.' : fmtDate(d.date).split(' ')[0]}</div>`).join('');
  const total = Object.values(t.groups).reduce((n, g) => n + g.length, 0);

  view.innerHTML = `
    <div class="page-head"><h1>Mes actions</h1><div class="row"><span class="muted small">${total} ouverte(s) · ${t.doneToday.length} terminée(s) aujourd'hui</span><button class="btn primary" data-act="new-action">+ Action</button></div></div>
    <div class="grid cols-main">
      <div class="card">
        ${group('⚠ En retard', t.groups.overdue, 'late')}
        ${group("Aujourd'hui", t.groups.today)}
        ${group('Cette semaine', t.groups.week)}
        ${group('Plus tard', t.groups.later)}
        ${group('Sans échéance', t.groups.nodate)}
      </div>
      <div class="stack">
        <section class="card"><header><h2>Ma charge — 10 jours ouvrés</h2><span class="small muted">rouge = > 5 actions</span></header>
          <div class="load" role="img" aria-label="Nombre d'actions à échéance par jour">${bars}</div><div class="load-axis">${axis}</div>
          <p class="small muted" style="margin:8px 0 0">Le retard est cumulé sur aujourd'hui. Reporte (+1j / +1s) ou délègue pour lisser.</p></section>
        <section class="card"><header><h2>À relancer / délégué</h2><span class="count">${t.followUp.length}</span></header>
          ${t.followUp.map((a) => item(a, true)).join('') || '<div class="empty">Rien en attente.</div>'}</section>
        ${t.doneToday.length ? `<section class="card"><header><h2>Fait aujourd'hui ✔</h2></header><ul class="list">${t.doneToday.map((a) => `<li class="muted"><s>${esc(a.title)}</s></li>`).join('')}</ul></section>` : ''}
      </div>
    </div>`;
}

async function renderInbox() {
  const [actions, risks, journal, emails] = await Promise.all([
    api('GET', '/api/actions?project=none&open=1'),
    api('GET', '/api/risks?open=1'),
    api('GET', '/api/journal?limit=200'),
    api('GET', '/api/emails'),
  ]);
  const orphanRisks = risks.filter((r) => !r.project_id);
  const orphanJournal = journal.filter((j) => !j.project_id && j.kind !== 'system');
  remember('actions', actions);
  remember('risks', orphanRisks);
  const row = (kind, it, title, extra = '') => `<li><span class="feed-kind">${KIND_LABEL[kind]}</span><div class="grow">${title}${extra}</div>
      <select data-change="assign" data-kind="${kind === 'action' || kind === 'risk' ? kind : 'journal'}" data-id="${it.id}" aria-label="Assigner à un projet">${projectOptions(null)}</select>
      <button class="btn ghost sm" data-act="del-item" data-kind="${kind === 'action' || kind === 'risk' ? kind : 'journal'}" data-id="${it.id}" aria-label="Supprimer">✕</button></li>`;
  const items = [
    ...actions.map((a) => row('action', a, `<a href="#" data-act="edit-action" data-id="${a.id}">${esc(a.title)}</a>`, `<div class="small muted">${ownerLabel(a.owner)} · ${relDate(a.due_date)} ${SOURCE_ICON[a.source] || ''}</div>`)),
    ...orphanRisks.map((r) => row('risk', r, `<a href="#" data-act="edit-risk" data-id="${r.id}">${esc(r.title)}</a>`, `<div class="small muted">score ${r.score}</div>`)),
    ...orphanJournal.map((j) => row(j.kind in KIND_LABEL ? j.kind : 'note', j, esc(j.text), `<div class="small muted">${fmtTs(j.created_at)}</div>`)),
  ];
  view.innerHTML = `
    <div class="page-head"><h1>Inbox — à trier</h1><span class="muted small">Captures sans projet (Telegram, WhatsApp, capture rapide). Choisis un projet pour les ranger.</span></div>
    <div class="grid cols-main">
      <section class="card"><ul class="list">${items.join('') || '<li class="empty">Inbox vide 🎉</li>'}</ul></section>
      <section class="card"><header><h2>Mails en attente</h2><span class="count">${emails.length}</span></header>
        <ul class="list">${emails.map((e) => `<li><div class="grow"><a href="#/mail/${e.id}">${esc(e.subject || '(sans objet)')}</a><div class="small muted">${esc(senderName(e.sender) || e.source)} · ${fmtTs(e.created_at)}</div></div></li>`).join('') || '<li class="empty">Aucun mail en attente.</li>'}</ul>
        <a class="btn" href="#/mail">Traiter un mail →</a></section>
    </div>`;
}

let proposals = [];
async function renderMail(selectedId) {
  const emails = await api('GET', '/api/emails');
  const settings = state.settings || (state.settings = await api('GET', '/api/settings'));
  const current = selectedId ? emails.find((e) => e.id === Number(selectedId)) : null;

  handlers['extract'] = async () => {
    const f = $('#mail-form');
    const payload = { subject: f.subject.value, from: f.from.value, body: f.body.value, projectId: f.project.value || null, engine: f.engine.value };
    $('#proposals').innerHTML = '<div class="empty">Analyse en cours…</div>';
    const r = await api('POST', '/api/emails/extract', payload);
    proposals = r.items;
    renderProposals(r);
  };
  handlers['commit'] = async () => {
    const f = $('#mail-form');
    const items = $$('.proposal[data-i]')
      .filter((row) => $('input[type=checkbox]', row).checked)
      .map((row) => {
        const base = proposals[Number(row.dataset.i)];
        const get = (n) => $(`[name=${n}]`, row)?.value;
        return { ...base, kind: get('kind'), title: get('title'), projectId: get('project') ? Number(get('project')) : null, owner: get('owner') || 'moi', due: get('due') || null, priority: get('priority') || 'normal', status: base.status && get('owner') === base.owner ? base.status : get('owner') && get('owner') !== 'moi' ? 'waiting' : 'todo' };
      });
    if (!items.length) return toast('Aucun élément sélectionné');
    const r = await api('POST', '/api/emails/commit', { items, emailId: current?.id, subject: f.subject.value });
    toast(`${r.created.length} élément(s) ajouté(s)`);
    proposals = [];
    location.hash = '#/mail';
    route();
  };
  handlers['ignore-mail'] = async () => {
    await api('PATCH', `/api/emails/${current.id}`, { status: 'ignored' });
    location.hash = '#/mail';
  };
  handlers['add-proposal'] = () => {
    proposals.push({ kind: 'action', title: '', owner: 'moi', priority: 'normal', projectId: Number($('#mail-form').project.value) || null });
    renderProposals({ items: proposals, engine: 'manuel' });
  };

  view.innerHTML = `
    <div class="page-head"><h1>Mails → actions</h1><span class="small muted">Moteur : ${settings.integrations.claude ? `Claude (${esc(settings.integrations.claudeModel)}) disponible` : 'heuristique locale (ajoute ANTHROPIC_API_KEY pour l’IA)'}</span></div>
    <div class="grid" style="grid-template-columns:minmax(220px,280px) minmax(0,1fr)">
      <section class="card"><header><h2>En attente</h2><a href="#/mail" class="small">+ Coller un mail</a></header>
        <ul class="list">${emails.map((e) => `<li class="mail-item ${current?.id === e.id ? 'on' : ''}"><div class="grow"><a href="#/mail/${e.id}">${esc(e.subject || '(sans objet)')}</a><div class="small muted">${esc(senderName(e.sender) || e.source)} · ${fmtTs(e.created_at)}</div></div></li>`).join('') || '<li class="empty small">Rien. Les mails transférés via Telegram ou Power Automate arrivent ici.</li>'}</ul></section>
      <div class="stack">
        <section class="card">
          <form id="mail-form" class="form">
            <label>Objet<input name="subject" value="${esc(current?.subject || '')}"></label>
            <label>De<input name="from" value="${esc(current?.sender || '')}" placeholder="Paul Martin <paul@…>"></label>
            <label class="full">Contenu du mail (copier-coller depuis Outlook)<textarea name="body" rows="10" placeholder="Colle ici le corps du mail…">${esc(current?.body || '')}</textarea></label>
            <label>Projet par défaut<select name="project"><option value="">Détection automatique</option>${state.projects.map((p) => `<option value="${p.id}">${esc(p.code)} — ${esc(p.name)}</option>`).join('')}</select></label>
            <label>Moteur<select name="engine">${settings.integrations.claude ? '<option value="claude">IA (Claude)</option>' : ''}<option value="local">Heuristique locale (rien ne sort du poste)</option></select></label>
            <div class="full row"><button class="btn primary" data-act="extract">Extraire les actions</button>${current ? '<button class="btn" data-act="ignore-mail">Ignorer ce mail</button>' : ''}<span class="small muted">Astuce : Ctrl+Entrée</span></div>
          </form>
        </section>
        <section class="card" id="proposals-card"><header><h2>Propositions</h2><button class="btn sm" data-act="add-proposal">+ Ligne</button></header><div id="proposals"><div class="empty">Colle un mail puis « Extraire ».</div></div></section>
      </div>
    </div>`;
  $('#mail-form').addEventListener('submit', (e) => e.preventDefault());
  $('#mail-form').body.addEventListener('keydown', (e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && handlers['extract']());
  if (current) handlers['extract']();
}

function renderProposals(r) {
  const el = $('#proposals');
  if (!r.items.length) {
    el.innerHTML = `<div class="empty">Aucune action détectée${r.warning ? ` — ${esc(r.warning)}` : ''}. Ajoute une ligne manuellement.</div>`;
    return;
  }
  el.innerHTML =
    `${r.warning ? `<p class="small late">${esc(r.warning)}</p>` : ''}${r.summary ? `<p class="small"><b>Résumé :</b> ${esc(r.summary)}</p>` : ''}
    <div class="small muted" style="margin-bottom:6px">Moteur : ${esc(r.engine)} — vérifie, ajuste puis ajoute.</div>` +
    r.items
      .map(
        (it, i) => `<div class="proposal" data-i="${i}">
        <input type="checkbox" checked aria-label="Garder">
        <select name="kind">${options({ action: 'Action', risk: 'Risque', change: 'Changement', decision: 'Décision', note: 'Note' }, it.kind)}</select>
        <input name="title" value="${esc(it.title)}" aria-label="Titre">
        <select name="project" aria-label="Projet">${projectOptions(it.projectId)}</select>
        <input name="owner" value="${esc(it.owner || (it.kind === 'action' ? 'moi' : ''))}" placeholder="porteur" aria-label="Porteur">
        <input type="date" name="due" value="${esc(it.due || '')}" aria-label="Échéance">
        <select name="priority" aria-label="Priorité">${options(PRIO_LABEL, it.priority || 'normal')}</select>
        ${it.excerpt ? `<div class="excerpt">« ${esc(it.excerpt)} »</div>` : ''}
      </div>`
      )
      .join('') +
    `<div class="row" style="margin-top:12px"><button class="btn primary" data-act="commit">Ajouter la sélection</button></div>`;
}

async function renderRetro() {
  const pf = await api('GET', '/api/portfolio');
  const withRetro = pf.projects.filter((p) => p.metrics.retro && p.metrics.retro.steps.length && p.deadline);
  const ttmEmpty = pf.projects.filter((p) => p.ttm && !withRetro.includes(p));
  const bounds = ganttBounds(withRetro.map((p) => p.metrics.retro));
  withRetro.sort((a, b) => (a.metrics.retro.buffer ?? 999) - (b.metrics.retro.buffer ?? 999));
  const groups = withRetro
    .map((p) => {
      const r = p.metrics.retro;
      return `<div class="g-group"><div class="row" style="margin:14px 0 4px"><a class="tag" href="#/p/${p.id}">${esc(p.code)}</a><b>${esc(p.name)}</b>${ragBadge(p.metrics.health)}<span class="small muted">deadline ${fmtDate(p.deadline)}</span></div>
        ${retroSummary(r)}${ganttRows(r, bounds)}</div>`;
    })
    .join('');
  view.innerHTML = `<div class="page-head"><h1>Rétroplanning</h1><span class="small muted">Projets à deadline imposée, planifiés à rebours — triés par marge (la plus faible en premier)</span></div>
    <section class="card">${withRetro.length ? `<div class="gantt">${ganttAxis(bounds)}${groups}</div>${GANTT_LEGEND}` : '<div class="empty">Aucun rétroplanning. Coche « Deadline imposée (TTM) » dans la fiche d\'un projet puis ajoute ses étapes.</div>'}</section>
    ${ttmEmpty.length ? `<section class="card" style="margin-top:16px"><header><h2>Projets TTM sans étapes</h2></header><ul class="list">${ttmEmpty.map((p) => `<li><a class="tag" href="#/p/${p.id}">${esc(p.code)}</a><div class="grow">${esc(p.name)}</div><a href="#/p/${p.id}">Construire le rétroplanning →</a></li>`).join('')}</ul></section>` : ''}`;
}

async function renderJournal() {
  const rows = await api('GET', '/api/journal?limit=300');
  view.innerHTML = `<div class="page-head"><h1>Journal</h1><span class="small muted">Changements, décisions, risques et notes — tous projets</span></div>
    <section class="card"><ul class="list">${rows.map(feedItem).join('') || '<li class="empty">Vide.</li>'}</ul></section>`;
}

async function renderSettings() {
  const s = (state.settings = await api('GET', '/api/settings'));
  const i = s.integrations;
  const yes = (b) => (b ? '<span class="badge st-green"><span class="dot"></span>Actif</span>' : '<span class="badge">Non configuré</span>');
  handlers['save-settings'] = async () => {
    await api('PUT', '/api/settings', { me_name: $('#me_name').value, me_aliases: $('#me_aliases').value });
    toast('Réglages enregistrés');
  };
  handlers['theme'] = (el) => {
    const v = el.dataset.v;
    if (v === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = v;
    try {
      localStorage.setItem('theme', v);
    } catch {}
  };
  view.innerHTML = `<div class="page-head"><h1>Réglages</h1></div>
    <div class="grid cols-2">
      <section class="card"><header><h2>Moi</h2></header>
        <div class="form"><label>Mon nom<input id="me_name" value="${esc(s.me_name)}"></label>
        <label>Autres noms / initiales (séparés par des virgules)<input id="me_aliases" value="${esc(s.me_aliases)}" placeholder="Sarah, SH"></label>
        <div class="full small muted">Utilisé pour reconnaître les actions qui te concernent (@Sarah = moi) et dans les mails.</div>
        <div class="full"><button class="btn primary" data-act="save-settings">Enregistrer</button></div></div>
        <h3 style="margin-top:16px">Thème</h3><div class="seg" style="margin-top:6px">${['auto', 'light', 'dark'].map((v) => `<button data-act="theme" data-v="${v}">${{ auto: 'Auto', light: 'Clair', dark: 'Sombre' }[v]}</button>`).join('')}</div>
        <h3 style="margin-top:16px">Export</h3><p><a class="btn" href="/api/export/actions.csv">Exporter toutes les actions (CSV / Excel)</a></p>
      </section>
      <section class="card"><header><h2>Intégrations</h2></header>
        <table class="table"><tbody>
          <tr><td>Telegram</td><td>${yes(i.telegram)}</td><td class="small muted">${i.telegram ? `mode ${esc(i.telegramMode)} · ${i.telegramChats} chat(s) autorisé(s)` : 'TELEGRAM_BOT_TOKEN dans .env'}</td></tr>
          <tr><td>WhatsApp</td><td>${yes(i.whatsapp)}</td><td class="small muted">API WhatsApp Business Cloud (URL publique requise)</td></tr>
          <tr><td>IA mails (Claude)</td><td>${yes(i.claude)}</td><td class="small muted">${i.claude ? esc(i.claudeModel) : 'ANTHROPIC_API_KEY dans .env'}</td></tr>
          <tr><td>Ingestion mails (Power Automate)</td><td>${yes(i.ingest)}</td><td class="small muted">POST /api/ingest/email + INGEST_TOKEN</td></tr>
          <tr><td>Mot de passe web</td><td>${yes(i.auth)}</td><td class="small muted">APP_PASSWORD</td></tr>
        </tbody></table>
        ${i.auth ? '<p><button class="btn" id="logout">Se déconnecter</button></p>' : ''}
      </section>
      <section class="card" style="grid-column:1/-1"><header><h2>Syntaxe de capture (web, Telegram, WhatsApp)</h2></header>
        <table class="table small"><tbody>
          <tr><td><code>#CRM relancer Paul sur le budget vendredi</code></td><td>Action pour moi, projet CRM, échéance vendredi</td></tr>
          <tr><td><code>#CRM @Paul envoyer le planning demain !</code></td><td>Action pour Paul, priorité haute</td></tr>
          <tr><td><code>w: #ERP @Sophie retour juridique 12/10</code></td><td>En attente de Sophie → apparaît dans « À relancer »</td></tr>
          <tr><td><code>r: #ERP fournisseur en retard p4 i5</code></td><td>Risque probabilité 4 × impact 5</td></tr>
          <tr><td><code>c: #CRM go-live décalé au 15/11</code></td><td>Changement consigné au journal</td></tr>
          <tr><td><code>d: …</code> / <code>n: …</code></td><td>Décision / note</td></tr>
          <tr><td>Dates</td><td>aujourd'hui, demain, lundi…, fin de semaine, fin du mois, semaine prochaine, +3j, +2s, dans 3 jours, 12/10, 12 octobre</td></tr>
          <tr><td>Priorité</td><td><code>!</code> haute · <code>!!</code> critique · <code>!basse</code></td></tr>
          <tr><td>Telegram</td><td><code>/todo</code> <code>/retard</code> <code>/semaine</code> <code>/attente</code> <code>/projets</code> <code>/p CRM</code> <code>/inbox</code> <code>/fait 12</code> <code>/report 12 lundi</code> <code>/rapport CRM</code> — un long texte collé (ou préfixé <code>mail:</code>) est traité comme un mail</td></tr>
        </tbody></table>
      </section>
    </div>`;
  $('#logout')?.addEventListener('click', async () => {
    await api('POST', '/api/logout', {});
    location.reload();
  });
}

function renderLogin() {
  view.innerHTML = `<section class="card" style="max-width:360px;margin:60px auto"><h1>Connexion</h1>
    <form id="login" class="stack" style="margin-top:12px"><input type="password" name="password" placeholder="Mot de passe" required style="width:100%"><button class="btn primary">Entrer</button></form></section>`;
  $('#login').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/api/login', { password: e.target.password.value });
      location.reload();
    } catch (err) {
      toast(err.message);
    }
  });
}

// ----------------------------------------------------------------- router
async function refreshCounts() {
  const pf = await api('GET', '/api/portfolio').catch(() => null);
  if (!pf) return;
  const todoEl = $('#nav-todo');
  const n = pf.kpis.myOverdue + pf.kpis.myToday;
  todoEl.textContent = n || '';
  todoEl.classList.toggle('alert', pf.kpis.myOverdue > 0);
  $('#nav-inbox').textContent = pf.kpis.inbox || '';
}

async function route() {
  const hash = location.hash.slice(1) || '/';
  const [, page, arg] = hash.split('/');
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === (page || 'home') || (page === 'p' && a.dataset.nav === 'home')));
  try {
    if (!state.projects.length) await loadProjects();
    switch (page) {
      case '':
      case undefined:
        await renderHome();
        break;
      case 'p':
        await renderProject(arg);
        break;
      case 'todo':
        await renderTodo();
        break;
      case 'inbox':
        await renderInbox();
        break;
      case 'mail':
        await renderMail(arg);
        break;
      case 'retro':
        await renderRetro();
        break;
      case 'journal':
        await renderJournal();
        break;
      case 'settings':
        await renderSettings();
        break;
      default:
        view.innerHTML = '<div class="empty">Page inconnue.</div>';
    }
    refreshCounts();
  } catch (err) {
    if (err.message !== 'auth') view.innerHTML = `<div class="card empty">Erreur : ${esc(err.message)}</div>`;
  }
}

try {
  const theme = localStorage.getItem('theme');
  if (theme && theme !== 'auto') document.documentElement.dataset.theme = theme;
} catch {}
window.addEventListener('hashchange', route);
route();
