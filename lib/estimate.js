// Wait-time estimates.
//
// We simulate the next few hours of the floor: every table knows when it should
// free up (now if empty, otherwise seated time + its usual turn time). Parties
// are seated in line order on whichever fitting table frees up first. A party's
// estimate is how long until its table is free.

const MAX_PARTY = 8;

// Which table combinations can seat a party of this size.
// Returns arrays of seat-counts, e.g. [[2], [4]] or [[4, 4]].
function fits(size) {
  if (size <= 2) return [[2], [4]];
  if (size <= 4) return [[4]];
  if (size <= MAX_PARTY) return [[4, 4]];
  return [];
}

function turnFor(seats, settings) {
  return seats <= 2 ? settings.turn2 : settings.turn4;
}

// tables: [{ id, seats, seatedAt (ms) | null }]
// queue:  [{ id, size }] in line order
// Returns Map partyId -> minutes until seated (0 = a table is free now).
function estimateWaits(tables, queue, settings, now = Date.now()) {
  const freeAt = new Map();
  for (const t of tables) {
    const due = t.seatedAt ? t.seatedAt + turnFor(t.seats, settings) * 60000 : now;
    freeAt.set(t.id, Math.max(now, due));
  }

  const result = new Map();
  for (const party of queue) {
    let best = null;
    for (const combo of fits(party.size)) {
      const picked = pickTables(tables, freeAt, combo);
      if (!picked) continue;
      const start = Math.max(...picked.map((t) => freeAt.get(t.id)));
      // Prefer the earliest start; on a tie prefer fewer total seats (keep 4-tops for bigger groups).
      const seats = picked.reduce((n, t) => n + t.seats, 0);
      if (!best || start < best.start || (start === best.start && seats < best.seats)) {
        best = { start, picked, seats };
      }
    }
    if (!best) {
      result.set(party.id, null);
      continue;
    }
    for (const t of best.picked) {
      freeAt.set(t.id, best.start + turnFor(t.seats, settings) * 60000);
    }
    result.set(party.id, Math.round((best.start - now) / 60000));
  }
  return result;
}

// For a combo like [4, 4], take the earliest-free distinct tables of those sizes.
function pickTables(tables, freeAt, combo) {
  const used = new Set();
  const picked = [];
  for (const seats of combo) {
    const options = tables
      .filter((t) => t.seats === seats && !used.has(t.id))
      .sort((a, b) => freeAt.get(a.id) - freeAt.get(b.id));
    if (!options.length) return null;
    used.add(options[0].id);
    picked.push(options[0]);
  }
  return picked;
}

// Round a raw estimate the way a host would quote it.
function quote(minutes) {
  if (minutes == null) return null;
  if (minutes <= 2) return 0;
  return Math.ceil(minutes / 5) * 5;
}

module.exports = { estimateWaits, quote, fits, MAX_PARTY };
