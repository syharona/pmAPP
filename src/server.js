import http from 'node:http';
import { config, configErrors } from './config.js';
import { openDb } from './db.js';
import { driverName } from './sqlite.js';
import path from 'node:path';
import { scheduleBackups } from './backup.js';
import { createApp } from './app.js';
import { createTelegram } from './telegram.js';
import { createWhatsApp } from './whatsapp.js';

const errors = configErrors();
if (errors.length) {
  console.error(`Configuration refusée (app accessible en ligne) :\n- ${errors.join('\n- ')}`);
  process.exit(1);
}

const repo = openDb(config.dbPath);
scheduleBackups(repo, path.join(path.dirname(config.dbPath), 'backups'));

let telegram = null;
if (config.telegram.token) {
  telegram = createTelegram(repo, config.telegram);
  if (config.telegram.mode === 'webhook') {
    if (!config.publicUrl || !config.telegram.webhookSecret) {
      console.error('[telegram] mode webhook : PUBLIC_URL et TELEGRAM_WEBHOOK_SECRET sont requis.');
    } else {
      telegram
        .setWebhook(`${config.publicUrl}/api/telegram/webhook`, config.telegram.webhookSecret)
        .then(() => console.info('[telegram] webhook enregistré'))
        .catch((e) => console.error('[telegram]', e.message));
    }
  } else {
    telegram.startPolling().catch((e) => console.error('[telegram] démarrage impossible :', e.message));
  }
}

const whatsapp = config.whatsapp.token && config.whatsapp.phoneNumberId ? createWhatsApp(repo, config.whatsapp) : null;

const server = http.createServer(createApp(repo, config, { telegram, whatsapp }));
server.listen(config.port, config.host, () => {
  console.info(`PM Cockpit prêt sur http://${config.host}:${config.port} (base : ${driverName}, fuseau : ${config.timezone})`);
});
