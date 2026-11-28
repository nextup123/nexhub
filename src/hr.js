'use strict';

/**
 * HR: attendance, leave, holidays and the company calendar.
 *
 * Attendance (one document per person per day, _id "<userId>:<YYYY-MM-DD>")
 *   POST /attendance/check-in        { mode: office|wfh|site, note }   yourself, today
 *   POST /attendance/check-out       { note }
 *   GET  /attendance/today           your day, plus who is in / on leave / not in yet (team for leads, everyone for HR and founders)
 *   GET  /attendance/month?month=2026-11&userId=   day-by-day grid with totals (scope by role)
 *   PUT  /attendance/:userId/:date   correct a day (HR, founder)
 *
 * Leave
 *   GET  /leave?scope=mine|approvals|all&status=&year=
 *   GET  /leave/balance?userId=&year=
 *   POST /leave                      { type, from, to, halfDay, reason }
 *   POST /leave/:id/decision         { decision: approve|reject, comment }  (team lead, HR, founder; not your own)
 *   POST /leave/:id/cancel           your own, while pending or not yet started
 *
 * Holidays and calendar
 *   GET    /holidays?year=   POST /holidays   DELETE /holidays/:id         (manage: HR, founder)
 *   GET    /calendar?from=&to=   holidays, events, who is on leave, robot target and dispatch dates
 *   POST   /events   PATCH /events/:id   DELETE /events/:id                (HR, founder, lead)
 */

const crypto = require('crypto');
const express = require('express');
const { can, isTop, hasLeadPowers } = require('./permissions');
const D = require('./dates');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const str = (v, max) => (v === undefined || v === null ? '' : String(v).trim().slice(0, max));

const LEAVE_TYPES = ['casual', 'sick', 'earned', 'unpaid'];
const LEAVE_LABELS = { casual: 'Casual leave', sick: 'Sick leave', earned: 'Earned leave', unpaid: 'Unpaid leave' };
const LEAVE_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'];
const ATTENDANCE_STATUSES = ['present', 'half_day', 'absent', 'leave', 'holiday'];
const MODES = ['office', 'wfh', 'site'];
const EVENT_KINDS = ['meeting', 'demo', 'dispatch', 'training', 'visit', 'other'];
const HOLIDAY_KINDS = ['national', 'festival', 'optional'];

function createHr({ db, config, requireUser, publicUser }) {
  const users = db.collection('users');
  const attendance = db.collection('attendance');
  const leaves = db.collection('leave_requests');
  const holidays = db.collection('holidays');
  const events = db.collection('events');
  const units = db.collection('production_units');
  const router = express.Router();
  const tz = config.COMPANY_TZ;
  const workDays = new Set(config.WORK_DAYS);

  // ── Helpers ─────────────────────────────────────────────────
  const activeUsers = () => users.find({ active: { $ne: false }, hidden: { $ne: true } }).sort({ name: 1 }).toArray();
  /** People a lead (or an employee with lead powers) looks after: same team, not founders or HR, not themselves. */
  const isTeamMember = (lead, u) => !!lead.team && u.team === lead.team && u._id !== lead._id && !isTop(u);

  /** Whose attendance and leave this person may see. */
  async function scopeUsers(viewer) {
    const all = await activeUsers();
    if (can(viewer, 'attendance.all')) return all;
    if (can(viewer, 'attendance.team')) return all.filter((u) => u._id === viewer._id || isTeamMember(viewer, u));
    return all.filter((u) => u._id === viewer._id);
  }
  function canDecide(viewer, owner) {
    if (owner._id === viewer._id) return isTop(viewer) && can(viewer, 'leave.approve_all');
    if (isTop(owner) && !isTop(viewer)) return false;
    if (can(viewer, 'leave.approve_all')) return true;
    return can(viewer, 'leave.approve_team') && isTeamMember(viewer, owner) && owner.role === 'employee' && !hasLeadPowers(owner);
  }

  async function holidayMap(from, to) {
    const list = await holidays.find({ date: { $gte: from, $lte: to } }).toArray();
    return new Map(list.map((h) => [h.date, h]));
  }
  /** Working days between two dates (both included): not a weekly off day, not a holiday. */
  async function workingDays(from, to) {
    const hol = await holidayMap(from, to);
    return D.eachDay(from, to).filter((d) => workDays.has(D.weekday(d)) && !(hol.get(d) && hol.get(d).kind !== 'optional'));
  }
  const leaveDays = async (l) => (l.halfDay ? 0.5 : (await workingDays(l.from, l.to)).length);

  // ── Attendance ──────────────────────────────────────────────
  const dayId = (userId, date) => `${userId}:${date}`;
  const hoursBetween = (a, b) => (a && b ? Math.round(((new Date(b) - new Date(a)) / 3600000) * 100) / 100 : null);

  router.post('/attendance/check-in', requireUser('attendance.self'), wrap(async (req, res) => {
    const date = D.todayIn(tz);
    const existing = await attendance.findOne({ _id: dayId(req.user._id, date) });
    if (existing && existing.checkIn) return res.status(409).json({ error: 'You already checked in today', record: existing });
    const now = new Date();
    const late = D.minutesIn(tz, now) > config.OFFICE_START_MIN + config.LATE_AFTER_MIN;
    const record = {
      _id: dayId(req.user._id, date), userId: req.user._id, date, checkIn: now, checkOut: null, hours: null,
      mode: MODES.includes(req.body?.mode) ? req.body.mode : 'office', status: 'present', late,
      note: str(req.body?.note, 300), source: 'self', updatedAt: now,
    };
    await attendance.updateOne({ _id: record._id }, { $set: record }, { upsert: true });
    res.status(201).json({ record });
  }));

  router.post('/attendance/check-out', requireUser('attendance.self'), wrap(async (req, res) => {
    const date = D.todayIn(tz);
    const rec = await attendance.findOne({ _id: dayId(req.user._id, date) });
    if (!rec || !rec.checkIn) return res.status(409).json({ error: 'Check in first' });
    if (rec.checkOut) return res.status(409).json({ error: 'You already checked out today', record: rec });
    const now = new Date();
    const hours = hoursBetween(rec.checkIn, now);
    const set = { checkOut: now, hours, status: hours < config.HALF_DAY_HOURS ? 'half_day' : 'present', updatedAt: now };
    if (req.body?.note) set.note = [rec.note, str(req.body.note, 300)].filter(Boolean).join(' · ');
    await attendance.updateOne({ _id: rec._id }, { $set: set });
    res.json({ record: { ...rec, ...set } });
  }));

  /** Status of one person on one day, from their record, approved leave, holidays and the work week. */
  function dayStatus({ date, record, leave, holiday, today }) {
    if (record && record.status && record.source !== 'self' && !record.checkIn) return { status: record.status, note: record.note };
    if (record && record.checkIn) {
      return { status: record.status, checkIn: record.checkIn, checkOut: record.checkOut, hours: record.hours ?? null, mode: record.mode, late: record.late, note: record.note };
    }
    if (holiday && holiday.kind !== 'optional') return { status: 'holiday', label: holiday.name };
    if (leave) return { status: 'leave', leaveType: leave.type, halfDay: leave.halfDay };
    if (!workDays.has(D.weekday(date))) return { status: 'off' };
    if (date > today) return { status: 'upcoming' };
    if (date === today) return { status: 'not_in' };
    return { status: 'absent' };
  }

  async function grid(people, from, to) {
    const ids = people.map((u) => u._id);
    const [records, leaveList, hol] = await Promise.all([
      attendance.find({ userId: { $in: ids }, date: { $gte: from, $lte: to } }).toArray(),
      leaves.find({ userId: { $in: ids }, status: 'approved', from: { $lte: to }, to: { $gte: from } }).toArray(),
      holidayMap(from, to),
    ]);
    const rec = new Map(records.map((r) => [r._id, r]));
    const today = D.todayIn(tz);
    const days = D.eachDay(from, to);
    return people.map((u) => {
      const mine = leaveList.filter((l) => l.userId === u._id);
      const cells = {};
      const totals = { present: 0, half_day: 0, absent: 0, leave: 0, late: 0, wfh: 0, hours: 0 };
      for (const date of days) {
        const leave = mine.find((l) => l.from <= date && l.to >= date);
        const c = dayStatus({ date, record: rec.get(dayId(u._id, date)), leave, holiday: hol.get(date), today });
        cells[date] = c;
        if (c.status in totals) totals[c.status] += 1;
        if (c.late) totals.late += 1;
        if (c.mode === 'wfh') totals.wfh += 1;
        if (c.hours) totals.hours += c.hours;
      }
      totals.hours = Math.round(totals.hours * 10) / 10;
      return { user: { _id: u._id, name: u.name, team: u.team, role: u.role, title: u.title }, days: cells, totals };
    });
  }

  router.get('/attendance/today', requireUser('attendance.self'), wrap(async (req, res) => {
    const today = D.todayIn(tz);
    const people = await scopeUsers(req.user);
    const rows = await grid(people, today, today);
    const mine = rows.find((r) => r.user._id === req.user._id);
    const record = await attendance.findOne({ _id: dayId(req.user._id, today) });
    const others = rows.filter((r) => r.user._id !== req.user._id).map((r) => ({ user: r.user, ...r.days[today] }));
    const count = (s) => others.filter((o) => o.status === s).length;
    res.json({
      date: today,
      officeStart: config.OFFICE_START,
      me: { record, ...(mine ? mine.days[today] : {}) },
      board: others,
      counts: { present: count('present') + count('half_day'), leave: count('leave'), notIn: count('not_in'), total: others.length },
    });
  }));

  router.get('/attendance/month', requireUser('attendance.self'), wrap(async (req, res) => {
    const month = /^\d{4}-\d{2}$/.test(String(req.query.month)) ? String(req.query.month) : D.todayIn(tz).slice(0, 7);
    const { from, to } = D.monthRange(month);
    let people = await scopeUsers(req.user);
    if (req.query.userId) people = people.filter((u) => u._id === String(req.query.userId));
    if (req.query.team) people = people.filter((u) => u.team === String(req.query.team));
    const [rows, hol] = await Promise.all([grid(people, from, to), holidayMap(from, to)]);
    res.json({
      month, from, to, today: D.todayIn(tz),
      days: D.eachDay(from, to).map((date) => ({ date, weekday: D.weekday(date), workday: workDays.has(D.weekday(date)), holiday: hol.get(date)?.name || null })),
      people: rows || [],
      canEdit: can(req.user, 'attendance.edit'),
    });
  }));

  router.put('/attendance/:userId/:date', requireUser('attendance.edit'), wrap(async (req, res) => {
    const { userId, date } = req.params;
    if (!D.isDate(date)) return res.status(400).json({ error: 'date must look like 2026-11-18' });
    const u = await users.findOne({ _id: userId, hidden: { $ne: true } });
    if (!u) return res.status(404).json({ error: 'Person not found' });
    const b = req.body || {};
    if (b.clear === true) {
      await attendance.deleteOne({ _id: dayId(userId, date) });
      return res.json({ ok: true });
    }
    if (!ATTENDANCE_STATUSES.includes(b.status)) return res.status(400).json({ error: `status must be one of ${ATTENDANCE_STATUSES.join(', ')}` });
    const at = (t) => (/^\d{2}:\d{2}$/.test(str(t, 5)) ? new Date(new Date(`${date}T${t}:00Z`).getTime() - config.TZ_OFFSET_MIN * 60000) : null);
    const checkIn = at(b.checkIn);
    const checkOut = at(b.checkOut);
    const record = {
      _id: dayId(userId, date), userId, date, status: b.status, checkIn, checkOut, hours: hoursBetween(checkIn, checkOut),
      mode: MODES.includes(b.mode) ? b.mode : 'office', late: false, note: str(b.note, 300), source: 'hr', editedBy: req.user.name, updatedAt: new Date(),
    };
    await attendance.updateOne({ _id: record._id }, { $set: record }, { upsert: true });
    res.json({ record });
  }));

  // ── Leave ───────────────────────────────────────────────────
  async function balance(userId, year) {
    const list = await leaves.find({ userId, status: { $in: ['approved', 'pending'] }, from: { $lte: `${year}-12-31` }, to: { $gte: `${year}-01-01` } }).toArray();
    const out = {};
    for (const t of LEAVE_TYPES) out[t] = { allowed: config.LEAVE_POLICY[t] ?? null, used: 0, pending: 0 };
    for (const l of list) {
      const days = l.halfDay ? 0.5 : (await workingDays(l.from < `${year}-01-01` ? `${year}-01-01` : l.from, l.to > `${year}-12-31` ? `${year}-12-31` : l.to)).length;
      out[l.type][l.status === 'approved' ? 'used' : 'pending'] += days;
    }
    for (const t of LEAVE_TYPES) out[t].left = out[t].allowed == null ? null : out[t].allowed - out[t].used - out[t].pending;
    return out;
  }

  /** What a viewer sees of a leave request: the reason only if it is theirs or theirs to decide. */
  function leaveView(l, viewer, owner) {
    const mine = l.userId === viewer._id;
    const decider = owner && canDecide(viewer, owner);
    const out = { ...l, user: owner ? { _id: owner._id, name: owner.name, team: owner.team, role: owner.role } : null, canDecide: !!decider && l.status === 'pending', mine };
    if (!mine && !decider && !can(viewer, 'leave.approve_all')) { delete out.reason; delete out.comment; }
    return out;
  }

  router.get('/leave', requireUser('leave.self'), wrap(async (req, res) => {
    const scope = String(req.query.scope || 'mine');
    const people = await scopeUsers(req.user);
    const byId = new Map((await activeUsers()).map((u) => [u._id, u]));
    const filter = {};
    if (scope === 'mine') filter.userId = req.user._id;
    else filter.userId = { $in: people.map((u) => u._id) };
    if (req.query.status) filter.status = { $in: String(req.query.status).split(',') };
    if (req.query.year) { const y = String(req.query.year); filter.from = { $lte: `${y}-12-31` }; filter.to = { $gte: `${y}-01-01` }; }
    let list = await leaves.find(filter).sort({ createdAt: -1 }).limit(500).toArray();
    list = list.map((l) => leaveView(l, req.user, byId.get(l.userId)));
    if (scope === 'approvals') list = list.filter((l) => l.canDecide);
    res.json({ leave: list, types: LEAVE_TYPES, labels: LEAVE_LABELS });
  }));

  router.get('/leave/balance', requireUser('leave.self'), wrap(async (req, res) => {
    const year = /^\d{4}$/.test(String(req.query.year)) ? String(req.query.year) : D.todayIn(tz).slice(0, 4);
    const userId = String(req.query.userId || req.user._id);
    if (userId !== req.user._id && !(await scopeUsers(req.user)).some((u) => u._id === userId)) return res.status(403).json({ error: 'Your role does not allow this' });
    res.json({ year, userId, balance: await balance(userId, year), labels: LEAVE_LABELS });
  }));

  router.post('/leave', requireUser('leave.self'), wrap(async (req, res) => {
    const b = req.body || {};
    if (!LEAVE_TYPES.includes(b.type)) return res.status(400).json({ error: `type must be one of ${LEAVE_TYPES.join(', ')}` });
    const from = str(b.from, 10);
    const to = str(b.to, 10) || from;
    if (!D.isDate(from) || !D.isDate(to) || to < from) return res.status(400).json({ error: 'Pick a start and end date (the end on or after the start)' });
    if (D.eachDay(from, to).length > 90) return res.status(400).json({ error: 'A leave request can cover at most 90 days. Split it up.' });
    const halfDay = b.halfDay === true && from === to;
    const days = halfDay ? 0.5 : (await workingDays(from, to)).length;
    if (!days) return res.status(400).json({ error: 'Those dates are all holidays or weekly offs' });
    const overlap = await leaves.findOne({ userId: req.user._id, status: { $in: ['pending', 'approved'] }, from: { $lte: to }, to: { $gte: from } });
    if (overlap) return res.status(409).json({ error: `You already have leave from ${overlap.from} to ${overlap.to}` });
    if (b.type !== 'unpaid') {
      const bal = (await balance(req.user._id, from.slice(0, 4)))[b.type];
      if (bal.left !== null && bal.left < days) return res.status(400).json({ error: `Only ${bal.left} days of ${LEAVE_LABELS[b.type].toLowerCase()} left this year` });
    }
    const now = new Date();
    const doc = { _id: crypto.randomUUID(), userId: req.user._id, type: b.type, from, to, halfDay, days, reason: str(b.reason, 1000), status: 'pending', decidedBy: null, decidedAt: null, comment: '', createdAt: now, updatedAt: now };
    await leaves.insertOne(doc);
    res.status(201).json({ leave: leaveView(doc, req.user, req.user) });
  }));

  router.post('/leave/:id/decision', requireUser('leave.self'), wrap(async (req, res) => {
    const l = await leaves.findOne({ _id: String(req.params.id) });
    if (!l) return res.status(404).json({ error: 'Leave request not found' });
    const owner = await users.findOne({ _id: l.userId });
    if (!owner || !canDecide(req.user, owner)) return res.status(403).json({ error: 'You cannot decide this request' });
    if (l.status !== 'pending') return res.status(409).json({ error: `This request is already ${l.status}` });
    const decision = req.body?.decision;
    if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ error: 'decision must be approve or reject' });
    const set = { status: decision === 'approve' ? 'approved' : 'rejected', decidedBy: req.user.name, decidedById: req.user._id, decidedAt: new Date(), comment: str(req.body.comment, 500), updatedAt: new Date() };
    await leaves.updateOne({ _id: l._id }, { $set: set });
    res.json({ leave: leaveView({ ...l, ...set }, req.user, owner) });
  }));

  router.post('/leave/:id/cancel', requireUser('leave.self'), wrap(async (req, res) => {
    const l = await leaves.findOne({ _id: String(req.params.id) });
    if (!l || l.userId !== req.user._id) return res.status(404).json({ error: 'Leave request not found' });
    if (!['pending', 'approved'].includes(l.status)) return res.status(409).json({ error: `This request is already ${l.status}` });
    if (l.status === 'approved' && l.from <= D.todayIn(tz)) return res.status(409).json({ error: 'This leave has started. Ask HR to change it.' });
    await leaves.updateOne({ _id: l._id }, { $set: { status: 'cancelled', updatedAt: new Date() } });
    res.json({ ok: true });
  }));

  // ── Holidays ────────────────────────────────────────────────
  router.get('/holidays', requireUser('calendar.view'), wrap(async (req, res) => {
    const year = /^\d{4}$/.test(String(req.query.year)) ? String(req.query.year) : D.todayIn(tz).slice(0, 4);
    res.json({ year, holidays: await holidays.find({ date: { $gte: `${year}-01-01`, $lte: `${year}-12-31` } }).sort({ date: 1 }).toArray() });
  }));
  router.post('/holidays', requireUser('holidays.manage'), wrap(async (req, res) => {
    const date = str(req.body?.date, 10);
    const name = str(req.body?.name, 80);
    if (!D.isDate(date) || !name) return res.status(400).json({ error: 'A date and a name are required' });
    if (await holidays.findOne({ date })) return res.status(409).json({ error: 'There is already a holiday on that date' });
    const doc = { _id: crypto.randomUUID(), date, name, kind: HOLIDAY_KINDS.includes(req.body.kind) ? req.body.kind : 'festival', createdBy: req.user.name, createdAt: new Date() };
    await holidays.insertOne(doc);
    res.status(201).json({ holiday: doc });
  }));
  router.delete('/holidays/:id', requireUser('holidays.manage'), wrap(async (req, res) => {
    const r = await holidays.deleteOne({ _id: String(req.params.id) });
    if (!r.deletedCount) return res.status(404).json({ error: 'Holiday not found' });
    res.json({ ok: true });
  }));

  // ── Events and the calendar ─────────────────────────────────
  function normaliseEvent(b, partial) {
    const out = {};
    if (!partial || b.title !== undefined) { out.title = str(b.title, 120); if (!out.title) return { error: 'A title is required' }; }
    if (!partial || b.date !== undefined) { out.date = str(b.date, 10); if (!D.isDate(out.date)) return { error: 'date must look like 2026-11-18' }; }
    if (b.endDate !== undefined) { const e = str(b.endDate, 10); out.endDate = D.isDate(e) && e >= (out.date || '') ? e : null; }
    if (b.time !== undefined) out.time = /^\d{2}:\d{2}$/.test(str(b.time, 5)) ? str(b.time, 5) : '';
    if (b.kind !== undefined || !partial) out.kind = EVENT_KINDS.includes(b.kind) ? b.kind : 'other';
    if (b.description !== undefined) out.description = str(b.description, 1000);
    if (b.location !== undefined) out.location = str(b.location, 120);
    return { value: out };
  }
  router.post('/events', requireUser('calendar.manage'), wrap(async (req, res) => {
    const { value, error } = normaliseEvent(req.body || {}, false);
    if (error) return res.status(400).json({ error });
    const doc = { _id: crypto.randomUUID(), endDate: null, time: '', description: '', location: '', ...value, createdBy: req.user.name, createdById: req.user._id, createdAt: new Date() };
    await events.insertOne(doc);
    res.status(201).json({ event: doc });
  }));
  const ownsEvent = (u, e) => e.createdById === u._id || isTop(u) || u.role === 'hr';
  router.patch('/events/:id', requireUser('calendar.manage'), wrap(async (req, res) => {
    const e = await events.findOne({ _id: String(req.params.id) });
    if (!e) return res.status(404).json({ error: 'Event not found' });
    if (!ownsEvent(req.user, e)) return res.status(403).json({ error: 'Only whoever added it, HR or a founder can change this' });
    const { value, error } = normaliseEvent(req.body || {}, true);
    if (error) return res.status(400).json({ error });
    await events.updateOne({ _id: e._id }, { $set: value });
    res.json({ event: { ...e, ...value } });
  }));
  router.delete('/events/:id', requireUser('calendar.manage'), wrap(async (req, res) => {
    const e = await events.findOne({ _id: String(req.params.id) });
    if (!e) return res.status(404).json({ error: 'Event not found' });
    if (!ownsEvent(req.user, e)) return res.status(403).json({ error: 'Only whoever added it, HR or a founder can delete this' });
    await events.deleteOne({ _id: e._id });
    res.json({ ok: true });
  }));

  router.get('/calendar', requireUser('calendar.view'), wrap(async (req, res) => {
    const today = D.todayIn(tz);
    const from = D.isDate(String(req.query.from)) ? String(req.query.from) : `${today.slice(0, 7)}-01`;
    let to = D.isDate(String(req.query.to)) ? String(req.query.to) : D.monthRange(today.slice(0, 7)).to;
    if (D.eachDay(from, to).length > 120) to = D.addDays(from, 119);
    const byId = new Map((await activeUsers()).map((u) => [u._id, u]));
    const [hol, ev, lv, un] = await Promise.all([
      holidays.find({ date: { $gte: from, $lte: to } }).toArray(),
      events.find({ date: { $lte: to } }).toArray(),
      leaves.find({ status: 'approved', from: { $lte: to }, to: { $gte: from } }).toArray(),
      can(req.user, 'production.view') ? units.find({}, { projection: { serial: 1, model: 1, targetDate: 1, dispatchedOn: 1, installedOn: 1 } }).toArray() : [],
    ]);
    // Site visits of projects, for those who see projects.
    let visits = [];
    if (can(req.user, 'projects.view')) {
      const vs = await db.collection('project_entries').find({ kind: 'visit', date: { $gte: D.addDays(from, -14), $lte: to } }).toArray();
      const ps = new Map((await db.collection('projects').find({ _id: { $in: [...new Set(vs.map((v) => v.projectId))] } }, { projection: { ref: 1, name: 1 } }).toArray()).map((p) => [p._id, p]));
      visits = vs.filter((v) => ps.has(v.projectId) && (v.endDate || v.date) >= from).map((v) => ({
        type: 'visit', id: v._id, projectId: v.projectId, date: v.date, endDate: v.endDate || v.date,
        title: `${ps.get(v.projectId).name}: site visit`, description: v.purpose, people: (v.engineers || []).map((x) => x.name),
      }));
    }
    const items = [
      ...hol.map((h) => ({ type: 'holiday', id: h._id, date: h.date, endDate: h.date, title: h.name, kind: h.kind })),
      ...ev.filter((e) => (e.endDate || e.date) >= from).map((e) => ({ type: 'event', id: e._id, date: e.date, endDate: e.endDate || e.date, title: e.title, kind: e.kind, time: e.time, location: e.location, description: e.description, createdBy: e.createdBy, canEdit: can(req.user, 'calendar.manage') && ownsEvent(req.user, e) })),
      // Everyone can see who is away (planning), not why.
      ...lv.filter((l) => byId.has(l.userId)).map((l) => ({ type: 'leave', id: l._id, date: l.from, endDate: l.to, title: `${byId.get(l.userId).name}`, halfDay: l.halfDay, userId: l.userId, ...(l.userId === req.user._id || can(req.user, 'leave.approve_all') ? { kind: l.type } : {}) })),
      ...un.flatMap((u) => [
        u.targetDate && !u.dispatchedOn && !u.installedOn && u.targetDate >= from && u.targetDate <= to ? { type: 'unit', id: u._id, date: u.targetDate, endDate: u.targetDate, title: `${u.serial} due`, kind: 'target', model: u.model } : null,
        u.dispatchedOn && u.dispatchedOn >= from && u.dispatchedOn <= to ? { type: 'unit', id: u._id, date: u.dispatchedOn, endDate: u.dispatchedOn, title: `${u.serial} dispatched`, kind: 'dispatched', model: u.model } : null,
      ].filter(Boolean)),
      ...visits,
    ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    res.json({ from, to, today, items, workDays: config.WORK_DAYS });
  }));

  return { router, scopeUsers, canDecide, publicUser, LEAVE_TYPES };
}

module.exports = { createHr, LEAVE_TYPES, LEAVE_LABELS, LEAVE_STATUSES, ATTENDANCE_STATUSES, EVENT_KINDS, HOLIDAY_KINDS };
