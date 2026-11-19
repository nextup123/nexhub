'use strict';

const envFileFound = require('./loadEnv').loadEnv();

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// People sign in to the company dashboard with their own account (src/auth.js); what each
// role may do is in src/permissions.js. The routes the robots call stay open.
module.exports = {
  PORT: Number(process.env.PORT) || 4060,
  HOST: process.env.HOST || '0.0.0.0',
  MONGO_URL: (process.env.MONGO_URL || process.env.MONGODB_URI || '').trim(),
  MONGO_DB: process.env.MONGO_DB || 'nextup_support',
  envFileFound,

  // ── Company dashboard: accounts ──
  // Used once, to create the first founder account on the dashboard's setup screen.
  // ADMIN_KEY (from version 1.2) is accepted for the same purpose.
  SETUP_KEY: (process.env.SETUP_KEY || '').trim(),
  ADMIN_KEY: (process.env.ADMIN_KEY || '').trim(),
  COMPANY_NAME: process.env.COMPANY_NAME || 'Nextup Robotics',
  // The secret super user: a hidden account above Founder, kept in step with these settings at
  // every start. Both set: it exists and can sign in. Either removed: it is switched off.
  SUPERUSER_EMAIL: (process.env.SUPERUSER_EMAIL || '').trim().toLowerCase(),
  SUPERUSER_PASSWORD: process.env.SUPERUSER_PASSWORD || '',
  SUPERUSER_NAME: (process.env.SUPERUSER_NAME || '').trim() || 'Administrator',
  // Bug, release, machine and app routes used by the dashboard. Off (default): they stay open as
  // before, so the EtherCAT tool, the mobile app and the GitHub Action keep working; roles still apply
  // to anyone signed in. On: the maintainer routes need a signed-in user, and the release script
  // sends RELEASE_TOKEN. Routes the robots call (report a bug, heartbeat, update records, read
  // published releases, a machine's own bugs) are never locked.
  LOCK_BUG_ROUTES: /^(1|true|yes)$/i.test(process.env.LOCK_BUG_ROUTES || ''),
  RELEASE_TOKEN: (process.env.RELEASE_TOKEN || '').trim(),

  // ── HR ──
  COMPANY_TZ: process.env.COMPANY_TZ || 'Asia/Kolkata',
  TZ_OFFSET_MIN: num(process.env.TZ_OFFSET_MIN, 330),                // used when HR types a check-in time
  WORK_DAYS: (process.env.WORK_DAYS || '1,2,3,4,5,6').split(',').map(Number).filter((n) => n >= 0 && n <= 6), // 0 = Sunday
  OFFICE_START: process.env.OFFICE_START || '09:30',
  OFFICE_START_MIN: (() => { const [h, m] = (process.env.OFFICE_START || '09:30').split(':').map(Number); return h * 60 + (m || 0); })(),
  LATE_AFTER_MIN: num(process.env.LATE_AFTER_MIN, 15),
  HALF_DAY_HOURS: Number(process.env.HALF_DAY_HOURS) || 4.5,
  // Days per calendar year. Unpaid leave has no limit.
  LEAVE_POLICY: { casual: num(process.env.LEAVE_CASUAL, 12), sick: num(process.env.LEAVE_SICK, 7), earned: num(process.env.LEAVE_EARNED, 15), unpaid: null },

  // ── Website contact form ──
  // Comma-separated sites allowed to post the form, e.g. https://nextuprobotics.com.
  // Empty = any site (fine for testing; set it once the website is live).
  CONTACT_ORIGINS: (process.env.CONTACT_ORIGINS || '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean),
  // Rate limits for the public form, per visitor address.
  CONTACT_BURST: num(process.env.CONTACT_BURST, 3),             // sends per 10 minutes
  CONTACT_DAILY: num(process.env.CONTACT_DAILY, 10),            // stored enquiries per 24 hours
  CONTACT_PER_EMAIL_DAILY: num(process.env.CONTACT_PER_EMAIL_DAILY, 5), // per email or phone per 24 hours
  // How many proxies sit in front of the server (Render: 1). Needed to see the visitor's
  // real address in X-Forwarded-For; a wrong value makes everyone share one limit.
  TRUST_PROXY: process.env.TRUST_PROXY === undefined ? 1 : (/^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY),
  // Visitor addresses are stored only as a salted hash. Defaults to the setup key, which is already secret.
  IP_SALT: process.env.IP_SALT || (process.env.SETUP_KEY || process.env.ADMIN_KEY || '').trim() || 'nextup-release-hub',
};
