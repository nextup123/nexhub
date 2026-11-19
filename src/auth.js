'use strict';

/**
 * Accounts and sign-in for the company dashboard.
 *
 *   GET  /auth/status            public: { needsSetup } (true until the first founder exists)
 *   POST /auth/setup             public, once: { setupKey, name, email, password } creates the first founder.
 *                                setupKey must equal SETUP_KEY (or ADMIN_KEY) from the server's environment.
 *   POST /auth/login             { email, password, remember } -> { token, user, permissions }
 *   POST /auth/logout
 *   GET  /auth/me
 *   POST /auth/password          { current, password } change your own password
 *   PATCH /auth/me               { name, phone } your own details
 *
 *   GET   /users                 directory (everyone signed in); HR records only for founder/hr
 *   POST  /users                 add a person (founder, hr)
 *   PATCH /users/:id             role, team, title, active, HR records (founder, hr)
 *   POST  /users/:id/password    set a temporary password; they must change it at next sign-in (founder, hr)
 *
 * Super user: a hidden account above Founder, made from SUPERUSER_EMAIL and SUPERUSER_PASSWORD in the
 * server's environment (ensureSuperuser, run at start). It can do everything, is left out of every list,
 * cannot be changed from the dashboard, and is switched off again when those variables are removed.
 *
 * Sessions: a random token sent as `Authorization: Bearer <token>`. Only its SHA-256 is stored
 * (collection `sessions`, removed by MongoDB when it expires). Passwords: scrypt with a random salt.
 */

const crypto = require('crypto');
const express = require('express');
const { ROLES, SUPERUSER, can, permissionsOf, isTop } = require('./permissions');
const { createRateLimiter } = require('./rateLimit');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const sha256hex = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const str = (v, max) => (v === undefined || v === null ? '' : String(v).trim().slice(0, max));
const EMAIL_RE = /^[^\s@<>()[\],;:"]{1,64}@[^\s@<>()[\],;:"]+\.[A-Za-z]{2,}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ── Passwords ─────────────────────────────────────────────────
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${salt.toString('base64')}$${hash.toString('base64')}`;
}
function verifyPassword(password, stored) {
  const [kind, n, salt, hash] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const got = crypto.scryptSync(String(password), Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: SCRYPT.r, p: SCRYPT.p });
  return crypto.timingSafeEqual(got, expected);
}
function passwordProblem(p) {
  if (typeof p !== 'string' || p.length < 8) return 'The password needs at least 8 characters';
  if (p.length > 200) return 'The password is too long';
  if (/^(.)\1+$/.test(p) || /^(password|12345678|nextup)/i.test(p)) return 'Choose a password that is harder to guess';
  return null;
}
// A dummy hash so a wrong email takes as long as a wrong password (no account probing by timing).
const DUMMY_HASH = hashPassword(crypto.randomBytes(12).toString('hex'));

// ── What others may see about a person ────────────────────────
function publicUser(u, viewer) {
  if (!u) return null;
  const out = {
    _id: u._id, name: u.name, email: u.email, phone: u.phone || '', role: u.role, team: u.team || '',
    title: u.title || '', active: u.active !== false,
  };
  const self = viewer && viewer._id === u._id;
  if (self || can(viewer, 'users.hr_records')) {
    out.hr = u.hr || {};
    out.mustChangePassword = !!u.mustChangePassword;
    out.createdAt = u.createdAt;
    out.lastLoginAt = u.lastLoginAt || null;
  }
  return out;
}

function normaliseUser(b, { partial = false } = {}) {
  const out = {};
  if (!partial || b.name !== undefined) {
    out.name = str(b.name, 80);
    if (out.name.length < 2) return { error: 'Name is required' };
  }
  if (!partial || b.email !== undefined) {
    out.email = str(b.email, 120).toLowerCase();
    if (!EMAIL_RE.test(out.email)) return { error: 'A valid email is required' };
  }
  if (!partial || b.role !== undefined) {
    if (!ROLES.includes(b.role)) return { error: `role must be one of ${ROLES.join(', ')}` };
    out.role = b.role;
  }
  if (b.phone !== undefined) out.phone = str(b.phone, 30);
  if (b.team !== undefined) out.team = str(b.team, 60);
  if (b.title !== undefined) out.title = str(b.title, 80);
  if (b.active !== undefined) out.active = b.active !== false;
  if (b.hr !== undefined && b.hr && typeof b.hr === 'object') {
    const joinedOn = str(b.hr.joinedOn, 10);
    if (joinedOn && !DATE_RE.test(joinedOn)) return { error: 'joinedOn must look like 2026-04-01' };
    out.hr = {
      employeeId: str(b.hr.employeeId, 30),
      joinedOn: joinedOn || null,
      birthday: DATE_RE.test(str(b.hr.birthday, 10)) ? str(b.hr.birthday, 10) : null,
      emergencyContact: str(b.hr.emergencyContact, 160),
      address: str(b.hr.address, 300),
    };
  }
  return { value: out };
}

function createAuth({ db, config }) {
  const users = db.collection('users');
  const sessions = db.collection('sessions');
  const router = express.Router();
  const setupKey = config.SETUP_KEY || config.ADMIN_KEY || '';

  // ── Middleware ──────────────────────────────────────────────
  /** Reads the Bearer token if there is one; sets req.user. Never refuses. */
  async function loadUser(req, res, next) {
    try {
      const token = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
      if (token && token.length >= 20) {
        const s = await sessions.findOne({ _id: sha256hex(token) });
        if (s && new Date(s.expiresAt) > new Date()) {
          const u = await users.findOne({ _id: s.userId });
          if (u && u.active !== false) { req.user = u; req.sessionId = s._id; }
        }
      }
      next();
    } catch (err) { next(err); }
  }
  /** Signed in, and (if given) allowed one of the permissions. */
  const requireUser = (...perms) => (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Please sign in' });
    if (req.user.mustChangePassword && !/^\/auth\/(password|me|logout)$/.test(req.path)) {
      return res.status(403).json({ error: 'Change your temporary password first', mustChangePassword: true });
    }
    if (perms.length && !perms.some((p) => can(req.user, p))) return res.status(403).json({ error: 'Your role does not allow this' });
    res.set('Cache-Control', 'no-store');
    next();
  };

  // ── Sign-in ─────────────────────────────────────────────────
  const tries = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10 });

  async function startSession(user, remember, req) {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (remember ? 30 : 1) * 24 * 3600 * 1000);
    await sessions.insertOne({ _id: sha256hex(token), userId: user._id, createdAt: now, expiresAt, userAgent: str(req.get('user-agent'), 200) });
    await users.updateOne({ _id: user._id }, { $set: { lastLoginAt: now } });
    return { token, expiresAt };
  }
  // Hidden accounts (the super user) are never counted, listed or editable.
  const VISIBLE = { hidden: { $ne: true } };

  /** Creates, updates or switches off the hidden super user from the environment. Safe to run on every start. */
  async function ensureSuperuser(log = console) {
    const email = config.SUPERUSER_EMAIL;
    const password = config.SUPERUSER_PASSWORD;
    const existing = await users.find({ hidden: true }).toArray();
    if (!email || !password) {
      for (const u of existing.filter((x) => x.active !== false)) {
        await users.updateOne({ _id: u._id }, { $set: { active: false, updatedAt: new Date() } });
        await sessions.deleteMany({ userId: u._id });
        log.log('[superuser] SUPERUSER_EMAIL / SUPERUSER_PASSWORD are not set: the super user is switched off');
      }
      return null;
    }
    if (!EMAIL_RE.test(email)) { log.warn('[superuser] SUPERUSER_EMAIL is not a valid email; no super user'); return null; }
    const pw = passwordProblem(password);
    if (pw) { log.warn(`[superuser] SUPERUSER_PASSWORD is too weak (${pw.toLowerCase()}); no super user`); return null; }
    const clash = await users.findOne({ email, hidden: { $ne: true } });
    if (clash) { log.warn('[superuser] SUPERUSER_EMAIL already belongs to a normal account; use another email'); return null; }
    const now = new Date();
    // Only one super user: an old one under a different email is switched off.
    for (const u of existing.filter((x) => x.email !== email && x.active !== false)) {
      await users.updateOne({ _id: u._id }, { $set: { active: false, updatedAt: now } });
      await sessions.deleteMany({ userId: u._id });
    }
    const current = existing.find((x) => x.email === email);
    if (!current) {
      const user = { _id: crypto.randomUUID(), name: config.SUPERUSER_NAME, email, role: SUPERUSER, hidden: true, team: '', title: '', phone: '', hr: {},
        active: true, passwordHash: hashPassword(password), mustChangePassword: false, createdAt: now, updatedAt: now };
      await users.insertOne(user);
      log.log('[superuser] created');
      return user;
    }
    const set = { name: config.SUPERUSER_NAME, role: SUPERUSER, active: true, mustChangePassword: false, updatedAt: now };
    const passwordChanged = !verifyPassword(password, current.passwordHash);
    if (passwordChanged) set.passwordHash = hashPassword(password);
    await users.updateOne({ _id: current._id }, { $set: set });
    if (passwordChanged || current.active === false) await sessions.deleteMany({ userId: current._id });
    return users.findOne({ _id: current._id });
  }

  const me = (u) => ({ user: publicUser(u, u), permissions: permissionsOf(u.role) });

  router.get('/auth/status', wrap(async (req, res) => {
    res.json({ needsSetup: (await users.countDocuments(VISIBLE)) === 0, setupKeyConfigured: !!setupKey, company: config.COMPANY_NAME, tz: config.COMPANY_TZ });
  }));

  router.post('/auth/setup', wrap(async (req, res) => {
    const r = tries.hit(`setup:${req.ip}`);
    if (!r.ok) return res.status(429).json({ error: 'Too many tries. Wait a few minutes.', retryAfterSec: r.retryAfterSec });
    if ((await users.countDocuments(VISIBLE)) > 0) return res.status(409).json({ error: 'Setup is already done. Sign in instead.' });
    if (!setupKey) return res.status(503).json({ error: 'Set SETUP_KEY (or ADMIN_KEY) on the server first, then use it here once.' });
    const given = sha256hex(str(req.body?.setupKey, 200));
    if (!crypto.timingSafeEqual(Buffer.from(given), Buffer.from(sha256hex(setupKey)))) return res.status(401).json({ error: 'Wrong setup key' });
    const { value, error } = normaliseUser({ ...req.body, role: 'founder' });
    if (error) return res.status(400).json({ error });
    const pw = passwordProblem(req.body.password);
    if (pw) return res.status(400).json({ error: pw });
    const now = new Date();
    const user = { _id: crypto.randomUUID(), ...value, team: value.team || 'Management', title: value.title || 'Founder', active: true, passwordHash: hashPassword(req.body.password), hr: {}, createdAt: now, updatedAt: now };
    await users.insertOne(user);
    res.status(201).json({ ...(await startSession(user, false, req)), ...me(user) });
  }));

  router.post('/auth/login', wrap(async (req, res) => {
    const email = str(req.body?.email, 120).toLowerCase();
    const a = tries.hit(`ip:${req.ip}`);
    const b = tries.hit(`email:${email}`);
    if (!a.ok || !b.ok) {
      res.set('Retry-After', String(Math.max(a.retryAfterSec, b.retryAfterSec)));
      return res.status(429).json({ error: 'Too many sign-in attempts. Wait a few minutes and try again.' });
    }
    const user = email ? await users.findOne({ email }) : null;
    const ok = verifyPassword(String(req.body?.password || ''), user ? user.passwordHash : DUMMY_HASH);
    if (!user || !ok) return res.status(401).json({ error: 'Wrong email or password' });
    if (user.active === false) return res.status(403).json({ error: 'This account is switched off. Ask HR.' });
    tries.forgive(`ip:${req.ip}`); tries.forgive(`email:${email}`);
    res.json({ ...(await startSession(user, req.body.remember === true, req)), ...me(user) });
  }));

  router.post('/auth/logout', requireUser(), wrap(async (req, res) => {
    await sessions.deleteOne({ _id: req.sessionId });
    res.json({ ok: true });
  }));

  router.get('/auth/me', requireUser(), (req, res) => res.json({ ...me(req.user), tz: config.COMPANY_TZ }));

  router.patch('/auth/me', requireUser(), wrap(async (req, res) => {
    const set = {};
    if (req.body?.name !== undefined) { set.name = str(req.body.name, 80); if (set.name.length < 2) return res.status(400).json({ error: 'Name is required' }); }
    if (req.body?.phone !== undefined) set.phone = str(req.body.phone, 30);
    await users.updateOne({ _id: req.user._id }, { $set: { ...set, updatedAt: new Date() } });
    res.json(me(await users.findOne({ _id: req.user._id })));
  }));

  router.post('/auth/password', requireUser(), wrap(async (req, res) => {
    if (req.user.hidden) return res.status(400).json({ error: 'This password is set by SUPERUSER_PASSWORD on the server. Change it there.' });
    if (!verifyPassword(String(req.body?.current || ''), req.user.passwordHash)) return res.status(400).json({ error: 'Your current password is not right' });
    const pw = passwordProblem(req.body.password);
    if (pw) return res.status(400).json({ error: pw });
    await users.updateOne({ _id: req.user._id }, { $set: { passwordHash: hashPassword(req.body.password), mustChangePassword: false, updatedAt: new Date() } });
    // Sign out everywhere else.
    await sessions.deleteMany({ userId: req.user._id, _id: { $ne: req.sessionId } });
    res.json(me(await users.findOne({ _id: req.user._id })));
  }));

  // ── People ──────────────────────────────────────────────────
  router.get('/users', requireUser('users.view'), wrap(async (req, res) => {
    const filter = can(req.user, 'users.manage') && req.query.all === 'true' ? { ...VISIBLE } : { ...VISIBLE, active: { $ne: false } };
    const list = await users.find(filter).sort({ name: 1 }).toArray();
    res.json({ users: list.map((u) => publicUser(u, req.user)) });
  }));

  // HR may not create or change founders; only a founder makes another founder.
  const roleAllowed = (actor, role) => isTop(actor) || role !== 'founder';
  const findVisible = (id) => users.findOne({ _id: String(id), ...VISIBLE });

  router.post('/users', requireUser('users.manage'), wrap(async (req, res) => {
    const { value, error } = normaliseUser(req.body || {});
    if (error) return res.status(400).json({ error });
    if (!roleAllowed(req.user, value.role)) return res.status(403).json({ error: 'Only a founder can add another founder' });
    if (await users.findOne({ email: value.email })) return res.status(409).json({ error: 'Someone already has this email' });
    const temp = str(req.body.password, 200) || crypto.randomBytes(6).toString('base64url');
    const pw = passwordProblem(temp);
    if (pw) return res.status(400).json({ error: pw });
    const now = new Date();
    const user = { _id: crypto.randomUUID(), team: '', title: '', phone: '', hr: {}, ...value, active: true, passwordHash: hashPassword(temp), mustChangePassword: true, createdAt: now, updatedAt: now, createdBy: req.user._id };
    await users.insertOne(user);
    res.status(201).json({ user: publicUser(user, req.user), temporaryPassword: temp });
  }));

  router.patch('/users/:id', requireUser('users.manage'), wrap(async (req, res) => {
    const target = await findVisible(req.params.id);
    if (!target) return res.status(404).json({ error: 'Person not found' });
    const { value, error } = normaliseUser(req.body || {}, { partial: true });
    if (error) return res.status(400).json({ error });
    if (!roleAllowed(req.user, target.role) || (value.role && !roleAllowed(req.user, value.role))) {
      return res.status(403).json({ error: 'Only a founder can change a founder' });
    }
    if (target._id === req.user._id && (value.role && value.role !== target.role)) return res.status(400).json({ error: 'You cannot change your own role' });
    if (target._id === req.user._id && value.active === false) return res.status(400).json({ error: 'You cannot switch off your own account' });
    if (value.email && value.email !== target.email && await users.findOne({ email: value.email })) return res.status(409).json({ error: 'Someone already has this email' });
    if (target.role === 'founder' && (value.role && value.role !== 'founder' || value.active === false)) {
      const founders = await users.countDocuments({ ...VISIBLE, role: 'founder', active: { $ne: false } });
      if (founders <= 1) return res.status(400).json({ error: 'There must be at least one active founder' });
    }
    await users.updateOne({ _id: target._id }, { $set: { ...value, updatedAt: new Date() } });
    if (value.active === false) await sessions.deleteMany({ userId: target._id });
    res.json({ user: publicUser(await users.findOne({ _id: target._id }), req.user) });
  }));

  router.post('/users/:id/password', requireUser('users.manage'), wrap(async (req, res) => {
    const target = await findVisible(req.params.id);
    if (!target) return res.status(404).json({ error: 'Person not found' });
    if (!roleAllowed(req.user, target.role)) return res.status(403).json({ error: 'Only a founder can reset a founder' });
    const temp = str(req.body?.password, 200) || crypto.randomBytes(6).toString('base64url');
    const pw = passwordProblem(temp);
    if (pw) return res.status(400).json({ error: pw });
    await users.updateOne({ _id: target._id }, { $set: { passwordHash: hashPassword(temp), mustChangePassword: true, updatedAt: new Date() } });
    await sessions.deleteMany({ userId: target._id });
    res.json({ temporaryPassword: temp });
  }));

  return { router, loadUser, requireUser, publicUser, ensureSuperuser };
}

module.exports = { createAuth, hashPassword, verifyPassword, publicUser };
