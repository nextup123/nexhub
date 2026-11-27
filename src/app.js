'use strict';

const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const { createCache } = require('./cache');
const { createLive, createNotifier } = require('./notify');
const M = require('./models');
const defaultConfig = require('./config');
const { createContactRoutes } = require('./contact');
const { createAuth } = require('./auth');
const { createHr } = require('./hr');
const { createProduction } = require('./production');
const { createProjects, migrateClients } = require('./projects');
const { createImporter, importRoutes } = require('./importer');
const { createInventory } = require('./inventory');
const { can, isTop, ROLES, ROLE_LABELS } = require('./permissions');

const toInt = (v, fallback, max) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? Math.min(n, max ?? n) : fallback;
};
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// No sign-in yet (keys come later). Who made a change is whatever name the caller gives:
// the mobile app sends X-User-Name, release scripts send publishedBy.
const who = (req, fallback = 'maintainer') => (req.user && req.user.name) || String(req.get('x-user-name') || req.body?.by || fallback).trim().slice(0, 80) || fallback;

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** What a machine (vendor) may see about its own reports. */
const PUBLIC_BUG_FIELDS = { _id: 0, number: 1, title: 1, status: 1, fixedInVersion: 1, clientReportId: 1, createdAt: 1, updatedAt: 1 };

// Answers that are never cached: time-sensitive, not JSON, or already cheap.
const NO_CACHE = [/^\/stream$/, /^\/notifications\//, /^\/health$/, /^\/auth\/me$/, /^\/attendance\/today/, /^\/contact-submissions\/export\.csv$/, /^\/inventory\/(export\.(xlsx|pdf)|template\.csv)$/, /^\/attachments\//];
// Bug reports, releases and machines: the robots write these often, so they have their own generation.
const ROBOT_AREA = /^\/(apps|bugs|attachments)(\/|$)/;

// Changes that do not tell the open dashboards to reload: sign-ins, and the robots' heartbeats.
const QUIET = [/^\/auth\/(login|logout)$/, /^\/apps\/[^/]+\/machines\/heartbeat$/];

function createApp({ db, config = defaultConfig, cache = createCache(), live = createLive(), notifier = null }) {
  notifier = notifier || createNotifier({ config, live });
  const apps = db.collection('apps');
  const releases = db.collection('releases');
  const bugs = db.collection('bug_reports');
  const machines = db.collection('machines');
  const updateEvents = db.collection('update_events');
  const counters = db.collection('counters');
  const attachments = db.collection('attachments');

  const app = express();
  // Behind Render's proxy: read the visitor's address from X-Forwarded-For (rate limits need it).
  app.set('trust proxy', config.TRUST_PROXY);
  app.use(cors({ exposedHeaders: ['Retry-After', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'Content-Disposition'], maxAge: 86400 }));
  // Not the live stream: it must reach the dashboard as each event is written.
  app.use(compression({ filter: (req, res) => !/\/stream$/.test(req.path) && compression.filter(req, res) }));
  app.use(express.json({ limit: '2mb' }));

  const api = express.Router();
  const auth = createAuth({ db, config, cache });

  // Any change moves the cache generation on before its answer goes out (see src/cache.js), so the
  // dashboard's next read after a save never gets an older cached answer.
  api.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const name = ROBOT_AREA.test(req.path) ? 'robot' : 'main';
    // Tell the open dashboards something changed (they reload through the API, with their own permissions).
    if (!QUIET.some((rx) => rx.test(req.path))) res.on('finish', () => { if (res.statusCode < 400) live.emit('change', { area: name }); });
    if (!cache.enabled) return next();
    const end = res.end;
    let once = false;
    res.end = function endAfterBump(...args) {
      if (once) return end.apply(res, args);
      once = true;
      cache.bump(name).finally(() => end.apply(res, args));
      return res;
    };
    next();
  });

  api.use(auth.loadUser);

  // Cached GET answers: per person (after their own permission checks once passed) and per address.
  api.use(wrap(async (req, res, next) => {
    if (req.method !== 'GET' || !cache.enabled || NO_CACHE.some((rx) => rx.test(req.path))) return next();
    const gens = req.cacheGens !== undefined ? req.cacheGens : await cache.generations();
    if (!gens) return next();
    const robot = ROBOT_AREA.test(req.path) || req.path === '/home' ? gens.robot : '-';
    const key = `r:${gens.main}:${robot}:${req.user ? req.user._id : 'anon'}:${crypto.createHash('sha256').update(req.originalUrl).digest('hex')}`;
    const hit = await cache.get(key);
    if (hit) {
      res.set('Cache-Control', 'no-store');
      res.set('X-Cache', 'hit');
      return res.type('json').send(hit);
    }
    res.set('X-Cache', 'miss');
    const json = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode !== 200) return json(body);
      const text = JSON.stringify(body);
      cache.set(key, text, cache.ttl);
      return res.type('json').send(text);
    };
    next();
  }));

  /**
   * Maintainer routes (bugs, releases, machines). Someone signed in must have the permission.
   * Nobody signed in: allowed as before, unless LOCK_BUG_ROUTES is on (then only RELEASE_TOKEN
   * may publish releases). The robots' own routes do not use this.
   */
  const guard = (perm) => (req, res, next) => {
    if (req.user) return can(req.user, perm) ? next() : res.status(403).json({ error: 'Your role does not allow this' });
    if (!config.LOCK_BUG_ROUTES) return next();
    const token = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (perm === 'releases.publish' && config.RELEASE_TOKEN && token
      && crypto.timingSafeEqual(crypto.createHash('sha256').update(token).digest(), crypto.createHash('sha256').update(config.RELEASE_TOKEN).digest())) return next();
    return res.status(401).json({ error: 'Please sign in' });
  };

  api.get('/health', (req, res) => res.json({ ok: true, db: 'connected', time: new Date().toISOString() }));

  // Every /apps/:appId route checks the app exists and the key may use it.
  let appCache = { at: 0, ids: new Set(), docs: [] };
  async function appList() {
    if (Date.now() - appCache.at > 10000) {
      const docs = await apps.find({}).sort({ _id: 1 }).toArray();
      appCache = { at: Date.now(), ids: new Set(docs.map((d) => d._id)), docs };
    }
    return appCache;
  }
  api.param('appId', (req, res, next, appId) => {
    appList().then(({ ids, docs }) => {
      if (!ids.has(appId)) return res.status(404).json({ error: `Unknown app ${appId}` });
      req.appDoc = docs.find((d) => d._id === appId);
      next();
    }, next);
  });

  // ── Apps ────────────────────────────────────────────────────
  api.get('/apps', wrap(async (req, res) => res.json({ apps: (await appList()).docs })));

  api.put('/apps/:id', guard('apps.manage'), wrap(async (req, res) => {
    const { value, error } = M.normaliseApp({ ...req.body, _id: req.params.id });
    if (error) return res.status(400).json({ error });
    const { _id, ...rest } = value;
    await apps.updateOne({ _id }, { $set: { ...rest, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } }, { upsert: true });
    appCache.at = 0;
    res.json({ app: await apps.findOne({ _id }) });
  }));

  // ── Releases ────────────────────────────────────────────────
  api.get('/apps/:appId/releases', wrap(async (req, res) => {
    const filter = { appId: req.params.appId };
    // The installed apps ask for status=published; the mobile app lists everything.
    if (req.query.status) filter.status = { $in: String(req.query.status).split(',') };
    if (req.query.channel === 'stable') filter.channel = 'stable';
    let list = await releases.find(filter).sort({ releasedAt: -1 }).limit(toInt(req.query.limit, 50, 200)).toArray();
    if (req.query.after) list = list.filter((r) => M.compareVersions(r.version, String(req.query.after).replace(/^v/i, '')) > 0);
    list.sort((a, b) => M.compareVersions(b.version, a.version));
    res.json({ releases: list });
  }));

  api.get('/apps/:appId/releases/:version', wrap(async (req, res) => {
    const filter = { appId: req.params.appId, version: req.params.version.replace(/^v/i, '') };
    const release = await releases.findOne(filter);
    if (!release) return res.status(404).json({ error: 'Release not found' });
    res.json({ release });
  }));

  // Create or replace the notes for one version (release script, GitHub Action, mobile app).
  api.put('/apps/:appId/releases/:version', guard('releases.publish'), wrap(async (req, res) => {
    const { value, error } = M.normaliseRelease({ ...req.body, version: req.params.version }, req.params.appId);
    if (error) return res.status(400).json({ error });
    if (!value.publishedBy) value.publishedBy = who(req);
    const now = new Date();
    await releases.updateOne(
      { appId: value.appId, version: value.version },
      { $set: { ...value, updatedAt: now }, $setOnInsert: { createdAt: now } },
      { upsert: true },
    );
    // Publishing closes the loop on the bugs the release fixes.
    let linkedBugs = [];
    if (value.status === 'published') {
      linkedBugs = [...new Set(value.changes.flatMap((c) => c.bugs))];
      for (const number of linkedBugs) {
        const bug = await bugs.findOne({ number, appId: value.appId });
        if (!bug || ['closed', 'wont_fix', 'duplicate'].includes(bug.status)) continue;
        await bugs.updateOne({ _id: bug._id }, {
          $set: { status: 'released', fixedInVersion: value.version, updatedAt: now },
          $push: { statusHistory: { status: 'released', by: value.publishedBy, at: now, note: `Fixed in ${value.version}` } },
        });
      }
    }
    res.json({ release: await releases.findOne({ appId: value.appId, version: value.version }), linkedBugs });
  }));

  // ── Bug reports ─────────────────────────────────────────────
  async function nextBugNumber(appDoc) {
    const r = await counters.findOneAndUpdate(
      { _id: `bug:${appDoc._id}` }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' },
    );
    return { seq: r.seq, number: `${appDoc.bugPrefix}-${r.seq}` };
  }

  api.post('/apps/:appId/bugs', wrap(async (req, res) => {
    const { value, error } = M.normaliseBugReport(req.body, req.params.appId);
    if (error) return res.status(400).json({ error });
    // Offline machines resend until they get an answer: same clientReportId → same bug.
    if (value.clientReportId) {
      const existing = await bugs.findOne({ clientReportId: value.clientReportId }, { projection: PUBLIC_BUG_FIELDS });
      if (existing) return res.json({ bug: existing, duplicate: true });
    }
    const now = new Date();
    const { seq, number } = await nextBugNumber(req.appDoc);
    const doc = {
      ...value,
      seq,
      number,
      status: 'new',
      priority: null,
      assignee: null,
      labels: [],
      duplicateOf: null,
      fixedInVersion: null,
      comments: [],
      statusHistory: [{ status: 'new', by: value.reporter.name || 'reporter', at: now, note: '' }],
      submittedBy: value.reporter.name || value.machine.name || 'unknown',
      createdAt: now,
      updatedAt: now,
    };
    try {
      await bugs.insertOne(doc);
    } catch (err) {
      if (err.code === 11000 && value.clientReportId) {
        const existing = await bugs.findOne({ clientReportId: value.clientReportId }, { projection: PUBLIC_BUG_FIELDS });
        if (existing) return res.json({ bug: existing, duplicate: true });
      }
      throw err;
    }
    notifier.bug(doc, req.appDoc.name);
    res.status(201).json({ bug: Object.fromEntries(Object.keys(PUBLIC_BUG_FIELDS).filter((k) => k !== '_id').map((k) => [k, doc[k]])) });
  }));

  api.get('/apps/:appId/bugs', guard('bugs.view'), wrap(async (req, res) => {
    const filter = { appId: req.params.appId };
    const { status, severity, category, machineId, assignee, version, q } = req.query;
    if (status === 'open') filter.status = { $in: M.OPEN_BUG_STATUSES };
    else if (status) filter.status = { $in: String(status).split(',') };
    if (severity) filter.severity = { $in: String(severity).split(',') };
    if (category) filter.category = String(category);
    if (machineId) filter['machine.machineId'] = String(machineId);
    if (assignee) filter.assignee = String(assignee);
    if (version) filter.appVersion = String(version);
    if (q) {
      const rx = { $regex: escapeRegex(String(q).slice(0, 100)), $options: 'i' };
      filter.$or = [{ title: rx }, { description: rx }, { number: rx }, { 'reporter.company': rx }, { 'machine.name': rx }];
    }
    const limit = toInt(req.query.limit, 30, 100) || 30;
    const page = Math.max(1, toInt(req.query.page, 1));
    const [total, list] = await Promise.all([
      bugs.countDocuments(filter),
      bugs.find(filter, { projection: { context: 0, comments: 0, statusHistory: 0 } })
        .sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
    ]);
    res.json({ bugs: list, total, page, limit });
  }));

  api.get('/bugs/:number', guard('bugs.view'), wrap(async (req, res) => {
    const bug = await bugs.findOne({ number: req.params.number.toUpperCase() });
    if (!bug) return res.status(404).json({ error: 'Bug not found' });
    if (req.user && !can(req.user, 'bugs.triage')) bug.reporter = { name: bug.reporter?.name, company: bug.reporter?.company };
    res.json({ bug });
  }));

  api.patch('/bugs/:number', guard('bugs.triage'), wrap(async (req, res) => {
    const { value, error } = M.normaliseBugPatch(req.body || {});
    if (error) return res.status(400).json({ error });
    const number = req.params.number.toUpperCase();
    const bug = await bugs.findOne({ number });
    if (!bug) return res.status(404).json({ error: 'Bug not found' });
    const now = new Date();
    const update = { $set: { ...value, updatedAt: now } };
    if (value.status && value.status !== bug.status) {
      update.$push = { statusHistory: { status: value.status, by: who(req), at: now, note: String(req.body.note || '').slice(0, 500) } };
    }
    await bugs.updateOne({ _id: bug._id }, update);
    res.json({ bug: await bugs.findOne({ _id: bug._id }) });
  }));

  api.post('/bugs/:number/comments', guard('bugs.comment'), wrap(async (req, res) => {
    const text = String(req.body?.text || '').trim().slice(0, 4000);
    if (!text) return res.status(400).json({ error: 'text is required' });
    const comment = { author: String(req.body.author || who(req)).slice(0, 80), text, internal: req.body.internal !== false, at: new Date() };
    const r = await bugs.updateOne({ number: req.params.number.toUpperCase() }, { $push: { comments: comment }, $set: { updatedAt: comment.at } });
    if (!r.matchedCount) return res.status(404).json({ error: 'Bug not found' });
    res.status(201).json({ comment });
  }));

  // ── Screenshots on a bug ────────────────────────────────────
  // One image per request (base64 in JSON), so a weak connection only repeats one image.
  // Same clientAttachmentId again → the stored one is returned, nothing is added twice.
  const attachmentMeta = (a) => ({ id: a._id, name: a.name, type: a.type, size: a.size, url: `/api/v1/attachments/${a._id}`, createdAt: a.createdAt });

  api.post(['/bugs/:number/attachments', '/apps/:appId/bugs/:number/attachments'], wrap(async (req, res) => {
    const number = req.params.number.toUpperCase();
    const bug = await bugs.findOne({ number }, { projection: { _id: 1, appId: 1, attachments: 1 } });
    if (!bug) return res.status(404).json({ error: 'Bug not found' });
    const { value, error } = M.normaliseAttachment(req.body);
    if (error) return res.status(400).json({ error });
    if (value.clientAttachmentId) {
      const existing = await attachments.findOne({ clientAttachmentId: value.clientAttachmentId }, { projection: { data: 0 } });
      if (existing) return res.json({ attachment: attachmentMeta(existing), duplicate: true });
    }
    if ((bug.attachments || []).length >= M.MAX_IMAGES_PER_BUG) {
      return res.status(400).json({ error: `A bug can have at most ${M.MAX_IMAGES_PER_BUG} images` });
    }
    const now = new Date();
    const doc = { _id: crypto.randomUUID(), bugNumber: number, appId: bug.appId, ...value, createdAt: now };
    try {
      await attachments.insertOne(doc);
    } catch (err) {
      if (err.code === 11000 && value.clientAttachmentId) {
        const existing = await attachments.findOne({ clientAttachmentId: value.clientAttachmentId }, { projection: { data: 0 } });
        if (existing) return res.json({ attachment: attachmentMeta(existing), duplicate: true });
      }
      throw err;
    }
    const meta = attachmentMeta(doc);
    await bugs.updateOne({ _id: bug._id }, { $push: { attachments: meta }, $set: { updatedAt: now } });
    res.status(201).json({ attachment: meta });
  }));

  // The image itself. The id is random and only appears on the bug, so the address works in an <img> tag.
  api.get('/attachments/:id', wrap(async (req, res) => {
    const a = await attachments.findOne({ _id: req.params.id });
    if (!a) return res.status(404).json({ error: 'Image not found' });
    res.set('Content-Type', a.type);
    res.set('Content-Disposition', `inline; filename="${a.name.replace(/"/g, '')}"`);
    res.set('Cache-Control', 'private, max-age=86400, immutable');
    res.send(Buffer.from(a.data, 'base64'));
  }));

  // A machine checks on the reports it sent (status, fixed in which version).
  api.get('/apps/:appId/machines/:machineId/bugs', wrap(async (req, res) => {
    const list = await bugs.find({ appId: req.params.appId, 'machine.machineId': req.params.machineId }, { projection: PUBLIC_BUG_FIELDS })
      .sort({ createdAt: -1 }).limit(200).toArray();
    // Comments marked as not internal are the maintainer's answer to the vendor.
    res.json({ bugs: list });
  }));

  // ── Machines ────────────────────────────────────────────────
  async function touchMachine(m, extra = {}) {
    const now = new Date();
    const { machineId, ...rest } = m;
    const set = { ...rest, ...extra, lastSeenAt: now };
    Object.keys(set).forEach((k) => (set[k] === '' || set[k] === null) && delete set[k]);
    await machines.updateOne({ _id: machineId }, { $set: set, $setOnInsert: { firstSeenAt: now } }, { upsert: true });
  }

  api.post('/apps/:appId/machines/heartbeat', wrap(async (req, res) => {
    const { value, error } = M.normaliseHeartbeat(req.body, req.params.appId);
    if (error) return res.status(400).json({ error });
    await touchMachine(value);
    res.json({ ok: true });
  }));

  api.get('/apps/:appId/machines', guard('bugs.view'), wrap(async (req, res) => {
    res.json({ machines: await machines.find({ appId: req.params.appId }).sort({ lastSeenAt: -1 }).limit(500).toArray() });
  }));

  // ── Update records ──────────────────────────────────────────
  api.post('/apps/:appId/update-events', wrap(async (req, res) => {
    const { value, error } = M.normaliseUpdateEvent(req.body, req.params.appId);
    if (error) return res.status(400).json({ error });
    const existing = await updateEvents.findOne({ clientEventId: value.clientEventId });
    if (existing) return res.json({ event: existing, duplicate: true });
    await updateEvents.insertOne({ ...value, receivedAt: new Date() });
    await touchMachine({ machineId: value.machineId, appId: value.appId }, {
      version: value.result === 'success' ? value.toVersion : value.fromVersion,
      lastUpdate: { toVersion: value.toVersion, result: value.result, at: value.finishedAt },
    });
    res.status(201).json({ event: value });
  }));

  api.get('/apps/:appId/update-events', guard('bugs.view'), wrap(async (req, res) => {
    const filter = { appId: req.params.appId };
    if (req.query.machineId) filter.machineId = String(req.query.machineId);
    if (req.query.result) filter.result = { $in: String(req.query.result).split(',') };
    if (req.query.version) filter.toVersion = String(req.query.version);
    const list = await updateEvents.find(filter, { projection: { log: 0 } }).sort({ finishedAt: -1 }).limit(toInt(req.query.limit, 100, 500)).toArray();
    res.json({ events: list });
  }));

  // ── Dashboard for the mobile app ────────────────────────────
  api.get('/apps/:appId/summary', guard('bugs.view'), wrap(async (req, res) => {
    const appId = req.params.appId;
    const byStatus = {};
    for (const s of M.BUG_STATUSES) byStatus[s] = await bugs.countDocuments({ appId, status: s });
    const openBySeverity = {};
    for (const s of M.SEVERITIES) openBySeverity[s] = await bugs.countDocuments({ appId, status: { $in: M.OPEN_BUG_STATUSES }, severity: s });
    const all = await releases.find({ appId, status: 'published' }).toArray();
    const latest = all.sort((a, b) => M.compareVersions(b.version, a.version))[0] || null;
    const machineList = await machines.find({ appId }).toArray();
    const versions = {};
    for (const m of machineList) versions[m.version || 'unknown'] = (versions[m.version || 'unknown'] || 0) + 1;
    const failedUpdates = await updateEvents.find({ appId, result: { $in: ['failed', 'rolled_back'] } }, { projection: { log: 0 } })
      .sort({ finishedAt: -1 }).limit(10).toArray();
    res.json({
      appId,
      bugs: { byStatus, openBySeverity, open: M.OPEN_BUG_STATUSES.reduce((n, s) => n + byStatus[s], 0) },
      latestRelease: latest && { version: latest.version, title: latest.title, releasedAt: latest.releasedAt },
      machines: { total: machineList.length, onLatest: latest ? (versions[latest.version] || 0) : 0, versions },
      failedUpdates,
    });
  }));

  // Lists the enums so the mobile app builds its pickers from the server.
  api.get('/meta', (req, res) => res.json({
    changeTypes: M.CHANGE_TYPES, releaseStatuses: M.RELEASE_STATUSES, channels: M.CHANNELS,
    bugCategories: M.BUG_CATEGORIES, severities: M.SEVERITIES, frequencies: M.FREQUENCIES,
    bugStatuses: M.BUG_STATUSES, openBugStatuses: M.OPEN_BUG_STATUSES, updateResults: M.UPDATE_RESULTS,
    roles: ROLES, roleLabels: ROLE_LABELS,
    contactStatuses: M.CONTACT_STATUSES, openContactStatuses: M.OPEN_CONTACT_STATUSES,
  }));

  // Company dashboard: accounts, HR, production, website enquiries.
  api.use(auth.router);
  const hr = createHr({ db, config, requireUser: auth.requireUser, publicUser: auth.publicUser });
  api.use(hr.router);
  const productionHooks = {};
  const production = createProduction({ db, config, requireUser: auth.requireUser, hooks: productionHooks });
  api.use(production.router);
  const projectsApi = createProjects({ db, config, requireUser: auth.requireUser });
  api.use(projectsApi.router);
  productionHooks.logToProject = projectsApi.svc.logToProject;
  const importer = createImporter({ db, projectsSvc: projectsApi.svc, productionSvc: production.svc });
  api.use(importRoutes({ requireUser: auth.requireUser, importer }));
  api.use(createInventory({ db, requireUser: auth.requireUser, open: !!config.INVENTORY_OPEN }).router);
  api.use(createContactRoutes({ db, config, requireUser: auth.requireUser, notifier }));

  // ── Live updates for the dashboard ──────────────────────────
  // Server-sent events. The dashboard reads it with fetch (so the token stays in the Authorization
  // header, never in an address). `change`: reload what is on screen. `notify`: a new enquiry or bug
  // report, only to people whose role may see it, checked again against the session at that moment.
  api.get('/stream', auth.requireUser(), (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
    res.flushHeaders?.();
    const sid = req.sessionId;
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    res.write('retry: 5000\n\n');
    send('hello', { at: new Date().toISOString() });
    let closed = false;
    const close = () => { if (!closed) { closed = true; cleanup(); res.end(); } };
    const onChange = (c) => send('change', { area: c.area });
    const onNotify = async (n) => {
      try {
        const u = await auth.userForSession(sid);
        if (!u) return close();
        if (can(u, n.perm)) send('notify', { kind: n.kind, id: n.id, ref: n.ref, title: n.title, body: n.lines.filter(Boolean).join('\n') });
      } catch { /* the next ping tries again */ }
    };
    let beats = 0;
    // A comment every 25 s keeps proxies from closing a quiet connection; every 4th also checks the session.
    const timer = setInterval(async () => {
      res.write(': ping\n\n');
      if (++beats % 4 === 0) { try { if (!(await auth.userForSession(sid))) close(); } catch { /* keep going */ } }
    }, 25000);
    function cleanup() { clearInterval(timer); live.off('change', onChange); live.off('notify', onNotify); }
    live.on('change', onChange);
    live.on('notify', onNotify);
    req.on('close', () => { closed = true; cleanup(); });
  });

  // ── Telegram alerts (founders and the super user) ───────────
  const topOnly = (req, res, next) => (isTop(req.user) ? next() : res.status(403).json({ error: 'Only a founder can do this' }));
  api.get('/notifications/telegram', auth.requireUser(), topOnly, (req, res) => res.json(notifier.telegramStatus()));
  api.get('/notifications/telegram/chats', auth.requireUser(), topOnly, wrap(async (req, res) => {
    try { res.json({ chats: await notifier.recentChats() }); }
    catch (err) { res.status(502).json({ error: `Telegram: ${err.message}` }); }
  }));
  api.post('/notifications/telegram/test', auth.requireUser(), topOnly, wrap(async (req, res) => {
    const status = notifier.telegramStatus();
    if (!status.configured) return res.status(400).json({ error: 'Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID on the server first' });
    const sent = await notifier.toTelegram(`<b>Nextup hub</b>\nTest alert from ${req.user.name.replace(/[<>&]/g, '')}. New website enquiries and bug reports will arrive here.`);
    if (!sent) return res.status(502).json({ error: 'Telegram did not accept the message. Check the bot token and chat id, and that you pressed Start in the bot.' });
    res.json({ ok: true, sent });
  }));

  // One call for the dashboard's home page and menu badges: only what this person may see.
  api.get('/home', auth.requireUser(), wrap(async (req, res) => {
    const u = req.user;
    const out = { roles: ROLES, roleLabels: ROLE_LABELS };
    if (can(u, 'enquiries.view')) {
      const sub = db.collection('contact_submissions');
      out.enquiries = { unread: await sub.countDocuments({ readAt: null, status: { $ne: 'spam' } }), open: await sub.countDocuments({ status: { $in: M.OPEN_CONTACT_STATUSES } }) };
    }
    if (can(u, 'bugs.view')) {
      out.bugs = {};
      for (const a of (await appList()).docs) {
        out.bugs[a._id] = { name: a.name, open: await bugs.countDocuments({ appId: a._id, status: { $in: M.OPEN_BUG_STATUSES } }), critical: await bugs.countDocuments({ appId: a._id, status: { $in: M.OPEN_BUG_STATUSES }, severity: { $in: ['critical', 'high'] } }) };
      }
    }
    if (can(u, 'projects.view')) out.projects = await projectsApi.homeCounts(u);
    const people = await hr.scopeUsers(u);
    const pending = await db.collection('leave_requests').find({ status: 'pending', userId: { $in: people.map((p) => p._id) } }).toArray();
    const byId = new Map(people.map((p) => [p._id, p]));
    out.approvals = pending.filter((l) => byId.get(l.userId) && hr.canDecide(u, byId.get(l.userId))).length;
    res.json(out);
  }));

  // Bug reports of every app in one list, for the dashboard.
  api.get('/bugs', guard('bugs.view'), wrap(async (req, res) => {
    const filter = {};
    const { status, severity, appId, q } = req.query;
    if (appId) filter.appId = String(appId);
    if (status === 'open') filter.status = { $in: M.OPEN_BUG_STATUSES };
    else if (status) filter.status = { $in: String(status).split(',') };
    if (severity) filter.severity = { $in: String(severity).split(',') };
    if (q) {
      const rx = { $regex: escapeRegex(String(q).slice(0, 100)), $options: 'i' };
      filter.$or = [{ title: rx }, { description: rx }, { number: rx }, { 'reporter.company': rx }, { 'machine.name': rx }];
    }
    const limit = toInt(req.query.limit, 50, 200) || 50;
    const page = Math.max(1, toInt(req.query.page, 1));
    const [total, list] = await Promise.all([
      bugs.countDocuments(filter),
      bugs.find(filter, { projection: { context: 0, comments: 0, statusHistory: 0 } }).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
    ]);
    // Reporter phone and email are customer data: only for people who triage.
    const lean = can(req.user, 'bugs.triage') || !req.user ? list : list.map((b) => ({ ...b, reporter: { name: b.reporter?.name, company: b.reporter?.company } }));
    res.json({ bugs: lean, total, page, limit });
  }));

  app.use('/api/v1', api);
  app.use((req, res) => res.status(404).json({ error: `No route for ${req.method} ${req.originalUrl}` }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error('[HTTP]', err);
    res.status(status).json({ error: status >= 500 ? 'Server error' : err.message });
  });
  // Run once at start: creates, updates or switches off the hidden super user (see auth.js).
  app.locals.ensureSuperuser = auth.ensureSuperuser;
  // Run once at start, before the super user: brings data from older versions up to date.
  app.locals.migrate = async (log = console) => { await migrateClients(db, log); if (cache.enabled) await cache.bumpAll(); };
  app.locals.cache = cache;
  app.locals.live = live;
  return app;
}

module.exports = { createApp };
