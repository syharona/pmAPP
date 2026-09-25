// WhatsApp via l'API WhatsApp Business Cloud (Meta).
// Nécessite une URL publique (webhook) et un numéro WhatsApp Business.
// Les boutons deviennent des "réponses rapides" numérotées (WhatsApp limite à 3 boutons).
import { handleCallback, handleText } from './bot.js';

export function createWhatsApp(repo, { token, phoneNumberId, verifyToken, allowedNumbers = [], log = console } = {}) {
  // Dernières propositions de boutons par numéro, pour répondre "1", "2"...
  const pending = new Map();

  async function send(to, text) {
    const res = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text.slice(0, 4000) } }),
    });
    if (!res.ok) log.error?.('[whatsapp] envoi:', res.status, await res.text());
  }

  function render(from, reply) {
    const flat = (reply.buttons || []).flat();
    if (!flat.length) {
      pending.delete(from);
      return reply.text;
    }
    pending.set(from, flat);
    return `${reply.text}\n\n${flat.map((b, i) => `${i + 1}. ${b.text}`).join('\n')}\n(réponds par le numéro)`;
  }

  function verify(query) {
    if (query.get('hub.mode') === 'subscribe' && verifyToken && query.get('hub.verify_token') === verifyToken) {
      return query.get('hub.challenge');
    }
    return null;
  }

  async function handleWebhook(body) {
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        for (const msg of change.value?.messages || []) {
          const from = msg.from;
          if (!allowedNumbers.includes(from)) {
            log.warn?.(`[whatsapp] numéro non autorisé : ${from}`);
            continue;
          }
          const text = msg.text?.body || msg.button?.text || '';
          const choice = /^\s*(\d{1,2})\s*$/.exec(text);
          let reply;
          if (choice && pending.has(from)) {
            const btn = pending.get(from)[Number(choice[1]) - 1];
            reply = btn ? handleCallback(repo, btn.data, { channel: 'whatsapp' }) : { text: 'Choix invalide.' };
          } else if (msg.type !== 'text') {
            reply = { text: 'Seuls les messages texte sont pris en charge (utilise la dictée du clavier).' };
          } else {
            reply = handleText(repo, text, { channel: 'whatsapp', ref: `wa:${msg.id}` });
          }
          await send(from, render(from, reply));
        }
      }
    }
  }

  return { verify, handleWebhook, send };
}
