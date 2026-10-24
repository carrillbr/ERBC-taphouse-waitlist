// Staff screen: the live waitlist and table board.
(() => {
  const $ = (sel) => document.querySelector(sel);
  // The TapHouse welcomes kids; no pets.
  const NOTES = ['Kids', 'High chair', 'Booster', 'Wheelchair', 'Birthday'];
  const MAX_PARTY = 8;
  let state = null;
  let editing = null; // party id being edited, or null when adding
  let toastTimer = null;

  // ---- api ----------------------------------------------------------------

  async function api(path, body, method) {
    const res = await fetch(path, {
      method: method || (body ? 'POST' : 'GET'),
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && path !== '/api/login') {
      showLogin();
      throw new Error('Please sign in.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Something went wrong.');
    return data;
  }

  async function refresh() {
    try {
      state = await api('/api/state');
      showApp();
      render();
      if (view === 'history') loadHistory();
    } catch (err) {
      console.warn(err);
    }
  }

  let stream;
  function connect() {
    if (stream) stream.close();
    stream = new EventSource('/api/stream');
    stream.addEventListener('change', refresh);
    stream.onopen = refresh;
  }

  // ---- formatting ---------------------------------------------------------

  const mins = (from) => Math.max(0, Math.floor((Date.now() - from) / 60000));
  function dur(m) {
    if (m < 60) return `${m}m`;
    return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
  }
  const quoteText = (q) => (q == null ? 'Ask' : q === 0 ? 'Now' : `${q}m`);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmtPhone = (p) => {
    const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(p || '');
    return m ? `(${m[1]}) ${m[2]}-${m[3]}` : p || '';
  };
  const sizeClass = (n) => (n <= 2 ? 2 : n <= 4 ? 4 : 6);

  // ---- render -------------------------------------------------------------

  function render() {
    if (!state) return;
    $('#sms-mode').textContent = state.smsLive ? 'Good beer. Good food. Good people.' : 'Texts open in Messages on this device';
    $('#toggle-join').textContent = state.selfJoin ? 'Pause guest QR sign-up' : 'Resume guest QR sign-up';

    $('#quotes').innerHTML = [
      ['1–2', state.quotes[2]],
      ['3–4', state.quotes[4]],
      ['5–8', state.quotes[6]],
    ]
      .map(([label, q]) => `<span class="quote-pill" title="Quoted wait for ${label} guests">${label} <b>${quoteText(q)}</b></span>`)
      .join('');

    renderList();
    renderTables();
    renderStats();
    renderRecent();
  }

  function renderList() {
    const list = state.waiting;
    $('#count').textContent = list.length || '';
    $('#empty').hidden = list.length > 0;
    $('#list').innerHTML = list
      .map((p) => {
        const waited = mins(p.createdAt);
        const overdue = p.status === 'notified' && mins(p.notifiedAt) >= state.settings.noShowMinutes;
        const notes = p.notes ? p.notes.split(',').map((n) => n.trim()).filter(Boolean) : [];
        let status = '';
        if (p.status === 'notified') {
          status = overdue
            ? `Texted ${dur(mins(p.notifiedAt))} ago. Not here yet`
            : `Texted ${dur(mins(p.notifiedAt))} ago`;
          if (p.lastText && p.lastText.status === 'failed') status = 'Text failed. Call their name';
        }
        const reply = p.lastReply ? `<div class="party-reply">💬 “${esc(p.lastReply.body)}”</div>` : '';
        return `
          <li class="party card ${p.status} ${overdue ? 'overdue' : ''}" data-id="${p.id}">
            <div class="size" aria-label="Party of ${p.size}"><div><b>${p.size}</b><small>${p.size === 1 ? 'guest' : 'guests'}</small></div></div>
            <div>
              <div class="party-name">${esc(p.name)}
                ${p.source === 'guest' ? '<span class="tag web">QR</span>' : ''}
                ${notes.map((n) => `<span class="tag">${esc(n)}</span>`).join('')}
              </div>
              <div class="party-meta">
                <span>Waiting <b>${dur(waited)}</b></span>
                ${p.quoted != null ? `<span>Quoted ${quoteText(p.quoted)}</span>` : ''}
                ${p.status === 'waiting' ? `<span>Table in ~<b>${quoteText(p.estimate)}</b></span>` : ''}
                ${p.phone ? '' : '<span>No phone</span>'}
              </div>
              ${status ? `<div class="party-status">${status}</div>` : ''}
              ${reply}
            </div>
            <div class="party-actions">
              <button class="btn ${p.status === 'notified' ? '' : 'btn-accent'}" data-act="notify" ${p.phone ? '' : 'disabled'}>
                ${p.status === 'notified' ? 'Text again' : 'Text'}
              </button>
              <button class="btn btn-primary" data-act="seat">Seat</button>
              <button class="btn btn-ghost" data-act="more" aria-label="More for ${esc(p.name)}">•••</button>
            </div>
          </li>`;
      })
      .join('');
  }

  function renderTables() {
    $('#tables').innerHTML = state.tables
      .map((t) => {
        if (!t.party) {
          return `<button class="table-tile free" data-table="${t.id}">
            <span class="t-head">${esc(t.label)}<span class="t-seats">${t.seats}-top</span></span>
            <span class="t-state">Open</span>
          </button>`;
        }
        const long = Date.now() > t.dueAt;
        return `<button class="table-tile busy ${long ? 'long' : ''}" data-table="${t.id}">
          <span class="t-head">${esc(t.label)}<span class="t-seats">${t.seats}-top</span></span>
          <span class="t-state">${esc(t.party.name)} (${t.party.size})</span>
          <span class="t-time">Seated ${dur(mins(t.seatedAt))}${long ? ' · should be turning' : ''}</span>
        </button>`;
      })
      .join('');
  }

  function renderStats() {
    const s = state.stats;
    $('#stats').innerHTML = `
      <div><b>${s.parties}</b><span>parties</span></div>
      <div><b>${s.avgWait == null ? '0m' : dur(s.avgWait)}</b><span>avg wait</span></div>
      <div><b>${s.noShows}</b><span>no-shows</span></div>`;
  }

  function renderRecent() {
    const label = { seated: 'Seated', cancelled: 'Removed', noshow: 'No-show' };
    const tableName = (ids) =>
      (ids || '')
        .split(',')
        .map((id) => state.tables.find((t) => t.id === id)?.label)
        .filter(Boolean)
        .join(' + ');
    $('#recent').innerHTML =
      state.recent
        .map(
          (p) => `<li>
            <span><b>${esc(p.name)}</b> (${p.size}) · ${label[p.status]}${p.status === 'seated' && p.tableIds ? ` at ${esc(tableName(p.tableIds))}` : ''}
            <span class="muted">· ${dur(mins(p.endedAt))} ago</span></span>
            <button class="btn" data-restore="${p.id}">Put back</button>
          </li>`
        )
        .join('') || '<li class="muted">Nothing yet tonight.</li>';
  }

  // ---- add / edit party ---------------------------------------------------

  const form = $('#party-form');
  let partySize = 2;
  let partyNotes = new Set();

  // p = party to edit; copy = start a new party from an old visit's details.
  function openParty(p, copy = false) {
    editing = p && !copy ? p.id : null;
    form.reset();
    partySize = p ? p.size : 2;
    const notes = p && p.notes ? p.notes.split(',').map((n) => n.trim()) : [];
    partyNotes = new Set(notes.filter((n) => NOTES.includes(n)));
    form.name.value = p ? p.name : '';
    form.phone.value = p ? fmtPhone(p.phone) : '';
    form.email.value = p && p.email ? p.email : '';
    form.newsOptIn.checked = Boolean(p && p.newsOptIn);
    $('#returning').hidden = true;
    form.notes.value = notes.filter((n) => !NOTES.includes(n)).join(', ');
    $('#party-title').textContent = editing ? `Edit ${p.name}` : 'Add party';
    $('#party-submit').textContent = editing ? 'Save changes' : 'Add to waitlist';
    $('#party-error').textContent = '';
    renderPartyChips();
    $('#party-dialog').showModal();
    if (!p) form.name.focus();
    if (copy && p.phone) lookup();
  }

  // Recognize a returning guest from their phone number and fill in what we know.
  let lookupTimer = null;
  async function lookup() {
    const digits = form.phone.value.replace(/\D/g, '');
    if (editing || digits.length < 10) return ($('#returning').hidden = true);
    try {
      const { guest } = await api(`/api/guests/lookup?phone=${encodeURIComponent(form.phone.value)}`);
      if (!guest) return ($('#returning').hidden = true);
      if (!form.name.value.trim()) form.name.value = guest.name;
      if (!form.email.value.trim() && guest.email) form.email.value = guest.email;
      if (guest.newsOptIn) form.newsOptIn.checked = true;
      const last = new Date(guest.lastVisit).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      $('#returning').textContent = `Returning guest: ${guest.name}, ${guest.visits} visit${guest.visits === 1 ? '' : 's'}, last on ${last}`;
      $('#returning').hidden = false;
    } catch {}
  }
  form.phone.addEventListener('input', () => {
    clearTimeout(lookupTimer);
    lookupTimer = setTimeout(lookup, 400);
  });

  function renderPartyChips() {
    $('#size-chips').innerHTML = Array.from({ length: MAX_PARTY }, (_, i) => i + 1)
      .map((n) => `<button type="button" class="chip" data-size="${n}" aria-pressed="${n === partySize}">${n}</button>`)
      .join('');
    $('#note-chips').innerHTML = NOTES.map(
      (n) => `<button type="button" class="chip" data-note="${n}" aria-pressed="${partyNotes.has(n)}">${n}</button>`
    ).join('');
    const q = state.quotes[sizeClass(partySize)];
    $('#party-quote').textContent = editing ? '' : q === 0 ? 'No wait right now' : q == null ? '' : `Quote about ${q} minutes`;
  }

  $('#size-chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-size]');
    if (!b) return;
    partySize = Number(b.dataset.size);
    renderPartyChips();
  });
  $('#note-chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-note]');
    if (!b) return;
    const n = b.dataset.note;
    partyNotes.has(n) ? partyNotes.delete(n) : partyNotes.add(n);
    renderPartyChips();
  });

  form.addEventListener('submit', async (e) => {
    if (e.submitter && e.submitter.value === 'cancel') return;
    e.preventDefault();
    const notes = [...partyNotes, ...form.notes.value.split(',').map((s) => s.trim()).filter(Boolean)].join(', ');
    const body = {
      name: form.name.value,
      size: partySize,
      phone: form.phone.value,
      email: form.email.value,
      newsOptIn: form.newsOptIn.checked,
      notes,
    };
    const btn = $('#party-submit');
    btn.disabled = true;
    try {
      if (editing) await api(`/api/parties/${editing}`, body, 'PATCH');
      else await api('/api/parties', body);
      $('#party-dialog').close();
      toast(editing ? 'Saved' : `Added ${body.name.trim()}${body.phone ? ' and texted them a link' : ''}`);
      refresh();
    } catch (err) {
      $('#party-error').textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  // ---- seating ------------------------------------------------------------

  let seatingParty = null;
  let picked = new Set();

  // Tables that could take this party right now, best first.
  function seatChoices(size) {
    return state.tables
      .filter((t) => !t.party)
      .filter((t) => size > 4 ? t.seats === 4 : t.seats >= size)
      .sort((a, b) => a.seats - b.seats);
  }

  function openSeat(p) {
    seatingParty = p;
    picked = new Set();
    const multi = p.size > 4;
    $('#seat-title').textContent = `Seat ${p.name} (${p.size})`;
    $('#seat-error').textContent = '';
    $('#seat-foot').hidden = !multi;
    const options = seatChoices(p.size);
    const best = options[0];
    $('#seat-hint').textContent = !options.length || (multi && options.length < 2)
      ? multi
        ? `This group needs two open 4-tops pushed together. ${options.length} open right now.`
        : 'No open table fits this party. Clear a table first.'
      : multi
        ? 'Pick two 4-tops to push together.'
        : 'Tap a table to seat them.';
    $('#seat-options').className = 'seat-options';
    $('#seat-options').innerHTML = state.tables
      .map((t) => {
        const ok = options.includes(t);
        const why = t.party ? `${esc(t.party.name)} seated` : ok ? `${t.seats}-top · open` : `${t.seats}-top · too small`;
        return `<button class="seat-opt ${t === best && !multi ? 'best' : ''}" data-seat="${t.id}" ${ok ? '' : 'disabled'} aria-pressed="false">
          ${esc(t.label)}<small>${why}</small></button>`;
      })
      .join('');
    updateSeatConfirm();
    $('#seat-dialog').showModal();
  }

  // Tap an open table: choose who sits there.
  function openTablePick(t) {
    seatingParty = null;
    $('#seat-title').textContent = `Who's sitting at ${t.label}?`;
    $('#seat-error').textContent = '';
    $('#seat-foot').hidden = true;
    const fit = state.waiting.filter((p) => p.size <= t.seats);
    $('#seat-hint').textContent = fit.length ? 'In line order. Tap a party to seat them.' : `No one waiting fits a ${t.seats}-top. Walk-ins can sit here.`;
    $('#seat-options').className = 'seat-options people';
    $('#seat-options').innerHTML = fit
      .map(
        (p) => `<button class="seat-opt" data-party="${p.id}" data-table="${t.id}">${esc(p.name)} (${p.size})
          <small>Waiting ${dur(mins(p.createdAt))}${p.status === 'notified' ? ' · texted' : ''}</small></button>`
      )
      .join('');
    $('#seat-dialog').showModal();
  }

  function updateSeatConfirm() {
    const seats = [...picked].reduce((n, id) => n + state.tables.find((t) => t.id === id).seats, 0);
    $('#seat-confirm').disabled = !seatingParty || seats < seatingParty.size;
    $('#seat-confirm').textContent = picked.size ? `Seat at ${picked.size} table${picked.size > 1 ? 's' : ''} (${seats} seats)` : 'Pick tables';
  }

  async function seat(party, tableIds) {
    try {
      await api(`/api/parties/${party.id}/seat`, { tableIds });
      $('#seat-dialog').close();
      const names = tableIds.map((id) => state.tables.find((t) => t.id === id).label).join(' + ');
      toast(`Seated ${party.name} at ${names}`, party.id);
      refresh();
    } catch (err) {
      $('#seat-error').textContent = err.message;
    }
  }

  $('#seat-options').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    if (b.dataset.party) {
      const party = state.waiting.find((p) => p.id === Number(b.dataset.party));
      return seat(party, [b.dataset.table]);
    }
    if (!seatingParty) return;
    if (seatingParty.size <= 4) return seat(seatingParty, [b.dataset.seat]);
    const id = b.dataset.seat;
    picked.has(id) ? picked.delete(id) : picked.add(id);
    b.setAttribute('aria-pressed', picked.has(id));
    updateSeatConfirm();
  });
  $('#seat-confirm').addEventListener('click', () => seat(seatingParty, [...picked]));

  // ---- party list actions --------------------------------------------------

  let moreParty = null;
  $('#list').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const id = Number(b.closest('[data-id]').dataset.id);
    const p = state.waiting.find((x) => x.id === id);
    if (!p) return;
    if (b.dataset.act === 'seat') return openSeat(p);
    if (b.dataset.act === 'more') {
      moreParty = p;
      $('#more-title').textContent = `${p.name} (${p.size})`;
      $('#more-info').textContent = [fmtPhone(p.phone), p.email, p.notes].filter(Boolean).join(' · ');
      return $('#more-dialog').showModal();
    }
    if (b.dataset.act === 'notify') {
      b.disabled = true;
      try {
        const r = await api(`/api/parties/${id}/notify`, {});
        if (r.status === 'demo') {
          // No Twilio yet: hand the message to this phone or iPad's own Messages app.
          location.href = `sms:${r.to}?&body=${encodeURIComponent(r.body)}`;
          toast(`Opening Messages for ${p.name}`);
        } else {
          toast(r.status === 'failed' ? `Text to ${p.name} failed: ${r.error || 'unknown error'}. Call their name.` : `Texted ${p.name}`);
        }
      } catch (err) {
        toast(err.message);
      }
      refresh();
    }
  });

  $('#more-edit').addEventListener('click', () => {
    $('#more-dialog').close();
    openParty(moreParty);
  });
  for (const [btn, reason, verb] of [['#more-noshow', 'noshow', 'Marked no-show'], ['#more-remove', 'cancelled', 'Removed']]) {
    $(btn).addEventListener('click', async () => {
      try {
        await api(`/api/parties/${moreParty.id}/remove`, { reason });
        $('#more-dialog').close();
        toast(`${verb}: ${moreParty.name}`, moreParty.id);
        refresh();
      } catch (err) {
        toast(err.message);
      }
    });
  }

  // ---- tables --------------------------------------------------------------

  let clearing = null;
  $('#tables').addEventListener('click', (e) => {
    const b = e.target.closest('[data-table]');
    if (!b) return;
    const t = state.tables.find((x) => x.id === b.dataset.table);
    if (!t.party) return openTablePick(t);
    clearing = t;
    $('#clear-title').textContent = `Clear ${t.label}?`;
    $('#clear-info').textContent = `${t.party.name} (${t.party.size}) has been here ${dur(mins(t.seatedAt))}.`;
    $('#clear-dialog').showModal();
  });
  $('#clear-confirm').addEventListener('click', async () => {
    try {
      await api(`/api/tables/${clearing.id}/clear`, {});
      $('#clear-dialog').close();
      toast(`${clearing.label} is open`);
      refresh();
    } catch (err) {
      toast(err.message);
    }
  });

  $('#recent').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-restore]');
    if (!b) return;
    await api(`/api/parties/${b.dataset.restore}/restore`, {}).catch((err) => toast(err.message));
    refresh();
  });

  // ---- history ------------------------------------------------------------

  const hist = { q: '', range: '7d', status: '', offset: 0, rows: [], total: 0 };
  let view = 'list';

  function showView(next) {
    view = next;
    for (const t of document.querySelectorAll('.view-tab')) {
      t.toggleAttribute('aria-current', t.dataset.view === next);
      if (t.dataset.view === next) t.setAttribute('aria-current', 'page');
    }
    document.querySelector('.layout').hidden = next !== 'list';
    $('#history-view').hidden = next !== 'history';
    $('#quotes').hidden = next !== 'list';
    window.scrollTo(0, 0);
    if (next === 'history') loadHistory();
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-view]');
    if (b) showView(b.dataset.view);
  });

  function historyQuery(extra = {}) {
    return new URLSearchParams({ q: hist.q, range: hist.range, status: hist.status, ...extra }).toString();
  }

  async function loadHistory(more = false) {
    hist.offset = more ? hist.rows.length : 0;
    const data = await api(`/api/history?${historyQuery({ offset: hist.offset, limit: 100 })}`).catch((err) => (toast(err.message), null));
    if (!data) return;
    hist.rows = more ? [...hist.rows, ...data.parties] : data.parties;
    hist.total = data.total;
    $('#h-export').href = `/api/export/visits.csv?${historyQuery()}`;
    renderHistory();
  }

  function renderHistory() {
    const label = { waiting: 'Waiting', notified: 'Texted', seated: 'Seated', cancelled: 'Removed', noshow: 'No-show' };
    const tableName = (ids) =>
      (ids || '').split(',').map((id) => state.tables.find((t) => t.id === id)?.label).filter(Boolean).join(' + ');
    $('#h-count').textContent = `${hist.total} visit${hist.total === 1 ? '' : 's'}`;
    $('#h-more').hidden = hist.rows.length >= hist.total;
    if (!hist.rows.length) {
      $('#h-list').innerHTML = '<li class="card h-empty muted">No one matches. Try a wider date range.</li>';
      return;
    }
    $('#h-list').innerHTML = hist.rows
      .map((p) => {
        const d = new Date(p.createdAt);
        const day = p.tonight ? 'Tonight' : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
        const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
        const end = p.seatedAt || p.endedAt;
        const waited = end ? `waited ${dur(Math.round((end - p.createdAt) / 60000))}` : `waiting ${dur(mins(p.createdAt))}`;
        const active = p.status === 'waiting' || p.status === 'notified';
        let action = '';
        if (!active && p.tonight) action = `<button class="btn" data-h-restore="${p.id}">Put back in line</button>`;
        else if (!active) action = `<button class="btn" data-h-again="${p.id}">Add again</button>`;
        return `<li class="card h-row">
          <div class="h-when"><b>${esc(day)}</b>${esc(time)}</div>
          <div class="h-name">${esc(p.name)} <small>party of ${p.size}${p.visits > 1 ? ` · ${p.visits} visits` : ''}${p.source === 'guest' ? ' · QR' : ''}</small></div>
          <div class="h-contact">
            ${p.phone ? `<span><a href="tel:${esc(p.phone)}">${esc(fmtPhone(p.phone))}</a></span>` : '<span class="muted">No phone</span>'}
            ${p.email ? `<span><a href="mailto:${esc(p.email)}">${esc(p.email)}</a>${p.newsOptIn ? ' <span class="tag web">emails OK</span>' : ''}</span>` : ''}
          </div>
          <div class="h-outcome out-${p.status}">${label[p.status]}${p.status === 'seated' && p.tableIds ? ` · ${esc(tableName(p.tableIds))}` : ''}<small>${waited}</small></div>
          <div class="h-act">${action}</div>
        </li>`;
      })
      .join('');
  }

  let searchTimer = null;
  $('#h-search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      hist.q = e.target.value;
      // Looking someone up usually means "any time", not just this week.
      if (hist.q.trim() && hist.range !== 'all') {
        hist.range = 'all';
        for (const c of $('#h-range').querySelectorAll('.chip')) c.setAttribute('aria-pressed', c.dataset.range === 'all');
      }
      loadHistory();
    }, 300);
  });
  for (const [group, key] of [['#h-range', 'range'], ['#h-status', 'status']]) {
    $(group).addEventListener('click', (e) => {
      const b = e.target.closest('.chip');
      if (!b) return;
      for (const c of $(group).querySelectorAll('.chip')) c.setAttribute('aria-pressed', c === b);
      hist[key] = b.dataset[key];
      loadHistory();
    });
  }
  $('#h-more').addEventListener('click', () => loadHistory(true));
  $('#h-list').addEventListener('click', async (e) => {
    const r = e.target.closest('[data-h-restore]');
    const a = e.target.closest('[data-h-again]');
    if (r) {
      await api(`/api/parties/${r.dataset.hRestore}/restore`, {}).then(() => toast('Back on the waitlist')).catch((err) => toast(err.message));
      refresh();
      loadHistory();
    }
    if (a) openParty(hist.rows.find((p) => p.id === Number(a.dataset.hAgain)), true);
  });

  // ---- chrome ----------------------------------------------------------------

  function toast(text, undoId) {
    clearTimeout(toastTimer);
    $('#toast-text').textContent = text;
    const undo = $('#toast-undo');
    undo.hidden = !undoId;
    undo.onclick = async () => {
      $('#toast').hidden = true;
      await api(`/api/parties/${undoId}/restore`, {}).catch((err) => toast(err.message));
      refresh();
    };
    $('#toast').hidden = false;
    toastTimer = setTimeout(() => ($('#toast').hidden = true), undoId ? 7000 : 3500);
  }

  for (const d of document.querySelectorAll('dialog')) {
    d.addEventListener('click', (e) => {
      if (e.target === d || e.target.closest('[data-close]')) d.close();
    });
  }

  $('#add-btn').addEventListener('click', () => openParty(null));
  $('#menu-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    $('#menu').hidden = !$('#menu').hidden;
  });
  document.addEventListener('click', () => ($('#menu').hidden = true));
  $('#toggle-join').addEventListener('click', async () => {
    await api('/api/self-join', { open: !state.selfJoin });
    refresh();
  });
  $('#logout').addEventListener('click', async () => {
    await api('/api/logout', {});
    showLogin();
  });

  function showLogin() {
    if (stream) stream.close();
    $('#app').hidden = true;
    $('#login').hidden = false;
    $('#pin').focus();
  }
  function showApp() {
    $('#login').hidden = true;
    $('#app').hidden = false;
  }

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/login', { pin: $('#pin').value });
      $('#pin').value = '';
      $('#login-error').textContent = '';
      connect();
    } catch (err) {
      $('#login-error').textContent = err.message;
    }
  });

  // Keep the "waiting 12m" timers fresh between updates.
  setInterval(render, 20000);
  // Re-sync in case the live connection dropped (tablet asleep, Wi-Fi blip).
  setInterval(refresh, 60000);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && refresh());

  api('/api/state')
    .then((s) => {
      state = s;
      showApp();
      render();
      connect();
    })
    .catch(() => {});
})();
