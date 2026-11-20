'use strict';

/**
 * Live updates and alerts.
 *
 * live: an in-process event bus. Every change made through the API sends `change` (the open
 * dashboards reload what they show, through the API, so every role check still applies); a new
 * website enquiry or bug report sends `notify` to the dashboards of people whose role may see it.
 * The dashboard listens on GET /api/v1/stream (src/app.js). One server instance (Render's free
 * plan) is assumed: with several, each instance only tells its own dashboards.
 *
 * Telegram (optional): TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID (one id, or several separated by
 * commas) send the same alerts to a phone. Sending never delays or fails the request that caused it.
 */

const { EventEmitter } = require('events');

function createLive() {
  const bus = new EventEmitter();
  bus.setMaxListeners(0);
  return bus;
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const cut = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

function createNotifier({ config, live, log = console, fetchImpl = (...a) => fetch(...a) }) {
  const token = config.TELEGRAM_BOT_TOKEN || '';
  const chats = String(config.TELEGRAM_CHAT_ID || '').split(',').map((s) => s.trim()).filter(Boolean);
  const api = (config.TELEGRAM_API || 'https://api.telegram.org').replace(/\/$/, '');

  async function telegram(method, body) {
    const res = await fetchImpl(`${api}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.description || `Telegram answered ${res.status}`);
    return data.result;
  }

  /** Sends one HTML message to every configured chat. Returns how many got it. */
  async function toTelegram(html) {
    if (!token || !chats.length) return 0;
    let sent = 0;
    for (const chat_id of chats) {
      try { await telegram('sendMessage', { chat_id, text: html, parse_mode: 'HTML', disable_web_page_preview: true }); sent += 1; }
      catch (err) { log.warn(`[notify] Telegram to ${chat_id}: ${err.message}`); }
    }
    return sent;
  }

  /** An alert: to the open dashboards allowed to see it, and to Telegram. Never throws. */
  function alert(n) {
    live.emit('notify', n);
    const html = [`<b>${esc(n.title)}</b>`, ...n.lines.filter(Boolean).map(esc)].join('\n');
    return toTelegram(html).catch(() => 0);
  }

  return {
    telegramStatus: () => ({ configured: !!token && chats.length > 0, botToken: !!token, chats: chats.length }),
    toTelegram,
    /** Chats that have messaged the bot lately: how to find the TELEGRAM_CHAT_ID to put on Render. */
    async recentChats() {
      if (!token) throw new Error('Set TELEGRAM_BOT_TOKEN on the server first');
      const updates = await telegram('getUpdates', { limit: 100, allowed_updates: ['message', 'channel_post', 'my_chat_member'] });
      const seen = new Map();
      for (const u of updates || []) {
        const c = (u.message || u.channel_post || u.my_chat_member || {}).chat;
        if (c && !seen.has(c.id)) seen.set(c.id, { id: String(c.id), type: c.type, name: c.title || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.username || '' });
      }
      return [...seen.values()];
    },

    enquiry(doc) {
      return alert({
        kind: 'enquiry', perm: 'enquiries.view', id: doc._id, ref: doc.ref,
        title: `New enquiry ${doc.ref}: ${doc.name}${doc.company ? `, ${doc.company}` : ''}`,
        lines: [
          [doc.product, doc.industry].filter(Boolean).join(' · '),
          [doc.phone, doc.email].filter(Boolean).join(' · '),
          cut(doc.message, 300),
        ],
      });
    },
    bug(doc, appName) {
      return alert({
        kind: 'bug', perm: 'bugs.view', id: doc.number, ref: doc.number,
        title: `New bug report ${doc.number} (${doc.severity}): ${cut(doc.title, 120)}`,
        lines: [
          [appName, doc.machine?.name, doc.reporter?.company].filter(Boolean).join(' · '),
          cut(doc.description, 300),
        ],
      });
    },
  };
}

module.exports = { createLive, createNotifier };
