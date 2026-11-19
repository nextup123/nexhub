'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createRateLimiter } = require('../src/rateLimit');
const { startHub, stopAll } = require('./helpers');

// `key: KEY` in a call means "signed in as the founder".
const KEY = 'founder';
async function start(overrides = {}) {
  const hub = await startHub(overrides);
  const token = await hub.founder();
  const call = (method, path, body, opts = {}) => hub.call(method, path, body, { ...opts, token: opts.key === KEY ? token : opts.key });
  call.hub = hub;
  call.founderToken = token;
  return call;
}
test.after(stopAll);

const form = (n = 1, extra = {}) => ({
  name: 'Rakesh Sharma', email: `rakesh${n}@example.com`, phone: '+91 98100 12345', company: 'Sharma Auto',
  industry: 'Automotive and auto components', product: 'NexR20', message: `Spot welding of seat frames, cell ${n}`, website: '', ...extra,
});

test('the limiter allows a burst, then refuses with a retry time', () => {
  const l = createRateLimiter({ windowMs: 1000, max: 2 });
  assert.ok(l.hit('a', 0).ok);
  assert.ok(l.hit('a', 10).ok);
  const third = l.hit('a', 20);
  assert.strictEqual(third.ok, false);
  assert.strictEqual(third.retryAfterSec, 1);
  assert.ok(l.hit('b', 20).ok, 'other keys are not affected');
  assert.ok(l.hit('a', 5000).ok, 'allowed again once the window has passed');
});

test('a valid form is stored with a reference number; bad input is refused', async () => {
  const call = await start();
  const r = await call('POST', '/contact', form(1));
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.body.ref, 'ENQ-1');
  assert.strictEqual((await call('POST', '/contact', form(2, { name: '' }), { ip: '203.0.113.2' })).status, 400);
  assert.strictEqual((await call('POST', '/contact', form(3, { email: 'not-an-email' }), { ip: '203.0.113.3' })).status, 400);
  const noReply = await call('POST', '/contact', form(4, { email: '', phone: '' }), { ip: '203.0.113.4' });
  assert.match(noReply.body.error, /email address or a phone/);
  assert.strictEqual((await call('POST', '/contact', form(5, { message: '' }), { ip: '203.0.113.5' })).status, 400);
});

test('the same message twice is stored once', async () => {
  const call = await start();
  const a = await call('POST', '/contact', form(1));
  const b = await call('POST', '/contact', form(1));
  assert.strictEqual(a.status, 201);
  assert.strictEqual(b.status, 200);
  assert.strictEqual(b.body.duplicate, true);
  assert.strictEqual(b.body.ref, a.body.ref);
  const list = await call('GET', '/contact-submissions', null, { key: KEY });
  assert.strictEqual(list.body.total, 1);
});

test('the honeypot field gets a fake success and nothing is stored', async () => {
  const call = await start();
  const r = await call('POST', '/contact', form(1, { website: 'http://spam.example' }));
  assert.strictEqual(r.status, 201);
  assert.strictEqual((await call('GET', '/contact-submissions', null, { key: KEY })).body.total, 0);
});

test('one visitor is limited to a burst of sends, others are not', async () => {
  const call = await start({ CONTACT_BURST: 3 });
  for (let i = 1; i <= 3; i += 1) assert.strictEqual((await call('POST', '/contact', form(i))).status, 201);
  const blocked = await call('POST', '/contact', form(4));
  assert.strictEqual(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  assert.strictEqual(blocked.headers.get('ratelimit-remaining'), '0');
  // Invalid tries count too, so a script can't keep probing.
  assert.strictEqual((await call('POST', '/contact', { name: '' })).status, 429);
  assert.strictEqual((await call('POST', '/contact', form(5), { ip: '198.51.100.7' })).status, 201);
});

test('daily caps per visitor and per email hold even when the burst limit allows it', async () => {
  const call = await start({ CONTACT_BURST: 100, CONTACT_DAILY: 4, CONTACT_PER_EMAIL_DAILY: 2 });
  for (let i = 1; i <= 4; i += 1) assert.strictEqual((await call('POST', '/contact', form(i, { phone: '' }))).status, 201);
  assert.strictEqual((await call('POST', '/contact', form(5, { phone: '' }))).status, 429);
  // Same email from many addresses
  const same = { email: 'one@example.com', phone: '' };
  assert.strictEqual((await call('POST', '/contact', form(10, same), { ip: '10.0.0.1' })).status, 201);
  assert.strictEqual((await call('POST', '/contact', form(11, same), { ip: '10.0.0.2' })).status, 201);
  assert.strictEqual((await call('POST', '/contact', form(12, same), { ip: '10.0.0.3' })).status, 429);
});

test('only the listed website may post when CONTACT_ORIGINS is set', async () => {
  const call = await start({ CONTACT_ORIGINS: ['https://nextuprobotics.com'] });
  assert.strictEqual((await call('POST', '/contact', form(1), { origin: 'https://evil.example' })).status, 403);
  assert.strictEqual((await call('POST', '/contact', form(1), { origin: 'https://nextuprobotics.com' })).status, 201);
});

test('enquiries need a signed-in founder or lead; HR and employees are refused', async () => {
  const call = await start();
  await call('POST', '/contact', form(1));
  assert.strictEqual((await call('GET', '/contact-submissions')).status, 401);
  assert.strictEqual((await call('GET', '/contact-submissions', null, { key: 'not-a-real-session-token-xyz' })).status, 401);
  const list = await call('GET', '/contact-submissions', null, { key: KEY });
  assert.strictEqual(list.body.submissions[0].name, 'Rakesh Sharma');
  assert.strictEqual(list.body.submissions[0].ipHash, undefined, 'visitor hash is never sent out');

  const { hub, founderToken } = call;
  const hrUser = await hub.person(founderToken, { name: 'Meena HR', email: 'hr@nextup.test', role: 'hr', team: 'People' });
  const emp = await hub.person(founderToken, { name: 'Ravi', email: 'ravi@nextup.test', role: 'employee' });
  const lead = await hub.person(founderToken, { name: 'Anil Lead', email: 'lead@nextup.test', role: 'lead' });
  assert.strictEqual((await hub.call('GET', '/contact-submissions', null, { token: hrUser.token })).status, 403);
  assert.strictEqual((await hub.call('GET', '/contact-submissions', null, { token: emp.token })).status, 403);
  assert.strictEqual((await hub.call('GET', '/contact-submissions', null, { token: lead.token })).status, 200);
  const id = list.body.submissions[0]._id;
  assert.strictEqual((await hub.call('DELETE', `/contact-submissions/${id}`, null, { token: lead.token })).status, 403, 'only a founder deletes');
});

test('the dashboard lists, filters, updates, notes, exports and deletes', async () => {
  const call = await start({ CONTACT_BURST: 100 });
  await call('POST', '/contact', form(1, { product: 'NexC5', company: 'Verma CNC' }));
  await call('POST', '/contact', form(2, { product: 'NexR20' }));
  await call('POST', '/contact', form(3, { product: 'NexR20', message: 'Buy cheap backlinks now' }));
  const opt = { key: KEY };

  const all = await call('GET', '/contact-submissions', null, opt);
  assert.strictEqual(all.body.total, 3);
  assert.deepStrictEqual(all.body.submissions.map((s) => s.ref), ['ENQ-3', 'ENQ-2', 'ENQ-1']);
  assert.strictEqual((await call('GET', '/contact-submissions?product=NexR20', null, opt)).body.total, 2);
  assert.strictEqual((await call('GET', '/contact-submissions?q=verma', null, opt)).body.total, 1);
  assert.strictEqual((await call('GET', '/contact-submissions?unread=true', null, opt)).body.total, 3);

  const spamId = all.body.submissions[0]._id;
  const firstId = all.body.submissions[2]._id;
  const p = await call('PATCH', `/contact-submissions/${firstId}`, { status: 'replied', starred: true }, opt);
  assert.strictEqual(p.body.submission.status, 'replied');
  assert.strictEqual(p.body.submission.starred, true);
  assert.ok(p.body.submission.readAt, 'answering marks it read');
  assert.strictEqual(p.body.submission.statusHistory.length, 2);
  assert.strictEqual((await call('PATCH', `/contact-submissions/${firstId}`, { status: 'bogus' }, opt)).status, 400);
  await call('PATCH', `/contact-submissions/${spamId}`, { status: 'spam' }, opt);

  assert.strictEqual((await call('GET', '/contact-submissions?status=inbox', null, opt)).body.total, 2);
  assert.strictEqual((await call('GET', '/contact-submissions?status=open', null, opt)).body.total, 1);

  const note = await call('POST', `/contact-submissions/${firstId}/notes`, { text: 'Called, sending a quote' }, opt);
  assert.strictEqual(note.status, 201);
  const one = await call('GET', `/contact-submissions/${firstId}`, null, opt);
  assert.strictEqual(one.body.submission.notes[0].text, 'Called, sending a quote');
  assert.strictEqual(one.body.related.length, 2, 'same phone number on the other two');

  const sum = await call('GET', '/contact-submissions/summary', null, opt);
  assert.strictEqual(sum.body.total, 2);
  assert.strictEqual(sum.body.spam, 1);
  assert.strictEqual(sum.body.byStatus.replied, 1);
  assert.strictEqual(sum.body.daily.length, 30);
  assert.strictEqual(sum.body.daily.at(-1).count, 2);

  const csv = await call('GET', '/contact-submissions/export.csv?status=inbox', null, opt);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.strictEqual(csv.body.trim().split('\r\n').length, 3);

  assert.strictEqual((await call('DELETE', `/contact-submissions/${spamId}`, null, opt)).status, 200);
  assert.strictEqual((await call('GET', `/contact-submissions/${spamId}`, null, opt)).status, 404);
});

test('CSV cells that look like formulas are made safe', async () => {
  const call = await start();
  await call('POST', '/contact', form(1, { company: '=HYPERLINK("http://x")' }));
  const csv = await call('GET', '/contact-submissions/export.csv', null, { key: KEY });
  assert.match(csv.body, /"'=HYPERLINK\(""http:\/\/x""\)"/);
});
