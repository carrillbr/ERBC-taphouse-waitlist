const test = require('node:test');
const assert = require('node:assert/strict');
const { estimateWaits, quote } = require('../lib/estimate');
const { normalizePhone } = require('../lib/phone');
const { openDb, syncTables } = require('../lib/db');
const { Waitlist, UserError, businessDayStart } = require('../lib/waitlist');
const { validTwilioSignature } = require('../lib/sms');
const crypto = require('node:crypto');

const settings = { turn2: 45, turn4: 60, noShowMinutes: 10, timezone: 'America/Chicago' };
const NOW = Date.UTC(2026, 9, 24, 23, 0); // 6pm Chicago
const floor = () => [
  { id: 't1', seats: 4, seatedAt: null },
  { id: 't2', seats: 4, seatedAt: null },
  { id: 't3', seats: 4, seatedAt: null },
  { id: 't4', seats: 4, seatedAt: null },
  { id: 't5', seats: 2, seatedAt: null },
  { id: 't6', seats: 2, seatedAt: null },
];

test('empty floor means no wait', () => {
  const est = estimateWaits(floor(), [{ id: 1, size: 4 }], settings, NOW);
  assert.equal(est.get(1), 0);
});

test('full floor: wait until the first fitting table turns', () => {
  const tables = floor().map((t) => ({ ...t, seatedAt: NOW - 30 * 60000 }));
  const est = estimateWaits(tables, [{ id: 1, size: 2 }, { id: 2, size: 4 }], settings, NOW);
  assert.equal(est.get(1), 15); // a 2-top frees 45 - 30 = 15 min from now
  assert.equal(est.get(2), 30); // a 4-top frees 60 - 30 = 30 min from now
});

test('a group of 6 waits for two 4-tops', () => {
  const tables = floor().map((t, i) => ({ ...t, seatedAt: t.seats === 4 ? NOW - (50 - i * 10) * 60000 : null }));
  // 4-tops free in 10, 20, 30, 40 min
  const est = estimateWaits(tables, [{ id: 1, size: 6 }], settings, NOW);
  assert.equal(est.get(1), 20);
});

test('pairs prefer 2-tops so 4-tops stay free', () => {
  const est = estimateWaits(floor(), [{ id: 1, size: 2 }, { id: 2, size: 2 }, { id: 3, size: 2 }, { id: 4, size: 4 }], settings, NOW);
  assert.equal(est.get(4), 0);
});

test('quotes round up to 5 minutes', () => {
  assert.equal(quote(1), 0);
  assert.equal(quote(11), 15);
  assert.equal(quote(null), null);
});

test('phone numbers', () => {
  assert.equal(normalizePhone('(763) 555-0142'), '+17635550142');
  assert.equal(normalizePhone('1-763-555-0142'), '+17635550142');
  assert.equal(normalizePhone('555-0142'), null);
});

test('business day starts at 4am local', () => {
  const lateNight = Date.UTC(2026, 9, 25, 6, 30); // 1:30am Chicago on the 25th
  assert.equal(new Date(businessDayStart(lateNight, 'America/Chicago')).toISOString(), '2026-10-24T09:00:00.000Z');
});

test('twilio signature check', () => {
  const params = { From: '+17635550142', Body: 'C' };
  const url = 'https://example.com/sms/inbound';
  const sig = crypto.createHmac('sha1', 'secret').update(url + 'BodyCFrom+17635550142').digest('base64');
  assert.ok(validTwilioSignature('secret', url, params, sig));
  assert.ok(!validTwilioSignature('secret', url, { ...params, Body: 'X' }, sig));
});

function makeWaitlist() {
  const db = openDb(':memory:');
  syncTables(db, '1:4,2:4,3:4,4:4,5:2,6:2');
  const sent = [];
  const wl = new Waitlist(db, {
    settings,
    venue: 'Elk River Brewing',
    baseUrl: 'https://wait.example.com',
    sms: async (to, body) => (sent.push({ to, body }), { status: 'queued' }),
  });
  return { wl, sent };
}

test('full flow: add, text, seat, clear, undo', async () => {
  const { wl, sent } = makeWaitlist();
  const a = await wl.addParty({ name: 'Sam', size: 4, phone: '763-555-0101' });
  const b = await wl.addParty({ name: 'Lee', size: 2 });
  assert.equal(sent.length, 1);
  assert.match(sent[0].body, /wait\.example\.com\/s\//);

  await wl.notify(a.id);
  assert.match(sent[1].body, /table at Elk River Brewing is ready/);
  await assert.rejects(wl.notify(b.id), UserError); // no phone

  wl.seat(a.id, ['t1']);
  assert.throws(() => wl.seat(b.id, ['t1']), /taken/);
  assert.throws(() => wl.seat(b.id, []), /Pick a table/);
  wl.seat(b.id, ['t5']);

  let s = wl.staffState();
  assert.equal(s.waiting.length, 0);
  assert.equal(s.tables.find((t) => t.id === 't1').party.name, 'Sam');
  assert.equal(s.stats.seated, 2);

  wl.restore(b.id);
  s = wl.staffState();
  assert.equal(s.waiting.length, 1);
  assert.equal(s.tables.find((t) => t.id === 't5').party, null);

  wl.clearTable('t1');
  assert.equal(wl.staffState().tables.find((t) => t.id === 't1').party, null);
});

test('big group needs enough seats', async () => {
  const { wl } = makeWaitlist();
  const p = await wl.addParty({ name: 'Crew', size: 7 });
  assert.throws(() => wl.seat(p.id, ['t1']), /seat 4/);
  wl.seat(p.id, ['t1', 't2']);
  await assert.rejects(wl.addParty({ name: 'Huge', size: 12 }), /over 8/);
});

test('guest joins, sees position, replies C to cancel', async () => {
  const { wl } = makeWaitlist();
  await wl.addParty({ name: 'First', size: 2 });
  const g = await wl.addParty({ name: 'Guest', size: 3, phone: '7635550199', source: 'guest' });
  const again = await wl.addParty({ name: 'Guest', size: 3, phone: '7635550199', source: 'guest' });
  assert.equal(again.id, g.id); // no duplicate spot
  assert.equal(wl.guestState(g.token).position, 2);
  const reply = wl.inboundText('+17635550199', 'c');
  assert.match(reply, /off the waitlist/);
  assert.equal(wl.guestState(g.token).status, 'cancelled');
  await assert.rejects(wl.addParty({ name: 'NoPhone', size: 2, source: 'guest' }), /mobile number/);
});

test('email capture, history search, returning guests and CSV', async () => {
  const { wl } = makeWaitlist();
  const lastWeek = NOW - 5 * 86400000;
  const old = await wl.addParty({ name: 'Dana', size: 2, phone: '763-555-0110', email: 'Dana@Example.com', newsOptIn: true }, lastWeek);
  wl.seat(old.id, ['t5'], lastWeek + 20 * 60000);
  wl.clearTable('t5');
  await assert.rejects(wl.addParty({ name: 'X', size: 2, email: 'not-an-email' }), /email/);

  const tonight = await wl.addParty({ name: 'Dana', size: 3, phone: '7635550110' }, NOW);
  wl.remove(tonight.id, 'cancelled', NOW + 60000);

  assert.equal(wl.lookupGuest('(763) 555-0110').visits, 2);
  assert.equal(wl.lookupGuest('(763) 555-0110').email, 'dana@example.com');

  assert.equal(wl.history({ range: 'tonight' }, NOW + 120000).total, 1);
  assert.equal(wl.history({ range: '7d' }, NOW + 120000).total, 2);
  assert.equal(wl.history({ q: '0110', range: 'all' }, NOW).total, 2);
  assert.equal(wl.history({ q: 'example.com', range: 'all' }, NOW).total, 1);
  assert.equal(wl.history({ status: 'seated', range: 'all' }, NOW).total, 1);

  assert.throws(() => wl.restore(old.id, NOW), /earlier night/);
  wl.restore(tonight.id, NOW + 120000);
  assert.equal(wl.party(tonight.id).status, 'waiting');

  const visits = wl.visitsCsv({ range: 'all' }, NOW);
  assert.match(visits, /^Date,Time,Name/);
  assert.match(visits, /dana@example\.com,Yes,Seated,/);
  const guests = wl.guestsCsv().trim().split('\r\n');
  assert.equal(guests.length, 2); // header + one guest, both visits merged
  assert.match(guests[1], /^Dana,\(763\) 555-0110,dana@example\.com,Yes,2,/);
});
