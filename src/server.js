import http from 'node:http';
import { config } from './config.js';
import { openDb } from './db.js';
import { createApp } from './app.js';
import { createTelegram } from './telegram.js';
import { createWhatsApp } from './whatsapp.js';

const repo = openDb(config.dbPath);

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
  console.info(`PM Cockpit prêt sur http://${config.host}:${config.port}`);
  if (!config.appPassword && config.host !== '127.0.0.1' && config.host !== 'localhost') {
    console.warn('⚠️  APP_PASSWORD non défini alors que le serveur écoute sur le réseau.');
  }
});
