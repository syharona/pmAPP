// Utilitaires de dates (format ISO AAAA-MM-JJ, heure locale) et
// reconnaissance des échéances exprimées en français.

export function toISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function fromISO(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function todayISO(now = new Date()) {
  return toISO(now);
}

export function addDays(iso, n) {
  const d = fromISO(iso);
  d.setDate(d.getDate() + n);
  return toISO(d);
}

export function diffDays(fromIso, toIso) {
  return Math.round((fromISO(toIso) - fromISO(fromIso)) / 86400000);
}

// Remplace les lettres accentuées par leur équivalent sans accent en
// conservant la longueur (les index restent alignés avec le texte NFC).
export function fold(s) {
  return s
    .normalize('NFC')
    .split('')
    .map((c) => c.normalize('NFD').replace(/[̀-ͯ]/g, '') || c)
    .join('')
    .toLowerCase();
}

const WEEKDAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const MONTHS = {
  janvier: 1, janv: 1, jan: 1,
  fevrier: 2, fevr: 2, fev: 2,
  mars: 3,
  avril: 4, avr: 4,
  mai: 5,
  juin: 6,
  juillet: 7, juil: 7,
  aout: 8,
  septembre: 9, sept: 9, sep: 9,
  octobre: 10, oct: 10,
  novembre: 11, nov: 11,
  decembre: 12, dec: 12,
};
const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');

function nextWeekday(today, target, forceNext = false) {
  const d = fromISO(today);
  let delta = (target - d.getDay() + 7) % 7;
  if (delta === 0 || forceNext) delta = delta === 0 ? 7 : delta;
  return addDays(today, delta);
}

function safeDate(y, m, d) {
  const dt = new Date(y, m - 1, d);
  if (dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return toISO(dt);
}

function withYear(today, m, d, y) {
  if (y) {
    const year = y < 100 ? 2000 + y : y;
    return safeDate(year, m, d);
  }
  const ty = fromISO(today).getFullYear();
  const candidate = safeDate(ty, m, d);
  if (candidate && candidate < addDays(today, -7)) return safeDate(ty + 1, m, d);
  return candidate;
}

// Mots de liaison retirés avec la date ("pour demain", "avant le 12/10"...)
const LEAD = String.raw`(?:\b(?:pour|avant|d'ici|dici|au plus tard|deadline|echeance|due|le|a rendre)\s+)*`;

const RULES = [
  {
    re: /(\d{4})-(\d{2})-(\d{2})/,
    fn: (m) => safeDate(+m[1], +m[2], +m[3]),
  },
  {
    re: /\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/,
    fn: (m, t) => withYear(t, +m[2], +m[1], m[3] ? +m[3] : null),
  },
  {
    re: new RegExp(String.raw`\b(\d{1,2})(?:er)?\s+(${MONTH_RE})\.?(?:\s+(\d{4}))?\b`),
    fn: (m, t) => withYear(t, MONTHS[m[2]], +m[1], m[3] ? +m[3] : null),
  },
  { re: /\bapres[- ]demain\b/, fn: (m, t) => addDays(t, 2) },
  { re: /\bdemain\b/, fn: (m, t) => addDays(t, 1) },
  { re: /\b(?:aujourd'hui|aujourdhui|auj|ce soir|asap|today)\b/, fn: (m, t) => t },
  {
    re: /\bdans\s+(\d+)\s*(jours?|j|semaines?|sem|mois)\b/,
    fn: (m, t) => shift(t, +m[1], m[2]),
  },
  {
    re: /(?:^|\s)[+j]\+?(\d+)\s*(j|jours?|s|sem|semaines?|m|mois)?(?=\s|$|[,.;])/,
    fn: (m, t) => shift(t, +m[1], m[2] || 'j'),
  },
  {
    re: /\b(?:fin de (?:la )?semaine|fds|fin de sem)\b/,
    fn: (m, t) => nextWeekday(t, 5),
  },
  {
    re: /\bsemaine prochaine\b/,
    fn: (m, t) => nextWeekday(t, 1, true),
  },
  {
    re: /\b(?:fin du mois|fin de mois|fdm)\b/,
    fn: (m, t) => {
      const d = fromISO(t);
      return toISO(new Date(d.getFullYear(), d.getMonth() + 1, 0));
    },
  },
  {
    re: new RegExp(String.raw`\b(${WEEKDAYS.join('|')})(\s+prochain)?\b`),
    fn: (m, t) => nextWeekday(t, WEEKDAYS.indexOf(m[1]), Boolean(m[2])),
  },
];

function shift(today, n, unit) {
  if (/^(s|sem|semaines?)$/.test(unit)) return addDays(today, n * 7);
  if (/^(m|mois)$/.test(unit)) {
    const d = fromISO(today);
    d.setMonth(d.getMonth() + n);
    return toISO(d);
  }
  return addDays(today, n);
}

/**
 * Cherche une échéance dans le texte.
 * @returns {{date: string|null, text: string}} date ISO et texte nettoyé.
 */
export function extractDate(text, today = todayISO()) {
  const folded = fold(text);
  for (const rule of RULES) {
    const re = new RegExp(LEAD + rule.re.source, 'i');
    const m = folded.match(re);
    if (!m) continue;
    const inner = folded.slice(m.index).match(rule.re);
    const date = rule.fn(inner, today);
    if (!date) continue;
    const cleaned = (text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length))
      .replace(/\s{2,}/g, ' ')
      .trim();
    return { date, text: cleaned };
  }
  return { date: null, text };
}

const FR_DAYS = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'];
export function formatShort(iso) {
  if (!iso) return '';
  const d = fromISO(iso);
  return `${FR_DAYS[d.getDay()]} ${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
}
