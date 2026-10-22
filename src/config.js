import fs from 'node:fs';
import path from 'node:path';

// Chargement minimaliste d'un fichier .env (pas de dépendance externe).
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m || line.trim().startsWith('#')) continue;
    let value = m[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

loadDotEnv(path.resolve(process.cwd(), '.env'));

// Les dates (« aujourd'hui », retards…) se calculent dans ce fuseau, même sur un serveur en UTC.
process.env.TZ = process.env.APP_TIMEZONE || process.env.TZ || 'Europe/Paris';

const host = process.env.HOST || '127.0.0.1';
// Exposé = accessible depuis le réseau ou Internet : on durcit la configuration.
const exposed = process.env.NODE_ENV === 'production' || !['127.0.0.1', 'localhost', '::1'].includes(host);

const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);

export const config = {
  port: Number(process.env.PORT || 3000),
  host,
  exposed,
  timezone: process.env.TZ,
  // Derrière un proxy (Render…) : adresse IP du client et HTTPS lus dans les en-têtes X-Forwarded-*.
  trustProxy: process.env.TRUST_PROXY === '1' || Boolean(process.env.RENDER),
  proxyHops: Number(process.env.TRUST_PROXY_HOPS) || 1,
  dbPath: process.env.DB_PATH || path.resolve(process.cwd(), 'data', 'pmapp.db'),
  appPassword: process.env.APP_PASSWORD || '',
  // Facultatif : à défaut, un secret aléatoire est généré et conservé dans la base.
  sessionSecret: process.env.SESSION_SECRET || '',
  ingestToken: process.env.INGEST_TOKEN || '',
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/$/, ''),

  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    allowedChatIds: list(process.env.TELEGRAM_ALLOWED_CHAT_IDS),
    // "polling" (fonctionne derrière un pare-feu, sans URL publique) ou "webhook"
    mode: process.env.TELEGRAM_MODE || 'polling',
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || '',
  },

  whatsapp: {
    token: process.env.WHATSAPP_TOKEN || '',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || '',
    appSecret: process.env.WHATSAPP_APP_SECRET || '',
    allowedNumbers: list(process.env.WHATSAPP_ALLOWED_NUMBERS),
  },

  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    model: process.env.ANTHROPIC_MODEL || 'claude-opus-5',
  },
};

/** Refuse une configuration dangereuse quand l'app est exposée. */
export function configErrors(c = config) {
  const errors = [];
  if (!c.exposed) return errors;
  if (c.appPassword.length < 12) errors.push('APP_PASSWORD est obligatoire en ligne (12 caractères minimum).');
  if (c.sessionSecret && c.sessionSecret.length < 32) errors.push('SESSION_SECRET doit faire au moins 32 caractères (ou ne pas être défini).');
  if (c.ingestToken && c.ingestToken.length < 24) errors.push('INGEST_TOKEN doit faire au moins 24 caractères.');
  if (c.telegram.token && c.telegram.mode === 'webhook' && c.telegram.webhookSecret.length < 16)
    errors.push('TELEGRAM_WEBHOOK_SECRET (16 caractères minimum) est obligatoire en mode webhook.');
  if (c.whatsapp.token && !c.whatsapp.appSecret) errors.push('WHATSAPP_APP_SECRET est obligatoire en ligne (vérification de signature).');
  return errors;
}
