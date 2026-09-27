// Transforme un élément parsé (capture rapide, mail, messagerie) en enregistrement.
import { parseCapture } from './parser.js';
import { todayISO } from './dates.js';

const JOURNAL_KINDS = new Set(['change', 'decision', 'note']);

export function captureContext(repo) {
  return { projects: repo.listProjects(), steps: repo.listRetroSteps(), meAliases: repo.meAliases(), today: todayISO() };
}

export function saveItem(repo, item, { source = 'web', sourceRef = '' } = {}) {
  const projectId = item.projectId ?? item.project_id ?? null;
  if (!item.title || !String(item.title).trim()) throw Object.assign(new Error('Texte vide'), { status: 400 });

  if (item.kind === 'risk') {
    const risk = repo.createRisk({
      project_id: projectId,
      title: item.title,
      description: item.details || '',
      probability: item.probability || 3,
      impact: item.impact || 3,
      owner: item.owner && item.owner !== 'moi' ? item.owner : '',
      source,
    });
    repo.addJournal({ project_id: projectId, kind: 'risk', text: `Nouveau risque : ${item.title} (score ${risk.probability * risk.impact})`, source });
    return { kind: 'risk', item: risk };
  }

  if (JOURNAL_KINDS.has(item.kind)) {
    const entry = repo.addJournal({ project_id: projectId, kind: item.kind, text: item.title, source });
    return { kind: item.kind, item: entry };
  }

  const action = repo.createAction({
    project_id: projectId,
    step_id: projectId ? item.stepId ?? item.step_id ?? null : null,
    title: item.title,
    details: item.details || '',
    owner: item.owner || 'moi',
    due_date: item.due || item.due_date || null,
    priority: item.priority || 'normal',
    status: item.status || 'todo',
    source,
    source_ref: sourceRef,
  });
  return { kind: 'action', item: action };
}

export function quickCapture(repo, text, opts = {}) {
  const parsed = parseCapture(text, captureContext(repo));
  const saved = saveItem(repo, parsed, opts);
  return { parsed, ...saved };
}

// Déplace un élément capturé vers un autre projet (utilisé par les boutons Telegram / l'inbox).
export function moveItem(repo, kind, id, projectId) {
  if (kind === 'action') return repo.update('actions', id, { project_id: projectId, step_id: null }); // la phase appartient à l'ancien projet
  const table = kind === 'risk' ? 'risks' : 'journal';
  return repo.update(table, id, { project_id: projectId });
}

export function deleteItem(repo, kind, id) {
  const table = kind === 'action' ? 'actions' : kind === 'risk' ? 'risks' : 'journal';
  return repo.remove(table, id);
}
