# Nextup hub API

The backend, hosted on Render. A small Express + MongoDB server that keeps, for both of your applications
(EtherCAT config tool and main application):

1. **Release notes** for every version (what's new, what's fixed, notes before updating)
2. **Bug reports** sent from the machines or entered by you, numbered per app (ECT-12, MAIN-7)
3. **Update records**: which machine moved to which version, when, and whether it worked

It is also the backend of the **Nextup company hub**: everyone signs in with their own account and,
depending on their role, sees projects (robots on site, problems and solutions, site visits), the robots in the build, bug reports, website
enquiries, attendance, leave, holidays and the company calendar (see [Company hub](#company-hub)).
The **contact form of the Nextup website** is stored here too (see [Website enquiries](#website-enquiries)).

The EtherCAT tool's Software update page and the planned React Native app both talk to it.
The data model is in [DATA_MODEL.md](DATA_MODEL.md).

The **company dashboard** (the screens) is a separate package, `nextup-hub-dashboard`, that you run on
your own computer and point at this server's Render address. This package has no screens; it is only the API.

## Run

```bash
npm install
cp .env.example .env        # put your MongoDB connection string in MONGO_URL
npm start                   # http://localhost:4060/api/v1/health
```

`npm start` reads `.env` from this folder. Variables already set in the environment (as on
Render) take priority over the file.

### Settings

Only two are required:

| Variable | What it is |
|---|---|
| `MONGO_URL` | the MongoDB / Atlas connection string |
| `SETUP_KEY` | long random text, used once on the dashboard to create the first founder (Render makes one) |
| `SUPERUSER_EMAIL`, `SUPERUSER_PASSWORD` | optional: the secret super user, see [Super user](#super-user) |
| `REDIS_URL` | optional: Redis cache, see [Speed and the Redis cache](#speed-and-the-redis-cache) |
| `KEEP_AWAKE` | optional: `true` keeps Render's free instance from sleeping, see [Keep it awake](#keep-it-awake) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | optional: phone alerts, see [Alerts](#alerts-live-updates-and-telegram) |

Everything else has a sensible default and can be left out. Set one only if you need to change it:

| Variable | Default | |
|---|---|---|
| `SUPERUSER_NAME` | `Administrator` | the name the super user's changes show under in histories |
| `MONGO_DB` | `nextup_support` | database name |
| `COMPANY_NAME` | `Nextup Robotics` | |
| `COMPANY_TZ` | `Asia/Kolkata` | dates and attendance |
| `WORK_DAYS` | `1,2,3,4,5,6` | 0 = Sunday … 6 = Saturday |
| `OFFICE_START`, `LATE_AFTER_MIN`, `HALF_DAY_HOURS` | `09:30`, `15`, `4.5` | attendance rules |
| `LEAVE_CASUAL`, `LEAVE_SICK`, `LEAVE_EARNED` | `12`, `7`, `15` | leave days per year |
| `CONTACT_ORIGINS` | any site | only these sites may send the contact form, e.g. `https://nextuprobotics.com` |
| `CONTACT_BURST`, `CONTACT_DAILY`, `CONTACT_PER_EMAIL_DAILY` | `3`, `10`, `5` | contact form limits |
| `TRUST_PROXY` | `1` | proxies in front of the server (right for Render) |
| `IP_SALT` | the setup key | salt for stored visitor-address hashes |
| `LOCK_BUG_ROUTES`, `RELEASE_TOKEN` | off | see [The apps and robots keep working](#the-apps-and-robots-keep-working) |
| `CACHE_TTL` | `60` | seconds a cached dashboard answer may live (changes clear it at once anyway) |
| `PORT` | `4060` (Render sets its own) | |

It needs a MongoDB 6 or 7 server (or MongoDB Atlas). On first start it creates the collections
with validators and indexes and adds the two apps. `npm run init-db` does the same without
starting the server.

The robots, the EtherCAT tool, the mobile app and the GitHub Action send bugs, releases and update
records without signing in (see [The apps and robots keep working](#the-apps-and-robots-keep-working)).
Everything else (people, attendance, leave, production, enquiries) needs a signed-in account.

## Host it on Render

1. Create a MongoDB Atlas cluster, add a database user, and under **Network Access** allow
   `0.0.0.0/0` (Render has no fixed address on the free plan). Copy the connection string.
2. On Render create a Web Service from this folder (or New → Blueprint with `render.yaml`).
   Build command `npm ci`, start command `npm start`, and environment variables:
   `MONGO_URL` = the Atlas connection string, `SETUP_KEY` = a long random text (the Blueprint makes one).
   Optional: `SUPERUSER_EMAIL` and `SUPERUSER_PASSWORD` (see [Super user](#super-user)).
   A service made from an older version may still have `MONGO_DB`, `COMPANY_TZ`, `IP_SALT` or `CONTACT_ORIGINS`:
   they keep working, and can be deleted if they hold the default.
3. Open `https://<your-service>.onrender.com/api/v1/health`.
   `{"ok":true,"version":"1.11.0","features":[…],"db":"connected","cache":"redis connected"}` means it works.
   No `version` in that answer means Render still runs a copy from before pictures: deploy this version again.
4. On each robot PC: Software update → Update settings → Report server address
   `https://<your-service>.onrender.com`. In the mobile app: the same address.

## Speed and the Redis cache

**What is slow, in order:**

1. **Render's free plan sleeps** after 15 minutes without requests. The next visit waits 30 to 60
   seconds while it starts again. No cache can help with that: the server is not running. See
   [Keep it awake](#keep-it-awake).
2. **Distance.** Every request goes from your computer to Render, and from Render to Atlas. Put the
   Render service, the Atlas cluster and the Redis instance in the **same region** (for India:
   Singapore on both). An Atlas cluster in another region than Render adds its distance to every database read.
3. **Database reads**, which the cache below removes for repeat visits.

**Redis cache (optional).** With `REDIS_URL` set, the hub keeps in Redis:

- each sign-in (the session and the person), so a request no longer needs two database reads before it starts;
- the dashboard's answers (home, projects, people, calendar, production, enquiries, bugs…) for `CACHE_TTL`
  seconds, per person, so going back to a page you just saw does not ask the database again.

It never shows old data: every save (any change, by anyone) moves the cache on before its answer is
sent, so the next read is fresh. The robots' heartbeats and bug reports only refresh the bug pages and
home, not people and projects. Answers are kept per person after their own permission checks, so roles,
switched-off accounts, sign-outs and the super user behave exactly as without it. The attendance "today"
screen, CSV exports and pictures are never cached. Answers are also gzip-compressed now, which helps on slow connections.

If Redis is unreachable the hub carries on from MongoDB (the log says `[cache] Redis: …`) and starts
using it again when it is back. `/api/v1/health` shows `"cache"`: `redis connected`, `redis not connected: …` or `off`.

**On Render:** New → Key Value (the free plan is enough), **in the same region as the hub**. Copy its
**Internal Key Value URL** (`redis://red-…:6379`) and add it to the hub's Environment as `REDIS_URL`.
The internal address only works from Render, not from your computer.

## Keep it awake

Render's free plan stops the hub after 15 minutes without visitors; the next visit waits up to a minute.

**Built in (one setting):** add `KEEP_AWAKE` = `true` in Render → Environment. The hub then opens its own
address (`RENDER_EXTERNAL_URL`, which Render sets) every 10 minutes, so it never goes 15 minutes without a
visit. The log says `[HUB] keep-awake: …` at start. Off a Render host, set `KEEP_AWAKE` to the hub's full `https://` address.

**Also recommended, an outside monitor (free, 3 minutes):** it wakes the hub if it ever did stop (for
example after Render restarts it at a quiet moment) and emails you when the hub is down.

1. Sign up at uptimerobot.com (free plan).
2. **New monitor** → type **HTTP(s)**, name `Nextup hub`, URL `https://<your-service>.onrender.com/api/v1/health`,
   interval **5 minutes** (the free plan's shortest; 10 also works).
3. Under alert contacts tick your email. Save.

Free hours: Render gives 750 free instance hours a month per workspace. One service running all month uses
about 744, so this fits only if the hub is your only free web service kept awake.

## Alerts, live updates and Telegram

**Live updates.** The dashboard keeps a connection open to `GET /api/v1/stream` (server-sent events).
Every change made by anyone (a project, a leave request, a robot stage…) tells the open dashboards to
reload the page on screen, so nobody has to press reload. The event carries no data: the dashboard reloads
through the normal API, so every role check applies. A dot next to the logo is green while it is connected;
it reconnects by itself when Render restarts or wakes the hub. One server instance is assumed (Render's free plan).

**Alerts in the dashboard.** A new website enquiry (founders and leads, who may see enquiries) or bug report
(everyone who may see bug reports) shows a pop-up that opens it. Desktop notifications can be turned on in
**Settings → Alerts** (browsers allow them on `http://localhost`, not on a network address).

**Telegram, to your phone, also when the dashboard is closed:**

1. In Telegram open **@BotFather**, send `/newbot`, give it a name (e.g. *Nextup hub*) and a username ending in
   `bot`. It answers with a token like `7412345678:AAH…`.
2. Render → the hub → Environment: add `TELEGRAM_BOT_TOKEN` = that token. Save and wait for the redeploy.
3. In Telegram, open your new bot and press **Start**.
4. Dashboard → **Settings → Alerts → Find my chat id**. It shows a number (your chat). Add it on Render as
   `TELEGRAM_CHAT_ID` and save. For several people, each presses Start, and you list their numbers
   separated by commas; for a team group, add the bot to the group, send a message there, and use the group's
   (negative) number.
5. **Send a test** in the same place.

Telegram messages include the customer's name, company, phone, email and message (for enquiries), so add
only chats of people who may see enquiries. If Telegram is unreachable the hub carries on; the log says
`[notify] Telegram …`.

## If it does not work

The web server starts even when the database can't be reached, and `/api/v1/health` says why:

| `db` in health | Meaning | Fix |
|---|---|---|
| `not configured` | `MONGO_URL` is missing | add it in Render → Environment, redeploy |
| `not connected` + "did not answer" | Atlas is blocking Render | Atlas → Network Access → allow `0.0.0.0/0` |
| `not connected` + "user name or password" | wrong user or password in `MONGO_URL` | special characters in the password must be URL-encoded (`@` → `%40`) |
| `not connected` + "address was not found" | typo in the cluster address | copy the string again from Atlas → Connect → Drivers |
| `connecting` | first try still running | wait 15 s and reload |

It keeps retrying every 10 seconds, so after fixing Atlas no redeploy is needed. Render's log shows
the same messages, starting with `[HUB]`.

On Render's free plan the server sleeps after 15 minutes without requests and takes up to a minute
to wake. The EtherCAT tool saves reports first and keeps retrying, so nothing is lost; the mobile app
shows "Waking the server…" while it waits.

## Try it without MongoDB

```bash
PORT=4060 node test/serve-fake.js
```

runs it on an in-memory stand-in (data is lost when it stops). `npm test` runs the API tests on
the same stand-in, with the cache on (`TEST_CACHE=off` without it, `TEST_REDIS_URL=redis://127.0.0.1:6379` against a real Redis). Add `SEED=1` for a sample company: 12 people, 6 projects for 5 clients with equipment, site visits and solved problems, robots in the build, attendance,
leave, holidays, events, bug reports, 24 website enquiries, 26 inventory items and a tagged tree for the welding cell (PRJ-2). Everyone's password is `nextup-demo`:

| Sign in as | Role |
|---|---|
| `dhirendra@nextup.demo` | Founder |
| `meena@nextup.demo` | HR |
| `anil@nextup.demo` (Production), `neha@nextup.demo` (Software), `rohit@nextup.demo` (Sales) | Lead |
| `ravi@nextup.demo`, `imran@nextup.demo`, `pooja@nextup.demo`, `arjun@nextup.demo` and others | Employee |

Point the dashboard at `http://localhost:4060` to use it. Without `SEED=1` the dashboard opens on the setup screen; the setup key is `dev-key` unless `SETUP_KEY` is set.

## Company hub

### First sign-in

1. Deploy (Render generates `SETUP_KEY`; older services can use their existing `ADMIN_KEY`).
2. Start the dashboard on your computer (see its README) with `VITE_HUB_URL=https://<your-service>.onrender.com`.
   The first time, it shows **Set up the hub**:
   paste the setup key from Render → Environment, and enter your name, email and password.
   That creates the first **Founder**. The setup screen never shows again.
3. Under **People → Add a person**, add everyone else. Each gets a temporary password (shown once)
   and chooses their own the first time they sign in. HR can do this too.

Passwords are stored as scrypt hashes; sign-ins are tokens kept as hashes in `sessions` (30 days with
"Keep me signed in", 1 day without). Changing a password signs out other devices; switching an
account off signs it out everywhere.

### Super user

A secret account above Founder, for you alone. It can do everything every role can, including
changing founders, and nobody sees it: it is not in **People**, not counted anywhere, cannot be put
on a team or given a build stage, and the dashboard cannot change, reset or switch it off.

1. Render → your service → **Environment**: add `SUPERUSER_EMAIL` (an email no one in People uses)
   and `SUPERUSER_PASSWORD` (8 characters or more, hard to guess). Optionally `SUPERUSER_NAME`.
2. Save and let Render redeploy. On start the hub creates the account (the log says `[superuser] created`).
3. Sign in on the dashboard with that email and password.

- To change its password, change `SUPERUSER_PASSWORD` and redeploy. It signs out everywhere.
- To switch it off, delete both variables and redeploy. Its sign-ins end at once.
- It is hidden from lists, not from history: what it changes is recorded under `SUPERUSER_NAME`
  ("Administrator" by default), like anyone else's changes.
- It does not count as the first account, so the hub still shows **Set up the hub** until a founder exists.
- The role cannot be given to anyone through the dashboard or the API; only these variables make it.

### Who sees what

| | Founder | HR | Lead | Employee |
|---|---|---|---|---|
| Directory (names, team, work email, phone) | ✓ | ✓ | ✓ | ✓ |
| Add people, change roles, reset passwords | ✓ | ✓ | | |
| HR records (employee id, joining date, emergency contact) | ✓ | ✓ | own | own |
| Own attendance and leave, company calendar | ✓ | ✓ | ✓ | ✓ |
| Team's attendance, approve team's leave | ✓ | ✓ | own team | |
| Everyone's attendance, correct it, approve anyone's leave, holidays | ✓ | ✓ | | |
| Add calendar events | ✓ | ✓ | ✓ | |
| Projects and their whole record (problems, solutions, site visits, notes), search | ✓ | ✓ | ✓ | ✓ |
| Clients, their projects, robots and equipment | ✓ | ✓ | ✓ | ✓ |
| Client contacts' phone and email | ✓ | ✓ | ✓ | the teams of its projects |
| Add and change clients, equipment on a project | ✓ | ✓ | ✓ | |
| Delete clients (only with no projects) | ✓ | ✓ | | |
| Record a robot's software version | ✓ | ✓ | ✓ | ✓ (robots on a project) |
| Customer contact at a project's site | ✓ | ✓ | ✓ | the project's team |
| Log problems, solutions, site visits and notes | ✓ | ✓ | ✓ | ✓ (change or delete their own) |
| Create projects, change team, robots, status | ✓ | ✓ | ✓ | |
| Delete projects | ✓ | ✓ | | |
| Robots in the build | ✓ | ✓ | ✓ | ✓ |
| Add robots, change dates, give stages to people | ✓ | ✓ | ✓ | |
| Tick off build stages given to you | ✓ | ✓ | ✓ | ✓ |
| Delete robots | ✓ | ✓ | | |
| Website enquiries (customer names, emails, phones) | ✓ | ✓ | ✓ | |
| Delete enquiries | ✓ | ✓ | | |
| Read and comment on bug reports | ✓ | ✓ | ✓ | ✓ (no customer phone/email) |
| Change bug status and priority, publish release notes | ✓ | ✓ | ✓ | |
| Add or change the apps | ✓ | ✓ | | |
| Inventory: see every group, search, export PDF and Excel | ✓ | ✓ | ✓ | ✓ |
| Inventory: add, edit, stock in/out, CSV import | ✓ | ✓ | ✓ | |
| Inventory: delete items | ✓ | ✓ | | |
| Assets: see and build project trees, take parts from stock, return, move, labels | ✓ | ✓ | ✓ | ✓ |
| Assets: delete a tag made by mistake | ✓ | ✓ | | |

(Inventory rows apply with `INVENTORY_OPEN=false`; while it is on, the inventory needs no sign-in.)

The reasoning: customer contact details (enquiries, bug reporters) stay with founders and leads, and a
project's site contact also with its team, who need it on site. Every engineer can read every project,
so a problem solved at one site helps at the next;
HR has every power a founder has (since 1.13); employees see the work they do. A lead looks
after everyone in the same **team** (Production, Software, Sales…). Nobody can change their own role,
nobody approves their own leave (except a founder or HR), and the last founder cannot be removed.
**Lead powers (1.13).** Founders, HR and the super user can give one employee *lead powers*: someone who
leads a team but stays an Employee. They then have every Lead permission in the table above (create and run
projects, clients, production, assets, bug triage, enquiries, their own team's attendance and leave) and keep
everything an employee has, until the powers are taken back. Everyone sees a green **+ Lead powers** tag
next to their role. In the dashboard: People › edit the person › Give lead powers / Take back lead powers.
API: `POST /users/:id/lead-powers {"grant": true}` (or `false`), permission `users.grant_lead`. Only
employees can get them (not yourself), and a role change away from Employee drops them.

The table lives in `src/permissions.js`; the server checks it on every request and the dashboard
uses the same table to hide what you cannot use.

### Clients

A **client** (`CLI-1`…) is a company: industry, city, address, GSTIN, website, notes and its contact
people. A client has any number of projects; its page shows them all, with every robot on them (and the
software each runs), all their equipment and a search through just that client's record.
Clients are made when a project names a new company, by hand, or by the bulk import. When 1.9 starts
for the first time, every existing project's customer becomes a client (one per company name, however
it was capitalised) and the project's site contact becomes one of the client's contacts. Nothing else
changes; running it again does nothing.

### Projects

A project is one customer installation (or an internal job) for one client: `PRJ-1`, `PRJ-2`… It holds

- **robots** from the build list (a robot is on one project at a time; its page links back), or robots
  that were installed **before the hub** (added with every build stage done, and their software version),
- **equipment** around the robots: conveyors, SPMs (special purpose machines), grippers, vision,
  fixtures, safety, PLC panels, positioners, AGVs. Each with make, model, serial, supplier, install
  date and notes; problems can be logged against a piece of equipment,
- the **team** and each person's role on it, the customer, the site address and the contact there,
- **problems** (`PRB-1`…): what happened, the **error codes**, the part, which robot or equipment,
  the **software version** it ran (taken from the robot if not typed), type (mechanical, electrical, software,
  EtherCAT, gripper, safety, process, customer side), how bad, the cause and the **solution**,
  with updates as people work on it. Status: open, investigating, workaround, solved,
- **site visits**: the date, who went, hours, why, what was done, next steps, and the problems found
  that day with how each was solved. Each of those problems is also kept as a problem of the project,
  so it shows in the problem list and in search. Visits show on the company calendar,
- **notes** and a history of every change.

A project done before the hub is just a project with status Live or Closed and its real dates.

**Search** (`GET /projects/search?q=`) looks through all of it: clients, project names, robot serials and
software versions, equipment, problems, error codes, causes, solutions, updates, visit reports and notes.
**Error codes are understood however they are written**: `E131`, `E-131`, `e 131` and `E_131` all find
each other, in a code field or anywhere in the text. Every word has to appear. Results are ranked: a
matching error code counts most, then the title, then the part, equipment, serial or software, then the
solution or cause; solved problems get a bonus because they hold the answer. Filters: only problems,
visits, notes, projects or clients, only problems not solved, one type, one project, one client.

**Seen before** (`GET /projects/search?mode=similar&q=`): while someone writes a problem, the dashboard
asks for problems like it (any of the same codes or main words) and shows how they were solved. Each document keeps a lower-case copy of its text, so search is one database query.
That is fine for thousands of entries; if it ever gets slow, a MongoDB Atlas Search index on
`project_entries.searchText` is the next step.

Anyone who logs a problem can change or delete it; leads and founders can change anything. Anyone who
can see projects may write the solution of a problem, because that is the point of the record.

### Bulk import (super user)

**Bulk import** in the dashboard (only the super user sees it) adds people, clients, projects, robots
(with software versions), equipment and past problems from a spreadsheet saved as CSV. Download the
template for each kind, fill it in, upload it, press **Check every row** (nothing is saved), read what
would happen, then **Import**. Column names can be loose ("Employee name", "Mobile", "Company") and
dates can be `2025-03-02`, `02/03/2025` (day first) or `2 Mar 2025`. Rows already in the hub are
skipped, or only have their empty fields filled in, so importing the same file twice changes nothing.
People get a temporary password, shown once (download them as CSV and give each privately); they pick
their own at first sign-in. Import in this order: people, clients, projects, robots, equipment, problems.
Up to 3000 rows at a time. API: `GET /import/templates`, `POST /import/:kind {rows, dryRun}`.

### Assets: a tag on every part (1.11)

Every physical thing that goes into a project gets its own **tag**, `NX-000123-K`: six digits that
never repeat, and a check letter that catches a mistyped digit. A tag can be typed with or without dashes,
in any case, or scanned from its printed QR label. Assets form a tree under a project:

```
PRJ-4 Welding cell
├─ Main control panel   NX-000101-H   assembly
│  ├─ Servo drive       NX-000102-K   one piece, S/N D23B0711, from stock EE-2
│  └─ M4 screws ×40     NX-000110-B   one lot, from stock MEC-3
└─ Robot arm            NX-000120-C   assembly
   └─ Joint J1          NX-000121-E   assembly
      ├─ Servo motor    NX-000122-G
      └─ M6 bolts ×12   NX-000123-J
```

- **Assembly**: holds other assets (panel, robot arm, computer, joint…), any depth.
- **Single piece**: one thing, one tag (a drive, a relay, a CPU), with its maker's serial number.
- **Lot**: a counted batch under one tag (nuts, bolts, cable, bar stock).

Parts are **taken from the store**: the inventory's stock line goes down by the number taken and the
parts get tags (one per piece, or one for the lot: each stock line has a default, `tracking`). **Return**
puts the number back into the stock line and retires the tag (kept, with its history). So the store count
is what has no tag yet, and every tagged thing is in a project or registered in the store. Things that
are not in the store (a machine, a tool, a PC bought for the project) can be registered on their own.
Moving an assembly moves everything inside it. Every change is in the asset's history.

| | |
|---|---|
| `GET /assets?q=&projectId=none\|<id>&kind=&status=` | search: tag, name, serial, make, model, stock ref |
| `GET /assets/tag/:tag` | find by tag (says when the check letter does not match) |
| `GET /assets/:id` | the asset, the path above it, what is inside, history |
| `GET /projects/:id/assets` | a project's whole tree (flat, with `parentId`) and totals |
| `GET /projects/:id/assets/export.xlsx` | bill of materials: the tree, and totals per part |
| `GET /assets/labels.pdf?projectId=` or `?ids=a,b` | A4 sheet of 3 × 8 QR labels |
| `POST /assets` | `{kind, name, projectId \| parentId, assemblyType, …}` or `{parentId, fromStock: {itemId, quantity, mode: unit\|lot, serials}}` |
| `PATCH /assets/:id` · `POST /assets/:id/move {projectId \| parentId}` · `POST /assets/:id/return {quantity}` | |
| `DELETE /assets/:id` | a tag made by mistake: removed, stock put back (founder) |

Who: founders, leads and employees see and build the trees (every change is logged with their name);
only founders and HR delete. Collection `assets`, counter `asset`.
New dependency: `qrcode`.

### Inventory (1.10, five groups since 1.11)

The separate **Nextup inventory** app (`nextup-inventory`, its own package) keeps what the company
owns in five groups: **IT**, **Electrical & electronics**, **Raw material**, **Mechanical** (down to nuts and
bolts) and **Machinery** (lathe, VMC…). 1.11 moves the old groups on start: panel → electrical, robot →
mechanical (controllers and pendants → electrical); refs like `PNL-3` never change. It signs
in with the same hub accounts. Every item has a name and a quantity, and optionally type, make, model,
payload (robots), specs, unit, location, condition, minimum stock (low-stock warning), assigned to,
serial numbers, supplier, purchase date, unit price and notes. Every quantity change is kept with who
and why. Refs: `IT-n`, `EE-n`, `RM-n`, `MEC-n`, `MCH-n`. Collection `inventory_items`.

| | |
|---|---|
| `GET /inventory/meta` | groups, type suggestions, conditions, CSV columns |
| `GET /inventory/summary` | per group: items, total quantity, low stock, value |
| `GET /inventory?category=it\|electrical\|raw_material\|mechanical\|machinery&q=&type=&condition=&low=1&sort=` | the list |
| `POST /inventory` · `GET/PATCH/DELETE /inventory/:id` | one item (`:id` or its ref) |
| `POST /inventory/:id/adjust {delta, note}` | stock in (+) or out (−) |
| `POST /inventory/bulk-delete {ids}` | several at once |
| `GET /inventory/template.csv?category=` | a CSV to fill in |
| `POST /inventory/import {category, csv, dryRun, onExisting}` | CSV import; `dryRun` (the default) saves nothing; items already there (same ref, or same name + model) are `update`d (quantity set to the file's), `add`ed to, or `skip`ped |
| `GET /inventory/export.xlsx` · `GET /inventory/export.pdf` | same filters as the list; Excel has a summary sheet and a sheet per group, PDF is A4 landscape |

CSV headers are matched loosely (*Item*, *Qty*, *Nos*, *Brand*, *Model no*, *Remarks*…); comma,
semicolon or tab separated; dates `2026-11-27`, `27/11/2026` or `27 Nov 2026`. Up to 5000 rows.
New dependencies: `exceljs` and `pdfkit` (Render installs them on deploy).

**`INVENTORY_OPEN`** (default `true`): the inventory routes answer without sign-in, so the inventory
app needs no login. Anyone who knows this server's address can then read and change the inventory
(nothing else: every other route still needs a login). A signed-in person is still held to their role.
Changes without sign-in are recorded as "Inventory app". Set `INVENTORY_OPEN=false` to require hub
logins again (and `VITE_REQUIRE_LOGIN=true` in the inventory app).

### Production

Each robot is a **unit** with a serial (`NX-C5-0001`, `NX-R10-0001`, `NX-R20-0001`), model (NexC5 in
White or Blue, NexR10, NexR20, or Custom), customer, target date and priority. It moves through stages:

Parts received → Base ready → Joints and gearboxes fitted → Arm assembled → Wiring done →
Control panel ready → Software installed → Calibrated → Tested (QA and burn-in) → Packed for dispatch

Each stage can be given to a person, and is Not started, In progress, Done, Blocked (with the reason)
or Skipped. Stages can be added or removed per unit. From the stages the hub works out the phase
(Planned, In build, Testing, Ready to ship, Dispatched, Installed), shows a board and a list, flags
units past their target date or blocked, and puts target and dispatch dates on the calendar.
Every change is kept in the unit's history.

### Attendance, leave, holidays, calendar

- **Check in / out** from the dashboard (Office, Work from home or At a customer site). After
  `OFFICE_START` + `LATE_AFTER_MIN` it counts as late; under `HALF_DAY_HOURS` it is a half day.
  HR and founders can correct any day.
- **Month grid** per person: present, half day, absent, on leave, holiday, week off.
- **Leave**: casual, sick, earned and unpaid, with yearly allowances (`LEAVE_CASUAL`, `LEAVE_SICK`,
  `LEAVE_EARNED`). Days are counted without week offs and holidays; overlapping requests and going
  over the balance are refused. Leads approve their team, HR and founders approve anyone.
- **Holidays** (HR, founders) and **events** (leads too) show on the company calendar with approved
  leave and robot dates.

Dates are kept in the company time zone (`COMPANY_TZ`, Asia/Kolkata), and the dashboard shows times in it.

### Calling it from the dashboard (CORS)

Browsers may call this API from any address, including the dashboard on `http://localhost:5174`.
That is safe because signing in gives a token that the dashboard sends in the `Authorization` header;
there are no cookies, so another website cannot use someone's session. Only the website contact form
can be limited to your site, with `CONTACT_ORIGINS`.

### The apps and robots keep working

Bug reports, release notes and update records are still sent by the robots, the EtherCAT tool, the
mobile app and the GitHub Action without signing in, as before. In the dashboard, roles apply.
Set `LOCK_BUG_ROUTES=true` once the mobile app signs in: then reading bug reports and machines needs
an account, and publishing releases needs an account or `RELEASE_TOKEN` (for the GitHub Action, as
`Authorization: Bearer <RELEASE_TOKEN>`). What the robots themselves send is never locked.

## Website enquiries

The contact page of the Nextup website sends its form to `POST /api/v1/contact`. Each enquiry gets a
number (`ENQ-12`) that the visitor sees, and is kept in the `contact_submissions` collection.

**In the dashboard** (founders and leads):

- Overview: unread count, waiting for a reply, this week against last week, share answered, typical reply time,
  enquiries per day (30 days), status, and what people are interested in and their industry
- Inbox: search, filters (status, product, industry, date, unread, starred), newest/oldest, CSV export
- One enquiry: contact details, the message, Reply by email / WhatsApp / Call, status
  (New, In progress, Replied, Closed, Spam), star, internal notes, history, other enquiries from the same person, delete
- Light and dark, works on a phone; `j`/`k` move through the list, `/` searches


**Spam protection** on `POST /contact`:

| Check | Default | Setting |
|---|---|---|
| Sends per visitor address in 10 minutes (every try counts, kept in memory) | 3 | `CONTACT_BURST` |
| Stored enquiries per visitor address in 24 hours (from the database, survives restarts) | 10 | `CONTACT_DAILY` |
| Enquiries per email or phone in 24 hours, from any address | 5 | `CONTACT_PER_EMAIL_DAILY` |
| The same message from the same person within 24 hours | stored once | |
| Hidden `website` field (honeypot): bots that fill it get a normal answer and nothing is stored | on | |
| Only your website may send the form | off | `CONTACT_ORIGINS` |
| Failed sign-ins per address, and per account, in 15 minutes | 10 | |

Over a limit the answer is `429` with `Retry-After`, and the website shows the message with the
WhatsApp and email links. Visitor addresses are kept only as a salted hash (`IP_SALT`).
On Render, `TRUST_PROXY=1` (the default) reads the visitor's real address; if every visitor seems to
share one limit, that setting is wrong.

**The website.** Build it with `VITE_CONTACT_API=https://<your-service>.onrender.com`. Without it the
form falls back to opening the visitor's email app, as before.

## Publishing a release

In the app's repository: set the version in `package.json`, describe it in `release-notes.json`,
commit, tag and push:

```bash
git tag v3.5.1 && git push origin main v3.5.1
```

The `Release` GitHub Action builds it and sends `release-notes.json` to this server
(repository secret `HUB_URL`). Bugs named in `changes[].bugs` are marked fixed.
To send the notes by hand: `HUB_URL=… node scripts/publish-release.js`.

## Assign to a project (1.12)

`POST /assets/assign` moves many store items into a project at once (a CPU, a mouse, a monitor, 2 servo drives, 24 bolts…):
`{ projectId, parentId?, assembly?: { name, assemblyType }, items: [{ itemId, quantity, mode?, serials? }] }`.
Everything is checked first, so either all of it moves or nothing does. Each piece gets its tag(s) under the project, or under an
existing or new component. The stock line's history says "To PRJ-4 › Computer…", and each tag's history says "Moved from the store (IT-1) to PRJ-4 › …".
`GET /inventory/projects` lists projects with their components for the picker. With `INVENTORY_OPEN` both work without
a login (recorded as "Inventory app", or the `X-User-Name` header). A signed-in user needs `assets.manage`.
`GET /inventory` now also returns `inProjects` per item: how many are out in projects with tags.
