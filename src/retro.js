// Rétroplanning : pour les projets à deadline imposée (TTM), on part de la date
// de fin et on remonte les étapes en jours ouvrés (week-ends et jours fériés
// français exclus) pour obtenir les dates de démarrage au plus tard.
import { addDays, fromISO, toISO } from './dates.js';

function easter(year) {
  // Algorithme de Meeus / Jones / Butcher
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return toISO(new Date(year, month - 1, day));
}

const holidayCache = new Map();
export function frenchHolidays(year) {
  if (!holidayCache.has(year)) {
    const e = easter(year);
    holidayCache.set(
      year,
      new Set([
        `${year}-01-01`, addDays(e, 1), `${year}-05-01`, `${year}-05-08`, addDays(e, 39), addDays(e, 50),
        `${year}-07-14`, `${year}-08-15`, `${year}-11-01`, `${year}-11-11`, `${year}-12-25`,
      ])
    );
  }
  return holidayCache.get(year);
}

export function isWorkingDay(iso) {
  const wd = fromISO(iso).getDay();
  return wd !== 0 && wd !== 6 && !frenchHolidays(Number(iso.slice(0, 4))).has(iso);
}

export function previousWorkingDay(iso) {
  let d = addDays(iso, -1);
  while (!isWorkingDay(d)) d = addDays(d, -1);
  return d;
}

/** Nombre de jours ouvrés dans l'intervalle [from, to] (bornes incluses). */
export function workingDaysBetween(from, to) {
  if (to < from) return -workingDaysBetween(to, from);
  let n = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) if (isWorkingDay(d)) n++;
  return n;
}

/**
 * Calcule les dates au plus tard de chaque étape, de la dernière à la première.
 * @param {Array<{id, title, duration_days, status, position}>} steps
 */
export function computeRetro(steps, deadline, today, startDate = null) {
  const ordered = [...steps].sort((a, b) => a.position - b.position || a.id - b.id);
  if (!deadline || !ordered.length) {
    return { steps: ordered.map((s) => ({ ...s })), deadline, remainingDays: 0, availableDays: null, buffer: null, lateSteps: [], plannedStart: null, infeasibleBy: 0 };
  }

  let end = isWorkingDay(deadline) ? deadline : previousWorkingDay(deadline);
  const computed = new Array(ordered.length);
  for (let i = ordered.length - 1; i >= 0; i--) {
    const s = ordered[i];
    const duration = Math.max(1, Number(s.duration_days) || 1);
    let start = end;
    for (let k = 1; k < duration; k++) start = previousWorkingDay(start);
    const late = s.status === 'todo' && start < today;
    const overdue = s.status !== 'done' && end < today;
    computed[i] = { ...s, duration_days: duration, latest_start: start, latest_end: end, late, overdue };
    end = previousWorkingDay(start);
  }

  const remaining = computed.filter((s) => s.status !== 'done');
  // Étape en cours : on compte le reste à faire s'il est renseigné, sinon toute la durée (prudent).
  const left = (s) => (s.status === 'doing' && s.remaining_days != null ? Math.max(0, Math.min(s.duration_days, Number(s.remaining_days))) : s.duration_days);
  const remainingDays = remaining.reduce((n, s) => n + left(s), 0);
  const availableDays = today > deadline ? 0 : workingDaysBetween(today, deadline);
  const plannedStart = computed[0].latest_start;
  const infeasibleBy = startDate && plannedStart < startDate ? workingDaysBetween(plannedStart, previousWorkingDay(startDate)) : 0;

  return {
    steps: computed,
    deadline,
    remainingDays,
    availableDays,
    buffer: availableDays - remainingDays,
    lateSteps: computed.filter((s) => s.late || s.overdue),
    nextStep: remaining[0] || null,
    plannedStart,
    infeasibleBy,
  };
}

// Modèle de départ, à ajuster projet par projet.
export const TTM_TEMPLATE = [
  { title: 'Cadrage & validation du besoin', duration_days: 10 },
  { title: 'Spécifications / conception', duration_days: 15 },
  { title: 'Réalisation', duration_days: 30 },
  { title: 'Recette & corrections', duration_days: 15 },
  { title: 'Préparation mise en production (go/no-go)', duration_days: 5 },
  { title: 'Mise en production', duration_days: 1 },
];
