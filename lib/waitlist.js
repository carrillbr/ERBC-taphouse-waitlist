// The waitlist itself: parties, tables, estimates and the texts that go with them.
const crypto = require('node:crypto');
const { estimateWaits, quote, fits, MAX_PARTY } = require('./estimate');
const { normalizePhone, formatPhone } = require('./phone');
const { getSetting, setSetting } = require('./db');

const ACTIVE = ['waiting', 'notified'];

class Waitlist {
  constructor(db, { settings, sms, baseUrl, venue, onChange = () => {} }) {
    this.db = db;
    this.settings = settings; // { turn2, turn4, noShowMinutes, timezone }
    this.sms = sms; // async (to, body) => { status }
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.venue = venue;
    this.onChange = onChange;
  }

  // ---- reads -------------------------------------------------------------

  tables() {
    return this.db.prepare('SELECT * FROM tables ORDER BY sort').all();
  }

  activeParties() {
    return this.db
      .prepare(`SELECT * FROM parties WHERE status IN ('waiting', 'notified') ORDER BY created_at, id`)
      .all();
  }

  // Line order: parties already texted go first, then everyone else by arrival.
  queue() {
    const parties = this.activeParties();
    const notified = parties.filter((p) => p.status === 'notified').sort((a, b) => a.notified_at - b.notified_at);
    const waiting = parties.filter((p) => p.status === 'waiting');
    return [...notified, ...waiting];
  }

  estimates(extra = [], now = Date.now()) {
    const tables = this.tables().map((t) => ({ id: t.id, seats: t.seats, seatedAt: t.party_id ? t.seated_at : null }));
    const queue = [...this.queue().map((p) => ({ id: p.id, size: p.size })), ...extra];
    return estimateWaits(tables, queue, this.settings, now);
  }

  // What to quote a new party of each size right now.
  quotes(now = Date.now()) {
    const sizes = [2, 4, 6];
    const out = {};
    for (const size of sizes) {
      const est = this.estimates([{ id: 'new', size }], now);
      out[size] = quote(est.get('new'));
    }
    return out;
  }

  quoteFor(size, now = Date.now()) {
    return quote(this.estimates([{ id: 'new', size }], now).get('new'));
  }

  party(id) {
    return this.db.prepare('SELECT * FROM parties WHERE id = ?').get(id);
  }

  partyByToken(token) {
    return this.db.prepare('SELECT * FROM parties WHERE token = ?').get(token);
  }

  lastReply(partyId) {
    return this.db
      .prepare(`SELECT body, created_at FROM messages WHERE party_id = ? AND direction = 'in' ORDER BY id DESC LIMIT 1`)
      .get(partyId);
  }

  lastText(partyId) {
    return this.db
      .prepare(`SELECT status, created_at FROM messages WHERE party_id = ? AND direction = 'out' ORDER BY id DESC LIMIT 1`)
      .get(partyId);
  }

  selfJoinOpen() {
    return getSetting(this.db, 'self_join', '1') === '1';
  }

  setSelfJoin(open) {
    setSetting(this.db, 'self_join', open ? '1' : '0');
    this.onChange();
  }

  // Everything the staff screen shows.
  staffState(now = Date.now()) {
    const queue = this.queue();
    const est = this.estimates([], now);
    let position = 0;
    const waiting = queue.map((p) => ({
      ...this.publicParty(p),
      phone: p.phone,
      email: p.email,
      newsOptIn: Boolean(p.news_opt_in),
      notes: p.notes,
      source: p.source,
      quoted: p.quoted,
      position: p.status === 'waiting' ? ++position : 0,
      estimate: quote(est.get(p.id)),
      lastReply: this.lastReply(p.id) || null,
      lastText: this.lastText(p.id) || null,
    }));

    const parties = new Map(
      this.db
        .prepare(`SELECT * FROM parties WHERE status = 'seated' AND id IN (SELECT party_id FROM tables WHERE party_id IS NOT NULL)`)
        .all()
        .map((p) => [p.id, p])
    );
    const tables = this.tables().map((t) => {
      const p = t.party_id ? parties.get(t.party_id) : null;
      return {
        id: t.id,
        label: t.label,
        seats: t.seats,
        seatedAt: t.party_id ? t.seated_at : null,
        party: p ? { id: p.id, name: p.name, size: p.size } : null,
        dueAt: t.party_id ? t.seated_at + (t.seats <= 2 ? this.settings.turn2 : this.settings.turn4) * 60000 : null,
      };
    });

    const recent = this.db
      .prepare(
        `SELECT * FROM parties WHERE status IN ('seated', 'cancelled', 'noshow') AND ended_at > ?
         ORDER BY ended_at DESC LIMIT 15`
      )
      .all(now - 3 * 3600000)
      .map((p) => ({ ...this.publicParty(p), source: p.source, endedAt: p.ended_at, tableIds: p.table_ids }));

    return {
      venue: this.venue,
      now,
      selfJoin: this.selfJoinOpen(),
      settings: this.settings,
      quotes: this.quotes(now),
      waiting,
      tables,
      recent,
      stats: this.stats(now),
      joinUrl: `${this.baseUrl}/join`,
    };
  }

  publicParty(p) {
    return {
      id: p.id,
      name: p.name,
      size: p.size,
      status: p.status,
      createdAt: p.created_at,
      notifiedAt: p.notified_at,
      seatedAt: p.seated_at,
    };
  }

  // What a guest sees on their status page.
  guestState(token, now = Date.now()) {
    const p = this.partyByToken(token);
    if (!p) return null;
    let position = null;
    let estimate = null;
    if (p.status === 'waiting') {
      const waiting = this.queue().filter((q) => q.status === 'waiting');
      position = waiting.findIndex((q) => q.id === p.id) + 1;
      estimate = quote(this.estimates([], now).get(p.id));
    }
    return {
      venue: this.venue,
      name: p.name,
      size: p.size,
      status: p.status,
      position,
      estimate,
      createdAt: p.created_at,
      notifiedAt: p.notified_at,
      noShowMinutes: this.settings.noShowMinutes,
    };
  }

  stats(now = Date.now()) {
    const since = Math.max(businessDayStart(now, this.settings.timezone), Number(getSetting(this.db, 'reset_at', -1)) + 1);
    const rows = this.db.prepare('SELECT * FROM parties WHERE created_at >= ?').all(since);
    const seated = rows.filter((p) => p.status === 'seated');
    // Walk-ins never waited, so they'd drag down the average used to tune the quotes.
    const waits = seated.filter((p) => p.source !== 'walkin').map((p) => (p.seated_at - p.created_at) / 60000);
    return {
      parties: rows.length,
      guests: rows.reduce((n, p) => n + p.size, 0),
      seated: seated.length,
      noShows: rows.filter((p) => p.status === 'noshow').length,
      cancelled: rows.filter((p) => p.status === 'cancelled').length,
      avgWait: waits.length ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length) : null,
    };
  }

  // Every party that has ever been on the list, newest first.
  // range: 'tonight' | 'yesterday' | '7d' | '30d' | 'all'
  history({ q = '', range = '7d', status = '', limit = 200, offset = 0 } = {}, now = Date.now()) {
    const { where, args } = this.historyFilter({ q, range, status }, now);
    const total = this.db.prepare(`SELECT COUNT(*) n FROM parties ${where}`).get(...args).n;
    const rows = this.db
      .prepare(`SELECT * FROM parties ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...args, Math.min(Number(limit) || 200, 500), Number(offset) || 0);
    const visits = this.db.prepare('SELECT COUNT(*) n FROM parties WHERE phone = ?');
    const tonight = businessDayStart(now, this.settings.timezone);
    return {
      total,
      parties: rows.map((p) => ({
        ...this.publicParty(p),
        phone: p.phone,
        email: p.email,
        newsOptIn: Boolean(p.news_opt_in),
        notes: p.notes,
        source: p.source,
        quoted: p.quoted,
        endedAt: p.ended_at,
        tableIds: p.table_ids,
        visits: p.phone ? visits.get(p.phone).n : 1,
        tonight: p.created_at >= tonight,
      })),
    };
  }

  historyFilter({ q, range, status }, now) {
    const clauses = [];
    const args = [];
    const day = 86400000;
    const tonight = businessDayStart(now, this.settings.timezone);
    if (range === 'tonight') {
      clauses.push('created_at >= ?');
      args.push(tonight);
    } else if (range === 'yesterday') {
      clauses.push('created_at >= ? AND created_at < ?');
      args.push(tonight - day, tonight);
    } else if (range === '7d' || range === '30d') {
      clauses.push('created_at >= ?');
      args.push(tonight - (range === '7d' ? 7 : 30) * day);
    }
    if (['waiting', 'notified', 'seated', 'cancelled', 'noshow'].includes(status)) {
      clauses.push('status = ?');
      args.push(status);
    }
    const term = String(q || '').trim().toLowerCase();
    if (term) {
      const digits = term.replace(/\D/g, '');
      const like = `%${term}%`;
      if (digits.length >= 3) {
        clauses.push('(LOWER(name) LIKE ? OR LOWER(email) LIKE ? OR phone LIKE ?)');
        args.push(like, like, `%${digits}%`);
      } else {
        clauses.push('(LOWER(name) LIKE ? OR LOWER(email) LIKE ?)');
        args.push(like, like);
      }
    }
    return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', args };
  }

  // A returning guest, found by phone number.
  lookupGuest(phone) {
    const e164 = normalizePhone(phone);
    if (!e164) return null;
    const last = this.db.prepare('SELECT * FROM parties WHERE phone = ? ORDER BY created_at DESC LIMIT 1').get(e164);
    if (!last) return null;
    const email = this.db
      .prepare(`SELECT email FROM parties WHERE phone = ? AND email IS NOT NULL ORDER BY created_at DESC LIMIT 1`)
      .get(e164);
    const visits = this.db.prepare('SELECT COUNT(*) n FROM parties WHERE phone = ?').get(e164).n;
    const optIn = this.db.prepare('SELECT 1 FROM parties WHERE phone = ? AND news_opt_in = 1 LIMIT 1').get(e164);
    return { name: last.name, email: email ? email.email : null, newsOptIn: Boolean(optIn), visits, lastVisit: last.created_at };
  }

  // CSV of every visit in the filter.
  visitsCsv(filter, now = Date.now()) {
    const { where, args } = this.historyFilter(filter, now);
    const rows = this.db.prepare(`SELECT * FROM parties ${where} ORDER BY created_at DESC`).all(...args);
    const labels = new Map(this.tables().map((t) => [t.id, t.label]));
    const fmt = localFormatter(this.settings.timezone);
    return toCsv(
      ['Date', 'Time', 'Name', 'Party size', 'Phone', 'Email', 'Email opt-in', 'Outcome', 'Quoted (min)', 'Waited (min)', 'Table', 'Joined by', 'Notes'],
      rows.map((p) => {
        const [date, time] = fmt(p.created_at);
        const end = p.seated_at || p.ended_at;
        return [
          date,
          time,
          p.name,
          p.size,
          formatPhone(p.phone),
          p.email || '',
          p.news_opt_in ? 'Yes' : 'No',
          OUTCOME[p.status],
          p.quoted ?? '',
          end ? Math.round((end - p.created_at) / 60000) : '',
          (p.table_ids || '').split(',').map((id) => labels.get(id)).filter(Boolean).join(' + '),
          SOURCE[p.source] || 'Staff',
          p.notes,
        ];
      })
    );
  }

  // CSV with one row per guest (by phone or email), for a mailing list.
  guestsCsv() {
    const rows = this.db
      .prepare(`SELECT * FROM parties WHERE phone IS NOT NULL OR email IS NOT NULL ORDER BY created_at`)
      .all();
    const guests = new Map();
    for (const p of rows) {
      const key = p.phone || p.email.toLowerCase();
      const g = guests.get(key) || { visits: 0, first: p.created_at, optIn: false };
      g.name = p.name;
      g.phone = p.phone || g.phone;
      g.email = p.email || g.email;
      g.optIn = g.optIn || Boolean(p.news_opt_in);
      g.visits += 1;
      g.last = p.created_at;
      guests.set(key, g);
    }
    const fmt = localFormatter(this.settings.timezone);
    return toCsv(
      ['Name', 'Phone', 'Email', 'Email opt-in', 'Visits', 'First visit', 'Last visit'],
      [...guests.values()]
        .sort((a, b) => b.last - a.last)
        .map((g) => [g.name, formatPhone(g.phone), g.email || '', g.optIn ? 'Yes' : 'No', g.visits, fmt(g.first)[0], fmt(g.last)[0]])
    );
  }

  // ---- writes ------------------------------------------------------------

  async addParty({ name, size, phone, email, newsOptIn = false, notes = '', source = 'staff' }, now = Date.now()) {
    name = String(name || '').trim().slice(0, 40);
    size = Number(size);
    if (!name) throw new UserError('Please enter a name.');
    if (!Number.isInteger(size) || size < 1) throw new UserError('Party size must be at least 1.');
    if (size > MAX_PARTY) throw new UserError(`For parties over ${MAX_PARTY}, please see the host.`);
    let e164 = null;
    if (phone) {
      e164 = normalizePhone(phone);
      if (!e164) throw new UserError('That phone number doesn’t look right.');
    }
    const mail = normalizeEmail(email);
    if (email && !mail) throw new UserError('That email address doesn’t look right.');
    if (source === 'guest' && !e164) throw new UserError('Please enter a mobile number so we can text you.');
    if (e164) {
      const dupe = this.db
        .prepare(`SELECT token FROM parties WHERE phone = ? AND status IN ('waiting', 'notified')`)
        .get(e164);
      if (dupe && source === 'guest') return this.partyByToken(dupe.token);
    }

    const quoted = this.quoteFor(size, now);
    const token = crypto.randomBytes(9).toString('base64url');
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO parties (token, name, size, phone, email, news_opt_in, notes, source, quoted, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(token, name, size, e164, mail, newsOptIn ? 1 : 0, String(notes).slice(0, 120), source, quoted, now);
    const party = this.party(Number(lastInsertRowid));

    if (e164) {
      const wait = quoted ? `about ${quoted} minutes` : 'a short wait';
      await this.text(
        party,
        `Hi ${name}, you're on the waitlist at ${this.venue}! Party of ${size}, ${wait}. ` +
          `Follow your spot in line here: ${this.baseUrl}/s/${token}\nReply STOP to opt out.`
      );
    }
    this.onChange();
    return party;
  }

  updateParty(id, fields) {
    const p = this.mustGet(id);
    const name = fields.name != null ? String(fields.name).trim().slice(0, 40) : p.name;
    const size = fields.size != null ? Number(fields.size) : p.size;
    const notes = fields.notes != null ? String(fields.notes).slice(0, 120) : p.notes;
    let phone = p.phone;
    if (fields.phone !== undefined) {
      phone = fields.phone ? normalizePhone(fields.phone) : null;
      if (fields.phone && !phone) throw new UserError('That phone number doesn’t look right.');
    }
    let email = p.email;
    if (fields.email !== undefined) {
      email = normalizeEmail(fields.email);
      if (fields.email && !email) throw new UserError('That email address doesn’t look right.');
    }
    const newsOptIn = fields.newsOptIn !== undefined ? (fields.newsOptIn ? 1 : 0) : p.news_opt_in;
    if (!name) throw new UserError('Please enter a name.');
    if (!Number.isInteger(size) || size < 1 || size > MAX_PARTY) throw new UserError(`Party size must be 1 to ${MAX_PARTY}.`);
    this.db
      .prepare('UPDATE parties SET name = ?, size = ?, notes = ?, phone = ?, email = ?, news_opt_in = ? WHERE id = ?')
      .run(name, size, notes, phone, email, newsOptIn, id);
    this.onChange();
    return this.party(id);
  }

  async notify(id, now = Date.now()) {
    const p = this.mustGet(id);
    if (!ACTIVE.includes(p.status)) throw new UserError('That party is no longer waiting.');
    if (!p.phone) throw new UserError('No phone number for this party. Call their name instead.');
    this.db.prepare(`UPDATE parties SET status = 'notified', notified_at = ? WHERE id = ?`).run(now, id);
    const body =
      `${p.name}, your table at ${this.venue} is ready! Please check in with the host within ` +
      `${this.settings.noShowMinutes} minutes. Can't make it? Reply C and we'll release your spot.`;
    const result = await this.text(p, body);
    this.onChange();
    // In demo mode the staff screen offers to send this from the device's own Messages app.
    return { ...result, to: p.phone, body };
  }

  seat(id, tableIds, now = Date.now()) {
    const p = this.mustGet(id);
    if (!ACTIVE.includes(p.status)) throw new UserError('That party is no longer waiting.');
    this.db.exec('BEGIN');
    try {
      this.seatTables(p, tableIds, now);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    this.onChange();
  }

  // Put a party at one or more open tables. The caller holds the transaction.
  seatTables(p, tableIds, now) {
    tableIds = [...new Set(tableIds || [])];
    if (!tableIds.length) throw new UserError('Pick a table.');
    const tables = tableIds.map((tid) => {
      const t = this.db.prepare('SELECT * FROM tables WHERE id = ?').get(tid);
      if (!t) throw new UserError('Unknown table.');
      if (t.party_id) throw new UserError(`${t.label} is taken.`);
      return t;
    });
    const seats = tables.reduce((n, t) => n + t.seats, 0);
    if (seats < p.size) throw new UserError(`Those tables seat ${seats}, but the party is ${p.size}.`);
    const setTable = this.db.prepare('UPDATE tables SET party_id = ?, seated_at = ? WHERE id = ?');
    for (const t of tables) setTable.run(p.id, now, t.id);
    this.db
      .prepare(`UPDATE parties SET status = 'seated', seated_at = ?, ended_at = ?, table_ids = ? WHERE id = ?`)
      .run(now, now, tableIds.join(','), p.id);
  }

  // A walk-in who can sit right away: on the list and at a table in one step.
  // No name, phone or email, so nothing is ever texted.
  seatWalkIn({ size, tableIds }, now = Date.now()) {
    size = Number(size);
    if (!Number.isInteger(size) || size < 1 || size > MAX_PARTY) throw new UserError(`Party size must be 1 to ${MAX_PARTY}.`);
    const token = crypto.randomBytes(9).toString('base64url');
    this.db.exec('BEGIN');
    let id;
    try {
      ({ lastInsertRowid: id } = this.db
        .prepare(
          `INSERT INTO parties (token, name, size, source, quoted, created_at) VALUES (?, 'Walk-in', ?, 'walkin', 0, ?)`
        )
        .run(token, size, now));
      id = Number(id);
      this.seatTables(this.party(id), tableIds, now);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    this.onChange();
    return this.party(id);
  }

  remove(id, reason, now = Date.now()) {
    const p = this.mustGet(id);
    if (!ACTIVE.includes(p.status)) throw new UserError('That party is no longer waiting.');
    const status = reason === 'noshow' ? 'noshow' : 'cancelled';
    this.db.prepare('UPDATE parties SET status = ?, ended_at = ? WHERE id = ?').run(status, now, id);
    this.onChange();
  }

  // Undo a seat, cancel or no-show: put the party back in line where it was.
  restore(id, now = Date.now()) {
    const p = this.mustGet(id);
    if (ACTIVE.includes(p.status)) return;
    // A walk-in never waited, so undoing one just takes it back off the books.
    if (p.source === 'walkin') {
      this.db.exec('BEGIN');
      try {
        this.db.prepare('UPDATE tables SET party_id = NULL, seated_at = NULL WHERE party_id = ?').run(id);
        this.db.prepare('DELETE FROM parties WHERE id = ?').run(id);
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
      return this.onChange();
    }
    if (p.created_at < businessDayStart(now, this.settings.timezone)) {
      throw new UserError('That visit was on an earlier night. Use “Add again” instead.');
    }
    this.db.exec('BEGIN');
    try {
      this.db.prepare('UPDATE tables SET party_id = NULL, seated_at = NULL WHERE party_id = ?').run(id);
      this.db
        .prepare(
          `UPDATE parties SET status = CASE WHEN notified_at IS NULL THEN 'waiting' ELSE 'notified' END,
           seated_at = NULL, ended_at = NULL, table_ids = NULL WHERE id = ?`
        )
        .run(id);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    this.onChange();
  }

  clearTable(tableId) {
    const t = this.db.prepare('SELECT * FROM tables WHERE id = ?').get(tableId);
    if (!t) throw new UserError('Unknown table.');
    this.db.prepare('UPDATE tables SET party_id = NULL, seated_at = NULL WHERE id = ?').run(tableId);
    this.onChange();
  }

  // Start fresh: open every table and, if asked, take everyone off the line.
  // Tonight's stats then count only parties added after the reset.
  resetFloor({ clearLine = false } = {}, now = Date.now()) {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('UPDATE tables SET party_id = NULL, seated_at = NULL').run();
      if (clearLine) {
        this.db
          .prepare(`UPDATE parties SET status = 'cancelled', ended_at = ? WHERE status IN ('waiting', 'notified')`)
          .run(now);
      }
      setSetting(this.db, 'reset_at', now);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    this.onChange();
  }

  // Once per night, at the 4am rollover: open every table and close out anyone
  // still on the line from the night before. Returns true if it reset.
  dailyReset(now = Date.now()) {
    const dayStart = businessDayStart(now, this.settings.timezone);
    if (Number(getSetting(this.db, 'auto_reset_at', 0)) >= dayStart) return false;
    this.db.exec('BEGIN');
    try {
      this.db.prepare('UPDATE tables SET party_id = NULL, seated_at = NULL WHERE seated_at < ?').run(dayStart);
      this.db
        .prepare(`UPDATE parties SET status = 'cancelled', ended_at = ? WHERE status IN ('waiting', 'notified') AND created_at < ?`)
        .run(now, dayStart);
      setSetting(this.db, 'auto_reset_at', now);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    this.onChange();
    return true;
  }

  guestCancel(token, now = Date.now()) {
    const p = this.partyByToken(token);
    if (!p) throw new UserError('We couldn’t find that spot.');
    if (ACTIVE.includes(p.status)) {
      this.db.prepare(`UPDATE parties SET status = 'cancelled', ended_at = ? WHERE id = ?`).run(now, p.id);
      this.onChange();
    }
  }

  // An incoming text. Returns the reply to send back, or null.
  inboundText(from, body, now = Date.now()) {
    const phone = normalizePhone(from);
    const p = phone
      ? this.db
          .prepare(`SELECT * FROM parties WHERE phone = ? AND status IN ('waiting', 'notified') ORDER BY created_at DESC LIMIT 1`)
          .get(phone)
      : null;
    this.db
      .prepare(`INSERT INTO messages (party_id, direction, body, status, created_at) VALUES (?, 'in', ?, 'received', ?)`)
      .run(p ? p.id : null, String(body).slice(0, 500), now);
    if (!p) return null;
    let reply = null;
    if (/^\s*(c|cancel|can'?t make it)\s*[.!]?\s*$/i.test(body)) {
      this.db.prepare(`UPDATE parties SET status = 'cancelled', ended_at = ? WHERE id = ?`).run(now, p.id);
      reply = `No problem, ${p.name}. You're off the waitlist. We hope to see you again soon!`;
    }
    this.onChange();
    return reply;
  }

  async text(party, body) {
    let result;
    try {
      result = await this.sms(party.phone, body);
    } catch (err) {
      console.error('[sms] send failed', err);
      result = { status: 'failed', error: err.message };
    }
    this.db
      .prepare(`INSERT INTO messages (party_id, direction, body, status, created_at) VALUES (?, 'out', ?, ?, ?)`)
      .run(party.id, body, result.status, Date.now());
    return result;
  }

  mustGet(id) {
    const p = this.party(Number(id));
    if (!p) throw new UserError('That party isn’t on the list.');
    return p;
  }
}

class UserError extends Error {}

const SOURCE = { guest: 'QR code', staff: 'Staff', walkin: 'Walk-in' };

const OUTCOME = { waiting: 'Waiting', notified: 'Texted', seated: 'Seated', cancelled: 'Removed', noshow: 'No-show' };

function normalizeEmail(input) {
  const email = String(input || '').trim().toLowerCase();
  if (!email) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && email.length <= 120 ? email : null;
}

function localFormatter(timezone) {
  const d = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const t = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit' });
  return (ts) => [d.format(new Date(ts)), t.format(new Date(ts))];
}

function toCsv(header, rows) {
  const cell = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@]/.test(s)) s = "'" + s; // keep spreadsheets from running it as a formula
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

// The taphouse's "day" starts at 4am local time, so a late close still counts as one night.
function businessDayStart(now, timezone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(now))
      .map((x) => [x.type, Number(x.value)])
  );
  let day = Date.UTC(parts.year, parts.month - 1, parts.day, 4);
  if (parts.hour < 4) day -= 86400000;
  // Shift from "4am UTC" to "4am in the taphouse's time zone".
  const offset = tzOffset(day, timezone);
  return day - offset;
}

function tzOffset(ts, timezone) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(ts))
      .map((x) => [x.type, Number(x.value)])
  );
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(ts / 60000) * 60000;
}

module.exports = { Waitlist, UserError, businessDayStart, normalizeEmail, toCsv, fits, MAX_PARTY };
