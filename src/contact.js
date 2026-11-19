'use strict';

/**
 * Website contact form.
 *
 *   POST /contact                         public: the Nextup website sends the form here
 *   GET  /contact-submissions             list with filters and paging          (founder, lead)
 *   GET  /contact-submissions/summary     counts for the dashboard              (founder, lead)
 *   GET  /contact-submissions/export.csv  everything matching the filters, CSV  (founder, lead)
 *   GET  /contact-submissions/:id         one enquiry                           (founder, lead)
 *   PATCH  /contact-submissions/:id       status, starred, read, assignee, tags (founder, lead)
 *   POST   /contact-submissions/:id/notes internal note                         (founder, lead)
 *   DELETE /contact-submissions/:id       remove for good                       (founder)
 *
 * The admin routes need a signed-in user (src/auth.js) whose role allows it (src/permissions.js).
 *
 * Spam protection on POST /contact, in order:
 *   1. Origin check (CONTACT_ORIGINS), when set.
 *   2. Per visitor address: CONTACT_BURST sends per 10 minutes (kept in memory, counts every try).
 *   3. Honeypot field `website`: bots get a normal-looking answer and nothing is stored.
 *   4. Per visitor address: CONTACT_DAILY stored enquiries per 24 hours (checked in MongoDB, so a restart does not reset it).
 *   5. Per email / phone: CONTACT_PER_EMAIL_DAILY per 24 hours, whatever address it comes from.
 *   6. The same message from the same person within 24 hours is stored once.
 */

const crypto = require('crypto');
const express = require('express');
const M = require('./models');
const { createRateLimiter, rateLimit } = require('./rateLimit');

const DAY = 24 * 3600 * 1000;
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const toInt = (v, fallback, max) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? Math.min(n, max ?? n) : fallback;
};
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();
const who = (req) => (req.user && req.user.name) || 'admin';

/** List views leave out the long and internal fields. */
const LIST_PROJECTION = { notes: 0, statusHistory: 0, ipHash: 0, messageHash: 0, userAgent: 0 };

function createContactRoutes({ db, config, requireUser }) {
  const canView = requireUser('enquiries.view');
  const canEdit = requireUser('enquiries.edit');
  const canDelete = requireUser('enquiries.delete');
  const submissions = db.collection('contact_submissions');
  const counters = db.collection('counters');
  const router = express.Router();

  const ipHash = (req) => crypto.createHash('sha256').update(`${config.IP_SALT}:${req.ip || 'unknown'}`).digest('hex').slice(0, 32);

  // ── Public: the website's form ──────────────────────────────
  const burst = createRateLimiter({ windowMs: 10 * 60 * 1000, max: config.CONTACT_BURST });
  const tooMany = 'You have sent several messages in a short time. Please wait a few minutes and try again.';

  const checkOrigin = (req, res, next) => {
    if (!config.CONTACT_ORIGINS.length) return next();
    const origin = String(req.get('origin') || '').replace(/\/$/, '');
    if (config.CONTACT_ORIGINS.includes(origin)) return next();
    res.status(403).json({ error: 'This form can only be sent from the Nextup website' });
  };

  async function nextRef() {
    const r = await counters.findOneAndUpdate({ _id: 'contact' }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
    return { seq: r.seq, ref: `ENQ-${r.seq}` };
  }

  router.post('/contact', checkOrigin, rateLimit(burst, { key: (req) => ipHash(req), message: tooMany }), wrap(async (req, res) => {
    const { value, error, honeypot } = M.normaliseContact(req.body);
    // A bot filled the hidden field: answer like a success so it moves on, store nothing.
    if (honeypot) return res.status(201).json({ ok: true, ref: 'ENQ-0' });
    if (error) return res.status(400).json({ error });

    const now = new Date();
    const since = new Date(now.getTime() - DAY);
    const hash = ipHash(req);
    const sender = [value.email && { email: value.email }, value.phone && { phone: value.phone }].filter(Boolean);

    // Daily caps, from the database so they survive a restart.
    const [fromAddress, fromSender] = await Promise.all([
      submissions.countDocuments({ ipHash: hash, createdAt: { $gte: since } }),
      submissions.countDocuments({ $or: sender, createdAt: { $gte: since } }),
    ]);
    if (fromAddress >= config.CONTACT_DAILY || fromSender >= config.CONTACT_PER_EMAIL_DAILY) {
      res.set('Retry-After', String(3600));
      return res.status(429).json({ error: 'We already have several messages from you today and will be in touch soon.', retryAfterSec: 3600 });
    }

    // Pressed Send twice, or sent the same text again: keep one.
    const messageHash = sha256(`${value.email || value.phone}|${value.message.toLowerCase().replace(/\s+/g, ' ')}`).toString('hex').slice(0, 32);
    const same = await submissions.findOne({ messageHash, createdAt: { $gte: since } }, { projection: { ref: 1 } });
    if (same) return res.status(200).json({ ok: true, ref: same.ref, duplicate: true });

    const { seq, ref } = await nextRef();
    const doc = {
      _id: crypto.randomUUID(),
      ref,
      seq,
      ...value,
      status: 'new',
      starred: false,
      readAt: null,
      assignee: null,
      tags: [],
      notes: [],
      statusHistory: [{ status: 'new', by: 'website', at: now }],
      messageHash,
      ipHash: hash,
      userAgent: String(req.get('user-agent') || '').slice(0, 300),
      createdAt: now,
      updatedAt: now,
    };
    await submissions.insertOne(doc);
    res.status(201).json({ ok: true, ref });
  }));

  // ── Admin: list, search, export ─────────────────────────────
  function listFilter(q) {
    const filter = {};
    if (q.status === 'open') filter.status = { $in: M.OPEN_CONTACT_STATUSES };
    else if (q.status === 'inbox') filter.status = { $nin: ['spam'] };
    else if (q.status) filter.status = { $in: String(q.status).split(',') };
    if (q.product) filter.product = String(q.product);
    if (q.industry) filter.industry = String(q.industry);
    if (q.starred === 'true') filter.starred = true;
    if (q.unread === 'true') filter.readAt = null;
    const from = q.from && new Date(q.from);
    const to = q.to && new Date(q.to);
    if ((from && !Number.isNaN(from.getTime())) || (to && !Number.isNaN(to.getTime()))) {
      filter.createdAt = {};
      if (from && !Number.isNaN(from.getTime())) filter.createdAt.$gte = from;
      if (to && !Number.isNaN(to.getTime())) filter.createdAt.$lt = to;
    }
    if (q.q) {
      const rx = { $regex: escapeRegex(String(q.q).trim().slice(0, 100)), $options: 'i' };
      filter.$or = [{ name: rx }, { email: rx }, { phone: rx }, { company: rx }, { message: rx }, { ref: rx }];
    }
    return filter;
  }

  router.get('/contact-submissions', canView, wrap(async (req, res) => {
    const filter = listFilter(req.query);
    const limit = toInt(req.query.limit, 50, 200) || 50;
    const page = Math.max(1, toInt(req.query.page, 1));
    const sort = req.query.sort === 'oldest' ? { createdAt: 1 } : { createdAt: -1 };
    const [total, list] = await Promise.all([
      submissions.countDocuments(filter),
      submissions.find(filter, { projection: LIST_PROJECTION }).sort(sort).skip((page - 1) * limit).limit(limit).toArray(),
    ]);
    res.json({ submissions: list, total, page, limit });
  }));

  // Counts for the dashboard. Enquiries are a few per day, so they are added up here
  // instead of with an aggregation pipeline (works the same on every MongoDB plan).
  router.get('/contact-submissions/summary', canView, wrap(async (req, res) => {
    const days = Math.min(365, Math.max(7, toInt(req.query.days, 30)));
    const tz = Number.isFinite(Number(req.query.tzOffset)) ? Number(req.query.tzOffset) : 0; // minutes, as Date#getTimezoneOffset
    const now = Date.now();
    const docs = await submissions.find({}, { projection: { status: 1, product: 1, industry: 1, createdAt: 1, readAt: 1, statusHistory: 1 } })
      .sort({ createdAt: -1 }).limit(50000).toArray();

    const byStatus = Object.fromEntries(M.CONTACT_STATUSES.map((s) => [s, 0]));
    const byProduct = {};
    const byIndustry = {};
    const dayKey = (d) => new Date(new Date(d).getTime() - tz * 60000).toISOString().slice(0, 10);
    const daily = {};
    for (let i = days - 1; i >= 0; i -= 1) daily[dayKey(now - i * DAY)] = 0;
    let unread = 0; let last7 = 0; let prev7 = 0; let answered = 0; let responseHours = []; let real = 0;

    for (const d of docs) {
      byStatus[d.status] = (byStatus[d.status] || 0) + 1;
      if (d.status === 'spam') continue;
      real += 1;
      if (!d.readAt) unread += 1;
      const age = now - new Date(d.createdAt).getTime();
      if (age < 7 * DAY) last7 += 1;
      else if (age < 14 * DAY) prev7 += 1;
      const k = dayKey(d.createdAt);
      if (k in daily) daily[k] += 1;
      if (age < days * DAY) {
        byProduct[d.product || 'Not given'] = (byProduct[d.product || 'Not given'] || 0) + 1;
        byIndustry[d.industry || 'Not given'] = (byIndustry[d.industry || 'Not given'] || 0) + 1;
      }
      const first = (d.statusHistory || []).find((h) => h.status === 'replied' || h.status === 'closed');
      if (first) {
        answered += 1;
        responseHours.push((new Date(first.at) - new Date(d.createdAt)) / 3600000);
      }
    }
    responseHours = responseHours.sort((a, b) => a - b);
    const median = responseHours.length ? responseHours[Math.floor(responseHours.length / 2)] : null;
    const sorted = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));

    res.json({
      total: real,
      spam: byStatus.spam,
      open: M.OPEN_CONTACT_STATUSES.reduce((n, s) => n + byStatus[s], 0),
      unread,
      last7,
      prev7,
      answered,
      replyRate: real ? answered / real : null,
      medianReplyHours: median,
      byStatus,
      byProduct: sorted(byProduct),
      byIndustry: sorted(byIndustry),
      daily: Object.entries(daily).map(([date, count]) => ({ date, count })),
      days,
    });
  }));

  router.get('/contact-submissions/export.csv', canView, wrap(async (req, res) => {
    const list = await submissions.find(listFilter(req.query), { projection: LIST_PROJECTION }).sort({ createdAt: -1 }).limit(50000).toArray();
    const cols = ['ref', 'createdAt', 'status', 'name', 'email', 'phone', 'company', 'industry', 'product', 'message', 'assignee', 'starred'];
    // Leading = + - @ would run as a formula in Excel: prefix them with '.
    const cell = (v) => {
      let s = v instanceof Date ? v.toISOString() : v == null ? '' : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [cols.join(','), ...list.map((d) => cols.map((c) => cell(d[c])).join(','))].join('\r\n');
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="nextup-enquiries-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(`﻿${csv}`);
  }));

  // ── Admin: one enquiry ──────────────────────────────────────
  const findOne = (id) => submissions.findOne({ _id: String(id) }, { projection: { ipHash: 0, messageHash: 0 } });

  router.get('/contact-submissions/:id', canView, wrap(async (req, res) => {
    const doc = await findOne(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Enquiry not found' });
    // How many other enquiries the same person sent, to spot repeat customers and spammers.
    const sender = [doc.email && { email: doc.email }, doc.phone && { phone: doc.phone }].filter(Boolean);
    const others = sender.length
      ? await submissions.find({ $or: sender }, { projection: { ref: 1, createdAt: 1, status: 1 } }).sort({ createdAt: -1 }).limit(20).toArray()
      : [];
    res.json({ submission: doc, related: others.filter((o) => o._id !== doc._id) });
  }));

  router.patch('/contact-submissions/:id', canEdit, wrap(async (req, res) => {
    const { value, error } = M.normaliseContactPatch(req.body || {});
    if (error) return res.status(400).json({ error });
    const doc = await submissions.findOne({ _id: String(req.params.id) }, { projection: { status: 1, readAt: 1 } });
    if (!doc) return res.status(404).json({ error: 'Enquiry not found' });
    const now = new Date();
    const { read, ...rest } = value;
    const set = { ...rest, updatedAt: now };
    if (read === true && !doc.readAt) set.readAt = now;
    if (read === false) set.readAt = null;
    // Answering an enquiry also marks it read.
    if (rest.status && rest.status !== 'new' && !doc.readAt) set.readAt = now;
    const update = { $set: set };
    if (rest.status && rest.status !== doc.status) {
      update.$push = { statusHistory: { status: rest.status, by: who(req), at: now } };
    }
    await submissions.updateOne({ _id: doc._id }, update);
    res.json({ submission: await findOne(doc._id) });
  }));

  router.post('/contact-submissions/:id/notes', canEdit, wrap(async (req, res) => {
    const textValue = String(req.body?.text || '').trim().slice(0, 4000);
    if (!textValue) return res.status(400).json({ error: 'text is required' });
    const note = { id: crypto.randomUUID(), author: who(req), text: textValue, at: new Date() };
    const r = await submissions.updateOne({ _id: String(req.params.id) }, { $push: { notes: note }, $set: { updatedAt: note.at } });
    if (!r.matchedCount) return res.status(404).json({ error: 'Enquiry not found' });
    res.status(201).json({ note });
  }));

  router.delete('/contact-submissions/:id', canDelete, wrap(async (req, res) => {
    const r = await submissions.deleteOne({ _id: String(req.params.id) });
    if (!r.deletedCount) return res.status(404).json({ error: 'Enquiry not found' });
    res.json({ ok: true });
  }));

  return router;
}

module.exports = { createContactRoutes };
