// Bot Telegram : capture en 5 secondes depuis le téléphone.
// Mode "polling" par défaut : aucune URL publique nécessaire, fonctionne depuis
// le poste de travail tant que api.telegram.org est joignable.
import { handleCallback, handleText } from './bot.js';

export function createTelegram(repo, { token, allowedChatIds = [], log = console } = {}) {
  const api = async (method, body) => {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const json = await res.json();
    if (!json.ok) throw new Error(`Telegram ${method}: ${json.description}`);
    return json.result;
  };

  const keyboard = (buttons) =>
    buttons ? { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) } : undefined;

  const allowed = (chatId) => allowedChatIds.includes(String(chatId));

  async function handleUpdate(update) {
    if (update.callback_query) {
      const q = update.callback_query;
      const chatId = q.message?.chat?.id;
      if (!allowed(chatId)) return;
      const reply = handleCallback(repo, q.data, { channel: 'telegram' });
      await api('answerCallbackQuery', { callback_query_id: q.id });
      await api('editMessageText', {
        chat_id: chatId,
        message_id: q.message.message_id,
        text: reply.text,
        reply_markup: keyboard(reply.buttons),
      }).catch(() => api('sendMessage', { chat_id: chatId, text: reply.text, reply_markup: keyboard(reply.buttons) }));
      return;
    }

    const msg = update.message || update.edited_message;
    if (!msg) return;
    const chatId = msg.chat.id;
    if (!allowed(chatId)) {
      await api('sendMessage', {
        chat_id: chatId,
        text: `⛔ Chat non autorisé.\nAjoute TELEGRAM_ALLOWED_CHAT_IDS=${chatId} dans le fichier .env puis redémarre l'app.`,
      });
      return;
    }
    if (msg.voice || msg.audio) {
      await api('sendMessage', { chat_id: chatId, text: '🎙️ Les vocaux ne sont pas transcrits : utilise la dictée du clavier (micro) pour envoyer du texte.' });
      return;
    }
    const text = msg.text || msg.caption || '';
    // Message transféré : on garde la trace de l'auteur d'origine.
    const origin = msg.forward_origin?.sender_user?.first_name || msg.forward_from?.first_name || msg.forward_sender_name;
    const payload = origin && !text.startsWith('/') ? `${text}\n(transféré de ${origin})` : text;
    const reply = handleText(repo, payload, { channel: 'telegram', ref: `tg:${chatId}:${msg.message_id}` });
    await api('sendMessage', { chat_id: chatId, text: reply.text.slice(0, 4000), reply_markup: keyboard(reply.buttons), reply_to_message_id: msg.message_id });
  }

  let running = false;
  async function startPolling() {
    running = true;
    await api('deleteWebhook', {}).catch(() => {});
    const me = await api('getMe');
    log.info?.(`[telegram] bot @${me.username} connecté (polling)`);
    if (!allowedChatIds.length) log.warn?.('[telegram] TELEGRAM_ALLOWED_CHAT_IDS vide : écris au bot pour obtenir ton chat id.');
    let offset = 0;
    while (running) {
      try {
        const updates = await api('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'edited_message', 'callback_query'] });
        for (const u of updates) {
          offset = u.update_id + 1;
          await handleUpdate(u).catch((e) => log.error?.('[telegram]', e.message));
        }
      } catch (e) {
        log.error?.('[telegram] polling:', e.message);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  async function setWebhook(url, secret) {
    return api('setWebhook', { url, secret_token: secret, allowed_updates: ['message', 'edited_message', 'callback_query'] });
  }

  return { handleUpdate, startPolling, stop: () => (running = false), setWebhook, api };
}
