// Elk River Brewing Co. TapHouse waitlist: a small, dependency-free Node server.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { openDb, syncTables, getSetting, setSetting } = require('./lib/db');
const { Waitlist, UserError } = require('./lib/waitlist');
const { smsConfig, sendSms, validTwilioSignature } = require('./lib/sms');

const env = process.env;
const PORT = Number(env.PORT || 3000);
const BASE_URL = (env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const STAFF_PIN = env.STAFF_PIN || '1234';
const PUBLIC_DIR = path.join(__dirname, 'public');

if (!env.STAFF_PIN) console.warn('[setup] STAFF_PIN is not set; using 1234. Set it before going live.');

const db = openDb(env.DB_PATH || path.join(__dirname, 'data', 'waitlist.db'));
syncTables(db, env.TABLES || '20:4,21:4,22:4,23:4,10:2,11:2');

let secret = getSetting(db, 'session_secret', null);
if (!secret) {
  secret = crypto.randomBytes(32).toString('hex');
  setSetting(db, 'session_secret', secret);
}

const sms = smsConfig(env);
console.log(sms.enabled ? '[sms] Twilio texting is on' : '[sms] Demo mode: texts are logged, not sent');

// ---- live updates (server-sent events) ------------------------------------

const streams = new Set();
function broadcast() {
  for (const res of streams) res.write('event: change\ndata: {}\n\n');
}
setInterval(() => {
  for (const res of streams) res.write(': ping\n\n');
}, 25000).unref();

const waitlist = new Waitlist(db, {
  venue: env.VENUE_NAME || 'Elk River Brewing Co. TapHouse',
  baseUrl: BASE_URL,
  settings: {
    turn2: Number(env.TURN_MINUTES_2TOP || 45),
    turn4: Number(env.TURN_MINUTES_4TOP || 60),
    noShowMinutes: Number(env.NO_SHOW_MINUTES || 10),
    timezone: env.TIMEZONE || 'America/New_York',
  },
  sms: (to, body) => sendSms(to, body, sms),
  onChange: broadcast,
});

// ---- helpers ---------------------------------------------------------------

const staffToken = () => crypto.createHmac('sha256', secret).update(`staff:${STAFF_PIN}`).digest('base64url');

function cookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || '')
      .split(';')
      .map((c) => c.trim().split('='))
      .filter(([k]) => k)
      .map(([k, ...v]) => [k, decodeURIComponent(v.join('='))])
  );
}

function isStaff(req) {
  const got = Buffer.from(cookies(req).staff || '');
  const want = Buffer.from(staffToken());
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 20000) {
        reject(new UserError('Request too large.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      const type = req.headers['content-type'] || '';
      try {
        if (type.includes('application/json')) resolve(data ? JSON.parse(data) : {});
        else resolve(Object.fromEntries(new URLSearchParams(data)));
      } catch {
        reject(new UserError('Bad request.'));
      }
    });
    req.on('error', reject);
  });
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

function serveFile(res, file) {
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR)) return send(res, 404, 'Not found');
  fs.readFile(full, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream',
      'Cache-Control': file.endsWith('.html') ? 'no-cache' : 'public, max-age=300',
    });
    res.end(data);
  });
}

function openStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  streams.add(res);
  req.on('close', () => streams.delete(res));
}

// A light limit on guest sign-ups so the public form can't be used to send lots of texts.
const joins = new Map();
function allowJoin(ip) {
  const now = Date.now();
  const recent = (joins.get(ip) || []).filter((t) => now - t < 10 * 60000);
  if (recent.length >= 5) return false;
  recent.push(now);
  joins.set(ip, recent);
  return true;
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
}

// ---- routes ----------------------------------------------------------------

async function route(req, res) {
  const url = new URL(req.url, BASE_URL);
  const p = url.pathname;
  const m = req.method;
  let match;

  // Pages
  if (m === 'GET' && p === '/') return serveFile(res, 'staff.html');
  if (m === 'GET' && p === '/join') return serveFile(res, 'join.html');
  if (m === 'GET' && p === '/qr') return serveFile(res, 'qr.html');
  if (m === 'GET' && p === '/privacy') return serveFile(res, 'privacy.html');
  if (m === 'GET' && /^\/s\/[\w-]+$/.test(p)) return serveFile(res, 'status.html');
  if (m === 'GET' && p.startsWith('/static/')) return serveFile(res, p.slice('/static/'.length));
  if (m === 'GET' && p === '/healthz') return send(res, 200, 'ok');

  // Guest API
  if (m === 'GET' && p === '/api/public') {
    return send(res, 200, { venue: waitlist.venue, open: waitlist.selfJoinOpen(), quotes: waitlist.quotes() });
  }
  if (m === 'POST' && p === '/api/join') {
    if (!waitlist.selfJoinOpen()) throw new UserError('Online sign-up is paused right now. Please see the host.');
    if (!allowJoin(clientIp(req))) throw new UserError('Too many sign-ups from this device. Please see the host.');
    const body = await readBody(req);
    if (!body.consent || body.consent === 'false') throw new UserError('Please agree to receive texts about your table.');
    const party = await waitlist.addParty({
      name: body.name,
      size: body.size,
      phone: body.phone,
      email: body.email,
      newsOptIn: body.newsOptIn === true || body.newsOptIn === 'true',
      source: 'guest',
    });
    return send(res, 200, { token: party.token });
  }
  if ((match = p.match(/^\/api\/guest\/([\w-]+)$/)) && m === 'GET') {
    const state = waitlist.guestState(match[1]);
    return state ? send(res, 200, state) : send(res, 404, { error: 'We couldn’t find that spot.' });
  }
  if ((match = p.match(/^\/api\/guest\/([\w-]+)\/cancel$/)) && m === 'POST') {
    waitlist.guestCancel(match[1]);
    return send(res, 200, { ok: true });
  }
  if (m === 'GET' && p === '/api/guest-stream') return openStream(req, res);

  // Twilio inbound texts
  if (m === 'POST' && p === '/sms/inbound') {
    const body = await readBody(req);
    if (!validTwilioSignature(sms.token, BASE_URL + req.url, body, req.headers['x-twilio-signature'])) {
      return send(res, 403, 'Invalid signature');
    }
    const reply = waitlist.inboundText(body.From, body.Body || '');
    const xml = reply ? `<Response><Message>${escapeXml(reply)}</Message></Response>` : '<Response/>';
    return send(res, 200, `<?xml version="1.0" encoding="UTF-8"?>${xml}`, { 'Content-Type': 'text/xml' });
  }

  // Staff login
  if (m === 'POST' && p === '/api/login') {
    const body = await readBody(req);
    await new Promise((r) => setTimeout(r, 300)); // slow down PIN guessing
    if (String(body.pin || '') !== STAFF_PIN) return send(res, 401, { error: 'Wrong PIN.' });
    const secure = BASE_URL.startsWith('https') ? '; Secure' : '';
    return send(res, 200, { ok: true }, {
      'Set-Cookie': `staff=${staffToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}${secure}`,
    });
  }
  if (m === 'POST' && p === '/api/logout') {
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'staff=; Path=/; Max-Age=0' });
  }

  // Staff API
  if (p.startsWith('/api/')) {
    if (!isStaff(req)) return send(res, 401, { error: 'Please sign in.' });

    if (m === 'GET' && p === '/api/state') return send(res, 200, { ...waitlist.staffState(), smsLive: sms.enabled });
    if (m === 'GET' && p === '/api/stream') return openStream(req, res);
    if (m === 'POST' && p === '/api/parties') {
      const body = await readBody(req);
      const party = await waitlist.addParty({ ...body, source: 'staff' });
      return send(res, 200, { id: party.id });
    }
    if (m === 'GET' && p === '/api/history') {
      const q = Object.fromEntries(url.searchParams);
      return send(res, 200, waitlist.history(q));
    }
    if (m === 'GET' && p === '/api/guests/lookup') {
      return send(res, 200, { guest: waitlist.lookupGuest(url.searchParams.get('phone')) });
    }
    if (m === 'GET' && (p === '/api/export/visits.csv' || p === '/api/export/guests.csv')) {
      const visits = p.endsWith('visits.csv');
      const csv = visits ? waitlist.visitsCsv(Object.fromEntries(url.searchParams)) : waitlist.guestsCsv();
      const stamp = new Date().toISOString().slice(0, 10);
      return send(res, 200, csv, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${visits ? 'waitlist-visits' : 'waitlist-guests'}-${stamp}.csv"`,
      });
    }
    if (m === 'POST' && p === '/api/self-join') {
      const body = await readBody(req);
      waitlist.setSelfJoin(Boolean(body.open));
      return send(res, 200, { ok: true });
    }
    if ((match = p.match(/^\/api\/parties\/(\d+)(?:\/(\w+))?$/))) {
      const [, id, action] = match;
      const body = m === 'POST' || m === 'PATCH' ? await readBody(req) : {};
      if (m === 'PATCH' && !action) return send(res, 200, { id: waitlist.updateParty(Number(id), body).id });
      if (m === 'POST' && action === 'notify') return send(res, 200, await waitlist.notify(Number(id)));
      if (m === 'POST' && action === 'seat') return send(res, 200, (waitlist.seat(Number(id), body.tableIds), { ok: true }));
      if (m === 'POST' && action === 'remove') return send(res, 200, (waitlist.remove(Number(id), body.reason), { ok: true }));
      if (m === 'POST' && action === 'restore') return send(res, 200, (waitlist.restore(Number(id)), { ok: true }));
    }
    if ((match = p.match(/^\/api\/tables\/(\w+)\/clear$/)) && m === 'POST') {
      waitlist.clearTable(match[1]);
      return send(res, 200, { ok: true });
    }
  }

  send(res, 404, 'Not found');
}

function escapeXml(s) {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);
}

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    if (err instanceof UserError) return send(res, 400, { error: err.message });
    console.error(err);
    send(res, 500, { error: 'Something went wrong. Try again.' });
  });
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`Waitlist running at ${BASE_URL} (staff screen at /, guest sign-up at /join)`));
}

module.exports = { server, waitlist, db };
