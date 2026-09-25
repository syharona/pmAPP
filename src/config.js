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

const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);

export const config = {
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '127.0.0.1',
  dbPath: process.env.DB_PATH || path.resolve(process.cwd(), 'data', 'pmapp.db'),
  appPassword: process.env.APP_PASSWORD || '',
  sessionSecret: process.env.SESSION_SECRET || process.env.APP_PASSWORD || 'pmapp-dev-secret',
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
