// Serveur HTTP (API JSON + fichiers statiques), sans framework.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureContext, deleteItem, moveItem, quickCapture, saveItem } from './capture.js';
import { extractFromEmail } from './emailExtract.js';
import { portfolio, projectDashboard, todo } from './health.js';
import { parseCapture } from './parser.js';
import { addDays, todayISO } from './dates.js';
import { TTM_TEMPLATE } from './retro.js';
import { clearDemoData, describeCounts, findDemoData } from './demo.js';
import { renderHtml, renderText, reportContent } from './report.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, data, headers = {}) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(status, { 'content-type': typeof data === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', ...headers });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 2_000_000) throw new HttpError(413, 'Corps de requête trop volumineux');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

function parseJson(buf) {
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, 'JSON invalide');
  }
}

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function sign(secret, value) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function cookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || '')
      .split(';')
      .map((c) => c.trim().split('='))
      .filter(([k]) => k)
      .map(([k, ...v]) => [k, decodeURIComponent(v.join('='))])
  );
}

const ENUMS = {
  priority: ['low', 'normal', 'high', 'critical'],
  status: ['todo', 'doing', 'waiting', 'done', 'cancelled'],
  riskStatus: ['open', 'mitigating', 'closed', 'occurred'],
  stepStatus: ['todo', 'doing', 'done'],
  rag: ['green', 'amber', 'red'],
};
function check(value, list, field) {
  if (value !== undefined && !list.includes(value)) throw new HttpError(400, `${field} invalide`);
}

function toCsv(rows, cols) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s; // évite l'injection de formules Excel
    return /[";\n,]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return '﻿' + [cols.join(';'), ...rows.map((r) => cols.map((c) => esc(r[c])).join(';'))].join('\r\n');
}

export function createApp(repo, config, { telegram = null, whatsapp = null } = {}) {
  const routes = [];
  const route = (method, pattern, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
    routes.push({ method, re, keys, handler, ...opts });
  };
  const id = (p) => {
    const n = Number(p.id);
    if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'Identifiant invalide');
    return n;
  };
  const must = (row) => {
    if (!row) throw new HttpError(404, 'Introuvable');
    return row;
  };
  const projectIdOf = (v) => (v === null || v === '' || v === undefined ? null : Number(v));

  // ------------------------------------------------------------------ auth
  const authEnabled = Boolean(config.appPassword);
  const sessionToken = () => {
    const exp = Date.now() + 30 * 86400000;
    return `${exp}.${sign(config.sessionSecret, String(exp))}`;
  };
  const isAuthed = (req) => {
    if (!authEnabled) return true;
    const tok = cookies(req).pmapp_session || '';
    const [exp, sig] = tok.split('.');
    return Boolean(exp && sig && Number(exp) > Date.now() && safeEqual(sig, sign(config.sessionSecret, exp)));
  };

  route('GET', '/api/session', (req) => ({ authenticated: isAuthed(req), authEnabled }), { public: true });
  route('POST', '/api/login', async (req, res, p, body) => {
    if (!authEnabled) return { ok: true };
    if (!safeEqual(body.password || '', config.appPassword)) throw new HttpError(401, 'Mot de passe incorrect');
    res.setHeader('set-cookie', `pmapp_session=${sessionToken()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 86400}`);
    return { ok: true };
  }, { public: true });
  route('POST', '/api/logout', (req, res) => {
    res.setHeader('set-cookie', 'pmapp_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return { ok: true };
  });

  // ------------------------------------------------------------- portefeuille
  route('GET', '/api/portfolio', () => portfolio(repo, todayISO()));
  route('GET', '/api/todo', () => todo(repo, todayISO()));

  // ------------------------------------------------------------------ projets
  route('GET', '/api/projects', (req, res, p, body, q) => repo.listProjects({ includeArchived: q.get('archived') === '1' }));
  route('POST', '/api/projects', (req, res, p, body) => {
    if (!body.code || !body.name) throw new HttpError(400, 'Code et nom obligatoires');
    check(body.rag, ENUMS.rag, 'rag');
    const code = String(body.code).trim().toUpperCase().replace(/\s+/g, '-');
    if (repo.all('SELECT id FROM projects WHERE code = ?', code).length) throw new HttpError(409, 'Code déjà utilisé');
    const project = repo.insert('projects', { ...body, code });
    repo.addJournal({ project_id: project.id, kind: 'system', text: `Projet créé : ${project.name}` });
    return project;
  });
  route('GET', '/api/projects/:id', (req, res, p) => must(projectDashboard(repo, id(p), todayISO())));
  route('PATCH', '/api/projects/:id', (req, res, p, body) => {
    const before = must(repo.get('projects', id(p)));
    check(body.rag, ENUMS.rag, 'rag');
    if (body.code) body.code = String(body.code).trim().toUpperCase().replace(/\s+/g, '-');
    const after = repo.update('projects', before.id, body);
    const tracked = { deadline: 'Deadline', rag: 'Statut', progress: 'Avancement', phase: 'Phase' };
    for (const [k, label] of Object.entries(tracked)) {
      if (body[k] !== undefined && String(before[k] ?? '') !== String(after[k] ?? '')) {
        repo.addJournal({ project_id: before.id, kind: k === 'deadline' ? 'change' : 'system', text: `${label} : ${before[k] ?? '—'} → ${after[k] ?? '—'}` });
      }
    }
    return after;
  });
  route('DELETE', '/api/projects/:id', (req, res, p) => {
    must(repo.get('projects', id(p)));
    return repo.update('projects', id(p), { archived: 1 });
  });

  // ------------------------------------------------------------ rétroplanning
  const duration = (v) => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < 1 || n > 1000) throw new HttpError(400, 'Durée invalide (1 à 1000 j ouvrés)');
    return n;
  };
  route('POST', '/api/projects/:id/retro', (req, res, p, body) => {
    must(repo.get('projects', id(p)));
    if (!body.title) throw new HttpError(400, 'Titre obligatoire');
    return repo.addRetroStep({ project_id: id(p), title: body.title, duration_days: duration(body.duration_days ?? 5), owner: body.owner || '' });
  });
  route('POST', '/api/projects/:id/retro/template', (req, res, p) => {
    const project = must(repo.get('projects', id(p)));
    if (repo.listRetroSteps(project.id).length) throw new HttpError(409, 'Le rétroplanning contient déjà des étapes');
    for (const st of TTM_TEMPLATE) repo.addRetroStep({ project_id: project.id, ...st });
    if (!project.ttm) repo.update('projects', project.id, { ttm: 1 });
    return repo.listRetroSteps(project.id);
  });
  route('GET', '/api/retro-steps', (req, res, p, body, q) => {
    const pid = Number(q.get('project'));
    if (!pid) throw new HttpError(400, 'Paramètre project requis');
    return repo.listRetroSteps(pid);
  });
  route('PATCH', '/api/retro-steps/:id', (req, res, p, body) => {
    check(body.status, ENUMS.stepStatus, 'status');
    if (body.duration_days !== undefined) body.duration_days = duration(body.duration_days);
    if (body.remaining_days !== undefined) body.remaining_days = body.remaining_days === '' || body.remaining_days === null ? null : Math.max(0, Math.round(Number(body.remaining_days)) || 0);
    delete body.project_id;
    return must(repo.update('retro_steps', id(p), body));
  });
  route('POST', '/api/retro-steps/:id/move', (req, res, p, body) => must(repo.moveRetroStep(id(p), Number(body.delta) < 0 ? -1 : 1)));
  route('DELETE', '/api/retro-steps/:id', (req, res, p) => ({ ok: repo.remove('retro_steps', id(p)) }));

  // --------------------------------------------------------- export statut
  const report = (p) => {
    const d = must(projectDashboard(repo, id(p), todayISO()));
    return reportContent(d, { meName: repo.getSettings().me_name, today: todayISO() });
  };
  const fileName = (c, ext) => `statut-${c.project.code}-${c.today}.${ext}`.replace(/[^\w.-]/g, '_');
  route('GET', '/api/projects/:id/report.html', (req, res, p, body, q) => {
    const c = report(p);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
      ...(q.get('download') ? { 'content-disposition': `attachment; filename="${fileName(c, 'html')}"` } : {}),
    });
    res.end(renderHtml(c));
  });
  route('GET', '/api/projects/:id/report.txt', (req, res, p) => renderText(report(p)));
  route('GET', '/api/projects/:id/actions.csv', (req, res, p) => {
    const project = must(repo.get('projects', id(p)));
    const csv = toCsv(repo.listActions({ projectId: project.id }), ['id', 'title', 'owner', 'due_date', 'priority', 'status', 'source', 'created_at', 'done_at', 'details']);
    res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="actions-${project.code.replace(/[^\w-]/g, '_')}.csv"` });
    res.end(csv);
  });

  // ------------------------------------------------------------------ actions
  route('GET', '/api/actions', (req, res, p, body, q) => {
    const pid = q.get('project');
    return repo.listActions({
      projectId: pid === 'none' ? null : pid ? Number(pid) : undefined,
      open: q.get('open') === '1',
      status: q.get('status') || undefined,
    });
  });
  // Une action ne peut être rattachée qu'à une phase de son propre projet.
  const stepFor = (stepId, projectId) => {
    if (stepId === null || stepId === undefined || stepId === '') return null;
    const st = repo.get('retro_steps', Number(stepId));
    if (!st || st.project_id !== projectId) throw new HttpError(400, 'Phase invalide pour ce projet');
    return st.id;
  };
  route('POST', '/api/actions', (req, res, p, body) => {
    check(body.priority, ENUMS.priority, 'priority');
    check(body.status, ENUMS.status, 'status');
    if (!body.title) throw new HttpError(400, 'Titre obligatoire');
    const project_id = projectIdOf(body.project_id);
    return repo.createAction({ ...body, project_id, step_id: stepFor(body.step_id, project_id), source: 'web' });
  });
  route('PATCH', '/api/actions/:id', (req, res, p, body) => {
    check(body.priority, ENUMS.priority, 'priority');
    check(body.status, ENUMS.status, 'status');
    const current = must(repo.get('actions', id(p)));
    if ('project_id' in body) body.project_id = projectIdOf(body.project_id);
    const projectId = 'project_id' in body ? body.project_id : current.project_id;
    if ('step_id' in body) body.step_id = stepFor(body.step_id, projectId);
    else if (projectId !== current.project_id) body.step_id = null; // changement de projet : l'ancienne phase ne s'applique plus
    return must(repo.updateAction(current.id, body));
  });
  route('POST', '/api/actions/:id/snooze', (req, res, p, body) => {
    const a = must(repo.get('actions', id(p)));
    const base = a.due_date && a.due_date > todayISO() ? a.due_date : todayISO();
    return repo.updateAction(a.id, { due_date: addDays(base, Number(body.days) || 1) });
  });
  route('DELETE', '/api/actions/:id', (req, res, p) => ({ ok: repo.remove('actions', id(p)) }));

  // ------------------------------------------------------------------ risques
  route('GET', '/api/risks', (req, res, p, body, q) => repo.listRisks({ projectId: q.get('project') ? Number(q.get('project')) : undefined, open: q.get('open') === '1' }));
  route('POST', '/api/risks', (req, res, p, body) => {
    if (!body.title) throw new HttpError(400, 'Titre obligatoire');
    check(body.status, ENUMS.riskStatus, 'status');
    const r = repo.createRisk({ ...body, project_id: projectIdOf(body.project_id), probability: clamp(body.probability), impact: clamp(body.impact) });
    repo.addJournal({ project_id: r.project_id, kind: 'risk', text: `Nouveau risque : ${r.title} (score ${r.probability * r.impact})` });
    return r;
  });
  route('PATCH', '/api/risks/:id', (req, res, p, body) => {
    check(body.status, ENUMS.riskStatus, 'status');
    const before = must(repo.get('risks', id(p)));
    if (body.probability !== undefined) body.probability = clamp(body.probability);
    if (body.impact !== undefined) body.impact = clamp(body.impact);
    if ('project_id' in body) body.project_id = projectIdOf(body.project_id);
    const r = repo.updateRisk(before.id, body);
    const s0 = before.probability * before.impact;
    const s1 = r.probability * r.impact;
    if (s0 !== s1) repo.addJournal({ project_id: r.project_id, kind: 'risk', text: `Risque « ${r.title} » : score ${s0} → ${s1}` });
    if (body.status && body.status !== before.status) repo.addJournal({ project_id: r.project_id, kind: 'risk', text: `Risque « ${r.title} » : ${before.status} → ${r.status}` });
    return r;
  });
  route('DELETE', '/api/risks/:id', (req, res, p) => ({ ok: repo.remove('risks', id(p)) }));

  // ------------------------------------------------------------------ journal
  route('GET', '/api/journal', (req, res, p, body, q) => repo.listJournal({ projectId: q.get('project') ? Number(q.get('project')) : undefined, limit: Math.min(500, Number(q.get('limit')) || 100) }));
  route('POST', '/api/journal', (req, res, p, body) => {
    if (!body.text) throw new HttpError(400, 'Texte obligatoire');
    return repo.addJournal({ project_id: projectIdOf(body.project_id), kind: body.kind || 'note', text: body.text, source: 'web' });
  });
  route('DELETE', '/api/journal/:id', (req, res, p) => ({ ok: repo.remove('journal', id(p)) }));

  // ------------------------------------------------------------------ jalons
  route('POST', '/api/milestones', (req, res, p, body) => {
    if (!body.title || !body.project_id) throw new HttpError(400, 'Titre et projet obligatoires');
    return repo.insert('milestones', { ...body, project_id: Number(body.project_id) });
  });
  route('PATCH', '/api/milestones/:id', (req, res, p, body) => must(repo.update('milestones', id(p), body)));
  route('DELETE', '/api/milestones/:id', (req, res, p) => ({ ok: repo.remove('milestones', id(p)) }));

  // ------------------------------------------------------------ capture rapide
  route('POST', '/api/capture/preview', (req, res, p, body) => parseCapture(body.text || '', captureContext(repo)));
  route('POST', '/api/capture', (req, res, p, body) => {
    if (!String(body.text || '').trim()) throw new HttpError(400, 'Texte vide');
    return quickCapture(repo, body.text, { source: 'web' });
  });
  route('POST', '/api/items/move', (req, res, p, body) => must(moveItem(repo, body.kind, Number(body.id), projectIdOf(body.project_id))));
  route('POST', '/api/items/delete', (req, res, p, body) => ({ ok: deleteItem(repo, body.kind, Number(body.id)) }));

  // --------------------------------------------------------------------- mails
  route('GET', '/api/emails', () => repo.listEmails('pending'));
  route('POST', '/api/emails/extract', async (req, res, p, body) => {
    if (!String(body.body || '').trim()) throw new HttpError(400, 'Colle le contenu du mail');
    const ctx = captureContext(repo);
    const result = await extractFromEmail(body, ctx, { ...config.anthropic, disabled: body.engine === 'local' });
    if (body.projectId) {
      for (const it of result.items) it.projectId ??= Number(body.projectId);
      result.projectId ??= Number(body.projectId);
    }
    return result;
  });
  route('POST', '/api/emails/commit', (req, res, p, body) => {
    const items = Array.isArray(body.items) ? body.items : [];
    const created = items.map((it) => saveItem(repo, it, { source: 'email', sourceRef: body.emailId ? `mail:${body.emailId}` : body.subject || '' }));
    if (body.emailId) repo.update('emails', Number(body.emailId), { status: 'processed' });
    if (body.subject && created.length) {
      const pid = created.find((c) => c.item.project_id)?.item.project_id ?? null;
      repo.addJournal({ project_id: pid, kind: 'note', text: `Mail traité : « ${body.subject} » → ${created.length} élément(s)`, source: 'email' });
    }
    return { created };
  });
  route('PATCH', '/api/emails/:id', (req, res, p, body) => must(repo.update('emails', id(p), { status: body.status })));

  // Réception de mails depuis Power Automate / une règle de transfert (jeton requis).
  route('POST', '/api/ingest/email', (req, res, p, body) => {
    if (!body.body && !body.bodyPreview) throw new HttpError(400, 'body manquant');
    const text = String(body.body || body.bodyPreview).replace(/<style[\s\S]*?<\/style>|<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/[ \t]+/g, ' ');
    const email = repo.insert('emails', { subject: body.subject || '', sender: body.from || '', body: text, source: 'ingest' });
    return { ok: true, id: email.id };
  }, { token: true });
  route('POST', '/api/ingest/capture', (req, res, p, body) => quickCapture(repo, body.text || '', { source: body.source || 'api' }), { token: true });

  // ------------------------------------------------------------------ réglages
  route('GET', '/api/settings', () => ({
    ...repo.getSettings(),
    integrations: {
      telegram: Boolean(config.telegram.token),
      telegramMode: config.telegram.mode,
      telegramChats: config.telegram.allowedChatIds.length,
      whatsapp: Boolean(config.whatsapp.token && config.whatsapp.phoneNumberId),
      claude: Boolean(config.anthropic.apiKey),
      claudeModel: config.anthropic.model,
      ingest: Boolean(config.ingestToken),
      auth: authEnabled,
    },
  }));
  route('PUT', '/api/settings', (req, res, p, body) => repo.setSettings({ me_name: body.me_name ?? 'Moi', me_aliases: body.me_aliases ?? '' }));

  // ------------------------------------------------------- données de démo
  route('GET', '/api/demo', () => {
    const found = findDemoData(repo);
    return { ...found, label: Object.values(found.counts).some(Boolean) ? describeCounts(found.counts) : '' };
  });
  route('POST', '/api/demo/clear', () => ({ counts: clearDemoData(repo) }));

  // ------------------------------------------------------------------ export
  route('GET', '/api/export/actions.csv', (req, res) => {
    const rows = repo.listActions({});
    const csv = toCsv(rows, ['id', 'project_code', 'title', 'owner', 'due_date', 'priority', 'status', 'source', 'created_at', 'done_at', 'details']);
    res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="actions.csv"' });
    res.end(csv);
  });

  // --------------------------------------------------------------- messageries
  route('POST', '/api/telegram/webhook', async (req, res, p, body) => {
    if (!telegram || !config.telegram.webhookSecret || !safeEqual(req.headers['x-telegram-bot-api-secret-token'] || '', config.telegram.webhookSecret)) {
      throw new HttpError(403, 'Refusé');
    }
    await telegram.handleUpdate(body);
    return { ok: true };
  }, { public: true });
  route('GET', '/api/whatsapp/webhook', (req, res, p, body, q) => {
    const challenge = whatsapp && whatsapp.verify(q);
    if (!challenge) throw new HttpError(403, 'Refusé');
    return String(challenge);
  }, { public: true });
  route('POST', '/api/whatsapp/webhook', async (req, res, p, body, q, raw) => {
    if (!whatsapp) throw new HttpError(404, 'WhatsApp non configuré');
    if (config.whatsapp.appSecret) {
      const expected = 'sha256=' + crypto.createHmac('sha256', config.whatsapp.appSecret).update(raw).digest('hex');
      if (!safeEqual(req.headers['x-hub-signature-256'] || '', expected)) throw new HttpError(403, 'Signature invalide');
    }
    await whatsapp.handleWebhook(body);
    return { ok: true };
  }, { public: true });

  // ------------------------------------------------------------------ handler
  function serveStatic(req, res, pathname) {
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = path.resolve(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      return serveStatic(req, res, '/');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  }

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    try {
      if (!url.pathname.startsWith('/api/')) {
        res.setHeader('content-security-policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'");
        return serveStatic(req, res, url.pathname);
      }
      const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
      if (!r) throw new HttpError(404, 'Route inconnue');
      if (r.token) {
        const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        if (!config.ingestToken || !safeEqual(auth, config.ingestToken)) throw new HttpError(401, 'Jeton invalide');
      } else if (!r.public && !isAuthed(req)) {
        throw new HttpError(401, 'Authentification requise');
      }
      // Protection CSRF simple : les écritures depuis le navigateur doivent être en JSON.
      if (!r.public && !r.token && req.method !== 'GET' && !String(req.headers['content-type'] || '').includes('application/json')) {
        throw new HttpError(415, 'Content-Type application/json attendu');
      }
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(url.pathname.match(r.re)[i + 1])]));
      const raw = req.method === 'GET' ? Buffer.alloc(0) : await readBody(req);
      const body = parseJson(raw);
      const out = await r.handler(req, res, params, body, url.searchParams, raw);
      if (!res.headersSent) send(res, 200, out ?? { ok: true });
    } catch (err) {
      const status = err.status || (/UNIQUE constraint/.test(err.message) ? 409 : 500);
      if (status === 500) console.error(err);
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'Erreur interne' : err.message });
    }
  };
}

function clamp(v) {
  const n = Math.round(Number(v) || 3);
  return Math.max(1, Math.min(5, n));
}
