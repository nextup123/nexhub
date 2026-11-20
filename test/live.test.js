'use strict';

// Live updates (GET /stream) and alerts: who hears about what, and Telegram.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { startHub, stopAll } = require('./helpers');

const streams = [];
test.after(async () => { streams.forEach((s) => s.stop()); await stopAll(); });

/** Opens the event stream like the dashboard does and collects its events. */
async function listen(base, token) {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/stream`, { headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal });
  const events = [];
  let ended = false;
  const s = { status: res.status, events, get ended() { return ended; }, stop: () => ctrl.abort() };
  streams.push(s);
  if (res.status !== 200) return s;
  (async () => {
    const dec = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = (block.match(/^event: (.*)$/m) || [])[1];
          const data = (block.match(/^data: (.*)$/m) || [])[1];
          if (ev) events.push({ event: ev, data: JSON.parse(data) });
        }
      }
    } catch { /* aborted */ }
    ended = true;
  })();
  await until(() => events.some((e) => e.event === 'hello'));
  return s;
}
async function until(fn, ms = 2000) {
  const t = Date.now();
  while (!fn()) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); }
}
const settle = () => new Promise((r) => setTimeout(r, 150));

/** A stand-in for api.telegram.org that records what is sent. */
async function fakeTelegram() {
  const sent = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const method = req.url.split('/').pop();
      res.setHeader('Content-Type', 'application/json');
      if (!req.url.startsWith('/bot123:abc/')) return res.end(JSON.stringify({ ok: false, description: 'Unauthorized' }));
      if (method === 'sendMessage') { sent.push(JSON.parse(body)); return res.end(JSON.stringify({ ok: true, result: {} })); }
      if (method === 'getUpdates') return res.end(JSON.stringify({ ok: true, result: [{ message: { chat: { id: 111, type: 'private', first_name: 'Dhirendra' } } }, { message: { chat: { id: 111, type: 'private' } } }] }));
      return res.end(JSON.stringify({ ok: false }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { sent, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

const FORM = { name: 'Kiran Rao', company: 'Rao Electricals', email: 'kiran@rao.example', phone: '+91 98450 00000', product: 'NexC5', industry: 'Electronics', message: 'We want to automate PCB loading on two lines.' };
const BUG = { title: 'Drive J3 drops off EtherCAT', description: 'After 40 minutes of running', severity: 'high', machine: { machineId: 'b6b6c3a8-6f39-4b0e-9a0c-4e3f2b1a0c11', name: 'Cell 2' } };

test('live: dashboards hear about changes, and alerts only reach roles that may see them', async () => {
  const tg = await fakeTelegram();
  const hub = await startHub({ TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_CHAT_ID: '111, 222', TELEGRAM_API: tg.url });
  const founder = await hub.founder();
  const lead = await hub.person(founder, { name: 'Anil', email: 'anil@nextup.test', role: 'lead' });
  const emp = await hub.person(founder, { name: 'Ravi', email: 'ravi@nextup.test', role: 'employee' });
  const hr = await hub.person(founder, { name: 'Meena', email: 'meena@nextup.test', role: 'hr', team: 'People' });

  assert.strictEqual((await fetch(`${hub.base}/stream`)).status, 401, 'signed in only');
  const [sLead, sEmp, sHr] = await Promise.all([lead, emp, hr].map((p) => listen(hub.base, p.token)));

  // A change by anyone: every open dashboard is told to reload (no data in the event itself).
  await hub.call('POST', '/projects', { name: 'Welding cell' }, { token: lead.token });
  await until(() => [sLead, sEmp, sHr].every((s) => s.events.some((e) => e.event === 'change' && e.data.area === 'main')));
  assert.deepStrictEqual(Object.keys(sHr.events.find((e) => e.event === 'change').data), ['area']);

  // A website enquiry: founders and leads (enquiries.view), not employees or HR.
  assert.strictEqual((await hub.call('POST', '/contact', FORM)).status, 201);
  await until(() => sLead.events.some((e) => e.event === 'notify'));
  const n = sLead.events.find((e) => e.event === 'notify').data;
  assert.strictEqual(n.kind, 'enquiry');
  assert.match(n.title, /^New enquiry ENQ-\d+: Kiran Rao, Rao Electricals$/);
  assert.match(n.body, /\+91 98450 00000/);
  await settle();
  assert.ok(!sEmp.events.some((e) => e.event === 'notify'));
  assert.ok(!sHr.events.some((e) => e.event === 'notify'));

  // A bug report: everyone who sees bugs (lead, employee), not HR.
  assert.strictEqual((await hub.call('POST', '/apps/main_app/bugs', BUG)).status, 201);
  await until(() => sEmp.events.some((e) => e.event === 'notify' && e.data.kind === 'bug'));
  assert.match(sEmp.events.find((e) => e.data.kind === 'bug').data.title, /^New bug report MAIN-\d+ \(high\): Drive J3/);
  await until(() => sLead.events.some((e) => e.event === 'notify' && e.data.kind === 'bug'));
  await settle();
  assert.ok(!sHr.events.some((e) => e.event === 'notify'));

  // Telegram got both alerts, in every chat.
  await until(() => tg.sent.length === 4);
  assert.deepStrictEqual(tg.sent.map((m) => m.chat_id), ['111', '222', '111', '222']);
  assert.match(tg.sent[0].text, /<b>New enquiry ENQ-\d+: Kiran Rao, Rao Electricals<\/b>/);
  assert.match(tg.sent[2].text, /<b>New bug report MAIN-\d+/);

  // A role change applies to alerts at once: Anil, now an employee, no longer hears about enquiries.
  await hub.call('PATCH', `/users/${lead.user._id}`, { role: 'employee' }, { token: founder });
  const before = sLead.events.filter((e) => e.event === 'notify').length;
  await hub.call('POST', '/contact', { ...FORM, email: 'two@rao.example', message: 'A second line, also PCB loading.' }, { ip: '198.51.100.7' });
  await settle();
  assert.strictEqual(sLead.events.filter((e) => e.event === 'notify').length, before);

  // Switched off: the stream closes at the next alert.
  await hub.call('PATCH', `/users/${emp.user._id}`, { active: false }, { token: founder });
  await hub.call('POST', '/apps/main_app/bugs', { ...BUG, title: 'Another one', machine: { ...BUG.machine } });
  await until(() => sEmp.ended);
  tg.close();
});

test('live: Telegram setup helpers are for founders only', async () => {
  const tg = await fakeTelegram();
  const hub = await startHub({ TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_CHAT_ID: '111', TELEGRAM_API: tg.url });
  const founder = await hub.founder();
  const lead = await hub.person(founder, { name: 'Anil', email: 'anil@nextup.test', role: 'lead' });
  assert.strictEqual((await hub.call('POST', '/notifications/telegram/test', {}, { token: lead.token })).status, 403);
  assert.deepStrictEqual((await hub.call('GET', '/notifications/telegram', null, { token: founder })).body, { configured: true, botToken: true, chats: 1 });
  const chats = await hub.call('GET', '/notifications/telegram/chats', null, { token: founder });
  assert.deepStrictEqual(chats.body.chats, [{ id: '111', type: 'private', name: 'Dhirendra' }]);
  const t = await hub.call('POST', '/notifications/telegram/test', {}, { token: founder });
  assert.strictEqual(t.status, 200);
  assert.match(tg.sent[0].text, /Test alert from Dhirendra/);

  // Not set up: says what to do; a wrong token is reported, and the website form still works.
  const bare = await startHub();
  const f2 = await bare.founder();
  assert.strictEqual((await bare.call('POST', '/notifications/telegram/test', {}, { token: f2 })).status, 400);
  const wrong = await startHub({ TELEGRAM_BOT_TOKEN: '999:bad', TELEGRAM_CHAT_ID: '111', TELEGRAM_API: tg.url });
  const f3 = await wrong.founder();
  assert.strictEqual((await wrong.call('POST', '/notifications/telegram/test', {}, { token: f3 })).status, 502);
  assert.strictEqual((await wrong.call('POST', '/contact', FORM)).status, 201);
  tg.close();
});
