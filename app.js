/* =========================================================
   Accounting Management System
   Modules: Chart of Accounts · Transactions · Trial Balance · Adjustments
   Data is saved in Supabase (Postgres). If config.js has no keys yet,
   it falls back to this browser's localStorage so the app still works.
   ========================================================= */
(() => {
  'use strict';

  /* ---------- Constants & helpers ---------- */
  const STORE_KEY = 'ams-v1';              // local mode: everything
  const SETTINGS_KEY = 'ams-settings-v1';  // database mode: only the period settings
  const GUIDE_KEY = 'ams-guide-hidden';

  // Supabase connection (keys live in config.js)
  const CFG_OK = !!(window.SUPABASE_URL && window.SUPABASE_ANON_KEY &&
    !/YOUR-/i.test(window.SUPABASE_URL + window.SUPABASE_ANON_KEY));
  const sb = (CFG_OK && window.supabase && window.supabase.createClient)
    ? window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY) : null;
  const useDB = !!sb;
  const NORMAL = { Asset: 'Debit', Liability: 'Credit', Equity: 'Credit', Revenue: 'Credit', Expense: 'Debit' };
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const pad = n => String(n).padStart(2, '0');
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const round2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
  const money = n => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const parseAmt = s => {
    const t = String(s || '').replace(/,/g, '').trim();
    if (t === '') return 0;
    const n = Number(t);
    return Number.isFinite(n) ? n : NaN;
  };
  // Entry ids are UUIDs because the database column is of type uuid
  const uid = () => (window.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 3 | 8)).toString(16);
      });
  const fmtDate = iso => {
    const [y, m, d] = iso.split('-').map(Number);
    return `${MONTHS[m - 1].slice(0, 3)} ${d}, ${y}`;
  };
  const todayISO = () => {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  const addDays = (iso, n) => {
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + n));
    return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
  };

  let toastTimer;
  function toast(msg, isError = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'show' + (isError ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.className = ''), 3200);
  }

  /* ---------- State ---------- */
  const defaultAccounts = () => [
    ['1000', 'Cash', 'Asset'], ['1100', 'Accounts Receivable', 'Asset'], ['1200', 'Supplies', 'Asset'],
    ['1300', 'Prepaid Insurance', 'Asset'], ['1500', 'Equipment', 'Asset'],
    ['1590', 'Accumulated Depreciation', 'Asset', 'Credit'],
    ['2000', 'Accounts Payable', 'Liability'], ['2100', 'Salaries Payable', 'Liability'], ['2200', 'Unearned Revenue', 'Liability'],
    ['3000', "Owner's Capital", 'Equity'], ['3100', "Owner's Drawings", 'Equity', 'Debit'],
    ['4000', 'Service Revenue', 'Revenue'],
    ['5000', 'Salaries Expense', 'Expense'], ['5100', 'Rent Expense', 'Expense'], ['5200', 'Utilities Expense', 'Expense'],
    ['5300', 'Supplies Expense', 'Expense'], ['5400', 'Insurance Expense', 'Expense'], ['5500', 'Depreciation Expense', 'Expense']
  ].map(([code, name, type, normal]) => ({ code, name, type, normal: normal || NORMAL[type] }));

  const freshState = () => ({
    settings: { mode: 'calendar', fyStart: 4, year: new Date().getFullYear() },
    accounts: defaultAccounts(),
    entries: [] // { id, kind: 'transaction'|'adjustment', date, desc, comment, lines: [{acct, debit, credit}] }
  });

  let state = loadState();

  // Local mode restores everything; database mode restores only the period
  // settings here (accounts and entries are fetched from Supabase on start).
  function loadState() {
    const s = freshState();
    try {
      const raw = JSON.parse(localStorage.getItem(useDB ? SETTINGS_KEY : STORE_KEY));
      if (useDB) { if (raw && raw.mode && raw.year) s.settings = raw; }
      else if (raw && raw.settings && Array.isArray(raw.accounts) && Array.isArray(raw.entries)) return raw;
    } catch (e) { /* ignore */ }
    return s;
  }
  function save() {
    try { localStorage.setItem(useDB ? SETTINGS_KEY : STORE_KEY, JSON.stringify(useDB ? state.settings : state)); }
    catch (e) { toast('Could not save to this browser (storage is full or blocked).', true); }
  }

  /* ---------- Data layer (Supabase) ----------
     Every method does nothing in local mode, so the rest of the app
     does not need to care which mode it is running in. */
  const unwrap = r => { if (r.error) throw r.error; return r.data; };
  const entryRow = e => ({ id: e.id, kind: e.kind, entry_date: e.date, description: e.desc, comment: e.comment || '' });
  const lineRows = e => e.lines.map((l, i) => ({ entry_id: e.id, line_no: i, acct_code: l.acct, debit: l.debit, credit: l.credit }));

  const store = {
    async load() {
      const accounts = unwrap(await sb.from('accounts').select('code,name,type,normal').order('code'));
      const rows = unwrap(await sb.from('entries')
        .select('id,kind,entry_date,description,comment,entry_lines(line_no,acct_code,debit,credit)')
        .order('entry_date'));
      return {
        accounts,
        entries: rows.map(r => ({
          id: r.id, kind: r.kind, date: r.entry_date, desc: r.description, comment: r.comment || '',
          lines: (r.entry_lines || []).slice().sort((a, b) => a.line_no - b.line_no)
            .map(l => ({ acct: l.acct_code, debit: Number(l.debit), credit: Number(l.credit) }))
        }))
      };
    },
    async addAccount(a) {
      if (useDB) unwrap(await sb.from('accounts').insert(a));
    },
    async removeAccount(code) {
      if (useDB) unwrap(await sb.from('accounts').delete().eq('code', code));
    },
    async addEntry(e) {
      if (!useDB) return;
      unwrap(await sb.from('entries').insert(entryRow(e)));
      const res = await sb.from('entry_lines').insert(lineRows(e));
      if (res.error) {
        await sb.from('entries').delete().eq('id', e.id); // undo the half-saved entry
        throw res.error;
      }
    },
    async removeEntry(id) {
      if (useDB) unwrap(await sb.from('entries').delete().eq('id', id)); // lines are removed by cascade
    },
    async replaceAll(accounts, entries) {
      if (!useDB) return;
      unwrap(await sb.from('entries').delete().not('id', 'is', null));
      unwrap(await sb.from('accounts').delete().not('code', 'is', null));
      unwrap(await sb.from('accounts').insert(accounts));
      if (entries.length) {
        unwrap(await sb.from('entries').insert(entries.map(entryRow)));
        unwrap(await sb.from('entry_lines').insert(entries.flatMap(lineRows)));
      }
    }
  };

  const fail = err => { console.error(err); toast('Database error: ' + ((err && err.message) || err), true); };

  // Runs a database action with the button disabled; returns true on success.
  async function guarded(btn, fn) {
    if (btn) btn.disabled = true;
    try { await fn(); return true; }
    catch (err) { fail(err); return false; }
    finally { if (btn) btn.disabled = false; }
  }

  function setDbStatus(kind, detail) {
    const el = $('#dbStatus');
    if (!el) return;
    const map = {
      loading: ['Connecting to Supabase…', 'loading'],
      ok: ['☁ Supabase connected', 'ok'],
      local: ['💾 Saving in this browser only (Supabase not set up)', 'local'],
      error: ['⚠ Supabase connection failed', 'error']
    };
    el.textContent = map[kind][0];
    el.className = 'db-status ' + map[kind][1];
    el.title = detail || '';
  }

  /* ---------- Accounting period (calendar or fiscal year) ---------- */
  function period() {
    const s = state.settings;
    const sm = s.mode === 'fiscal' ? Number(s.fyStart) : 1;
    const start = `${s.year}-${pad(sm)}-01`;
    const ey = s.year + (sm === 1 ? 0 : 1);
    const em = sm === 1 ? 12 : sm - 1;
    const last = new Date(Date.UTC(ey, em, 0)).getUTCDate();
    const end = `${ey}-${pad(em)}-${pad(last)}`;
    const label = s.mode === 'fiscal'
      ? `Fiscal year: ${fmtDate(start)} – ${fmtDate(end)}`
      : `Calendar year ${s.year}: ${fmtDate(start)} – ${fmtDate(end)}`;
    return { start, end, label };
  }
  const inPeriod = d => { const p = period(); return d >= p.start && d <= p.end; };
  const accountByCode = code => state.accounts.find(a => a.code === code);
  const usageCount = code => state.entries.reduce((n, e) => n + e.lines.filter(l => l.acct === code).length, 0);

  /* ---------- Period bar ---------- */
  function setupPeriodBar() {
    $('#pstart').innerHTML = MONTHS.map((m, i) => `<option value="${i + 1}">${m}</option>`).join('');
    $('#pmode').addEventListener('change', e => {
      state.settings.mode = e.target.value;
      save(); renderAll();
    });
    $('#pstart').addEventListener('change', e => {
      state.settings.fyStart = Number(e.target.value);
      save(); renderAll();
    });
    $('#pyear').addEventListener('change', e => {
      const y = Number(e.target.value);
      if (!Number.isInteger(y) || y < 2000 || y > 2100) {
        toast('Please enter a year between 2000 and 2100.', true);
        e.target.value = state.settings.year;
        return;
      }
      state.settings.year = y;
      save(); renderAll();
    });
  }
  function renderPeriodBar() {
    const s = state.settings;
    $('#pmode').value = s.mode;
    $('#pstart').value = s.fyStart;
    $('#pyear').value = s.year;
    $('#pstartWrap').hidden = s.mode !== 'fiscal';
    $('#pyearLabel').textContent = s.mode === 'fiscal' ? 'Year the fiscal year begins' : 'Year';
    $('#plabel').textContent = '📅 ' + period().label;
  }

  /* ---------- Tabs ---------- */
  function setupTabs() {
    $$('.tab').forEach(btn => btn.addEventListener('click', () => {
      $$('.tab').forEach(b => b.classList.toggle('active', b === btn));
      $$('.panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + btn.dataset.tab));
      if (btn.dataset.tab === 'trial') renderTrial();
      if (btn.dataset.tab === 'dashboard') renderDashboard();
    }));
  }

  /* =========================================================
     1. CHART OF ACCOUNTS
     ========================================================= */
  function setupAccounts() {
    const form = $('#accountForm');
    form.type.addEventListener('change', () => { form.normal.value = NORMAL[form.type.value]; });
    form.code.addEventListener('input', () => { form.code.value = form.code.value.replace(/\D/g, ''); });

    form.addEventListener('submit', async e => {
      e.preventDefault();
      $$('.invalid', form).forEach(x => x.classList.remove('invalid'));
      $$('.err', form).forEach(x => (x.textContent = ''));
      const code = form.code.value.trim();
      const name = form.name.value.trim().replace(/\s+/g, ' ');
      let ok = true;
      const fail = (el, msg) => { el.classList.add('invalid'); el.parentElement.querySelector('.err').textContent = msg; ok = false; };

      if (!/^\d{3,6}$/.test(code)) fail(form.code, 'Enter 3 to 6 digits.');
      else if (accountByCode(code)) fail(form.code, `Code ${code} is already used by "${accountByCode(code).name}".`);
      if (name.length < 2) fail(form.name, 'Name must be at least 2 characters.');
      else if (state.accounts.some(a => a.name.toLowerCase() === name.toLowerCase())) fail(form.name, 'An account with this name already exists.');
      if (!ok) { (form.querySelector('.invalid') || form.code).focus(); return; }

      const acc = { code, name, type: form.type.value, normal: form.normal.value };
      if (!(await guarded(form.querySelector('[type=submit]'), () => store.addAccount(acc)))) return;
      state.accounts.push(acc);
      save(); form.reset(); form.normal.value = NORMAL[form.type.value];
      renderAll(); toast(`Added account ${code} – ${name}`);
      form.code.focus();
    });

    $('#accFilter').addEventListener('change', renderAccounts);

    $('#accBody').addEventListener('click', async e => {
      const btn = e.target.closest('[data-del-acct]');
      if (!btn) return;
      const code = btn.dataset.delAcct;
      const acc = accountByCode(code);
      if (usageCount(code) > 0) {
        toast(`"${acc.name}" is used in ${usageCount(code)} journal line(s). Delete those entries first.`, true);
        return;
      }
      if (!confirm(`Remove account ${code} – ${acc.name}?`)) return;
      if (!(await guarded(btn, () => store.removeAccount(code)))) return;
      state.accounts = state.accounts.filter(a => a.code !== code);
      save(); renderAll(); toast('Account removed.');
    });
  }

  function renderAccounts() {
    const f = $('#accFilter').value;
    const list = state.accounts.filter(a => !f || a.type === f).sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
    $('#accCount').textContent = `${list.length} of ${state.accounts.length}`;
    $('#accBody').innerHTML = list.length ? list.map(a => {
      const n = usageCount(a.code);
      return `<tr>
        <td><strong>${esc(a.code)}</strong></td>
        <td>${esc(a.name)}</td>
        <td><span class="pill ${a.type}">${a.type}</span></td>
        <td>${a.normal}</td>
        <td class="num">${n ? n + ' line' + (n > 1 ? 's' : '') : '—'}</td>
        <td class="num"><button class="link-danger" data-del-acct="${esc(a.code)}" title="${n ? 'In use — cannot delete' : 'Remove this account'}">Remove</button></td>
      </tr>`;
    }).join('') : `<tr><td colspan="6" class="empty">No accounts to show. Add one using the form above.</td></tr>`;
  }

  /* =========================================================
     2 & 4. JOURNAL ENTRY FORMS (Transactions and Adjustments)
     ========================================================= */
  const KINDS = {
    transaction: { host: '#txFormHost', list: '#txList', count: '#txCount', noun: 'transaction', save: 'Save transaction' },
    adjustment: { host: '#adjFormHost', list: '#adjList', count: '#adjCount', noun: 'adjustment', save: 'Save adjustment' }
  };

  function acctOptions() {
    const sorted = [...state.accounts].sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
    return `<option value="">Choose account…</option>` + sorted.map(a => `<option value="${esc(a.code)}">${esc(a.code)} – ${esc(a.name)}</option>`).join('');
  }

  function lineHTML() {
    return `<div class="line-row">
      <select name="acct" aria-label="Account">${acctOptions()}</select>
      <input name="debit" class="amt" inputmode="decimal" placeholder="0.00" aria-label="Debit amount" autocomplete="off">
      <input name="credit" class="amt" inputmode="decimal" placeholder="0.00" aria-label="Credit amount" autocomplete="off">
      <button type="button" class="icon-btn" data-act="remove-line" title="Remove this line" aria-label="Remove line">✕</button>
    </div>`;
  }

  function formHTML(kind) {
    const adj = kind === 'adjustment';
    return `<form class="entry-form" data-kind="${kind}" novalidate>
      <div class="grid-2">
        <div class="field">
          <label for="${kind}-date">Date <span class="req">*</span></label>
          <input type="date" id="${kind}-date" name="date">
          <small class="hint">Must fall inside the accounting period.</small>
        </div>
        <div class="field">
          <label for="${kind}-desc">${adj ? 'Adjustment title' : 'Description'} <span class="req">*</span></label>
          <input type="text" id="${kind}-desc" name="desc" maxlength="80" autocomplete="off"
            placeholder="${adj ? 'e.g. Supplies used up this month' : 'e.g. Paid office rent for October'}">
          <small class="hint">${adj ? 'A short name for this adjustment.' : 'What happened? Keep it short and clear.'}</small>
        </div>
      </div>
      <div class="lines">
        <div class="line-head"><span>Account</span><span>Debit</span><span>Credit</span><span></span></div>
        <div class="line-rows"></div>
      </div>
      <div class="line-actions">
        <button type="button" class="btn ghost" data-act="add-line">+ Add another line</button>
        <div class="totals">
          <span>Total debit: <strong data-tot="d">0.00</strong></span>
          <span>Total credit: <strong data-tot="c">0.00</strong></span>
          <span class="badge" data-tot="status"></span>
        </div>
      </div>
      <div class="field">
        <label for="${kind}-comment">${adj ? 'Comment — why is this adjustment needed?' : 'Comment (optional)'} ${adj ? '<span class="req">*</span>' : ''}</label>
        <textarea id="${kind}-comment" name="comment" rows="2" maxlength="300"
          placeholder="${adj ? 'e.g. Physical count shows ₱500 of supplies were used.' : 'Add a note, receipt number, or reference if you like.'}"></textarea>
      </div>
      <ul class="form-errors" role="alert" hidden></ul>
      <div class="form-actions">
        <button type="submit" class="btn primary">${KINDS[kind].save}</button>
        <button type="button" class="btn ghost" data-act="clear">Clear form</button>
      </div>
    </form>`;
  }

  function setupEntryForms() {
    Object.keys(KINDS).forEach(kind => {
      $(KINDS[kind].host).innerHTML = formHTML(kind);
      resetForm(getForm(kind));
    });

    document.addEventListener('input', e => {
      const el = e.target;
      if (el.matches('.entry-form .amt')) {
        // allow only digits, commas and one decimal point (max 2 decimals)
        let v = el.value.replace(/[^\d.,]/g, '');
        const parts = v.split('.');
        if (parts.length > 1) v = parts[0] + '.' + parts.slice(1).join('').slice(0, 2);
        el.value = v;
        // a line can be either a debit or a credit, not both
        if (v) {
          const other = el.name === 'debit' ? el.closest('.line-row').querySelector('[name=credit]') : el.closest('.line-row').querySelector('[name=debit]');
          if (other.value) { other.value = ''; other.classList.add('flash'); setTimeout(() => other.classList.remove('flash'), 600); }
        }
      }
      if (el.closest('.entry-form')) {
        el.classList.remove('invalid');
        updateTotals(el.closest('.entry-form'));
      }
    });

    // Tidy up amounts when leaving a field (1500 -> 1,500.00)
    document.addEventListener('focusout', e => {
      const el = e.target;
      if (!el.matches('.entry-form .amt') || !el.value) return;
      const n = parseAmt(el.value);
      el.value = Number.isNaN(n) || n <= 0 ? '' : money(n);
      updateTotals(el.closest('.entry-form'));
    });

    document.addEventListener('click', e => {
      const btn = e.target.closest('.entry-form [data-act]');
      if (!btn) return;
      const form = btn.closest('.entry-form');
      const act = btn.dataset.act;
      if (act === 'add-line') {
        form.querySelector('.line-rows').insertAdjacentHTML('beforeend', lineHTML());
        form.querySelector('.line-rows .line-row:last-child select').focus();
      } else if (act === 'remove-line') {
        if ($$('.line-row', form).length <= 2) { toast('An entry needs at least two lines.', true); return; }
        btn.closest('.line-row').remove();
        updateTotals(form);
      } else if (act === 'clear') {
        resetForm(form);
      }
    });

    document.addEventListener('submit', e => {
      const form = e.target.closest('.entry-form');
      if (!form) return;
      e.preventDefault();
      submitEntry(form);
    });
  }

  const getForm = kind => $(`.entry-form[data-kind="${kind}"]`);

  function resetForm(form, keepDate) {
    const date = form.date.value;
    form.reset();
    $$('.invalid', form).forEach(x => x.classList.remove('invalid'));
    form.querySelector('.line-rows').innerHTML = lineHTML() + lineHTML();
    const errs = form.querySelector('.form-errors'); errs.hidden = true; errs.innerHTML = '';
    setFormDate(form, keepDate ? date : '');
    updateTotals(form);
  }

  function setFormDate(form, preferred) {
    const p = period();
    form.date.min = p.start; form.date.max = p.end;
    let v = preferred || form.date.value;
    if (!v || v < p.start || v > p.end) { const t = todayISO(); v = t >= p.start && t <= p.end ? t : p.start; }
    form.date.value = v;
  }

  function updateTotals(form) {
    let d = 0, c = 0;
    $$('.line-row', form).forEach(r => {
      const dv = parseAmt(r.querySelector('[name=debit]').value);
      const cv = parseAmt(r.querySelector('[name=credit]').value);
      if (dv > 0) d += dv;
      if (cv > 0) c += cv;
    });
    d = round2(d); c = round2(c);
    $('[data-tot=d]', form).textContent = money(d);
    $('[data-tot=c]', form).textContent = money(c);
    const s = $('[data-tot=status]', form);
    if (!d && !c) { s.textContent = 'Enter amounts to begin'; s.style.color = 'var(--muted)'; }
    else if (d === c) { s.textContent = '✓ Balanced'; s.style.color = 'var(--ok)'; }
    else { s.textContent = `✕ Out of balance by ${money(Math.abs(d - c))}`; s.style.color = 'var(--bad)'; }
  }

  async function submitEntry(form) {
    const kind = form.dataset.kind;
    const adj = kind === 'adjustment';
    const errors = [];
    $$('.invalid', form).forEach(x => x.classList.remove('invalid'));
    const bad = (el, msg) => { if (el) el.classList.add('invalid'); errors.push({ el, msg }); };

    // date
    const date = form.date.value;
    const p = period();
    if (!date) bad(form.date, 'Choose a date.');
    else if (date < p.start || date > p.end) bad(form.date, `The date must be between ${fmtDate(p.start)} and ${fmtDate(p.end)} (your selected accounting period).`);

    // description & comment
    const desc = form.desc.value.trim().replace(/\s+/g, ' ');
    const comment = form.comment.value.trim();
    if (desc.length < 3) bad(form.desc, adj ? 'Give the adjustment a title (at least 3 characters).' : 'Add a description (at least 3 characters).');
    if (adj && comment.length < 5) bad(form.comment, 'Adjustments need a comment explaining why (at least 5 characters).');

    // lines
    const lines = [];
    $$('.line-row', form).forEach((row, i) => {
      const sel = row.querySelector('[name=acct]');
      const dEl = row.querySelector('[name=debit]');
      const cEl = row.querySelector('[name=credit]');
      const hasAny = sel.value || dEl.value.trim() || cEl.value.trim();
      if (!hasAny) return; // ignore blank lines
      const n = i + 1;
      const d = parseAmt(dEl.value), c = parseAmt(cEl.value);
      if (!sel.value) bad(sel, `Line ${n}: choose an account.`);
      if (Number.isNaN(d) || Number.isNaN(c)) { bad(Number.isNaN(d) ? dEl : cEl, `Line ${n}: the amount is not a valid number.`); return; }
      if (d > 0 && c > 0) bad(dEl, `Line ${n}: use either Debit or Credit, not both.`);
      else if (d <= 0 && c <= 0) bad(dEl, `Line ${n}: enter an amount greater than zero.`);
      else if (Math.max(d, c) > 999999999999) bad(dEl, `Line ${n}: the amount is too large.`);
      lines.push({ acct: sel.value, debit: round2(Math.max(d, 0)), credit: round2(Math.max(c, 0)) });
    });

    if (lines.length < 2) bad(null, 'Enter at least two lines (for example, one debit and one credit).');
    const totalD = round2(lines.reduce((s, l) => s + l.debit, 0));
    const totalC = round2(lines.reduce((s, l) => s + l.credit, 0));
    if (lines.length >= 2) {
      if (totalD === 0 || totalC === 0) bad(null, 'An entry needs at least one debit and one credit.');
      else if (totalD !== totalC) bad(null, `Debits (${money(totalD)}) and credits (${money(totalC)}) must be equal. Difference: ${money(Math.abs(totalD - totalC))}.`);
    }

    const box = form.querySelector('.form-errors');
    if (errors.length) {
      box.innerHTML = errors.map(x => `<li>${esc(x.msg)}</li>`).join('');
      box.hidden = false;
      const first = errors.find(x => x.el);
      if (first) first.el.focus();
      return;
    }
    box.hidden = true;

    const entry = { id: uid(), kind, date, desc, comment, lines };
    if (!(await guarded(form.querySelector('[type=submit]'), () => store.addEntry(entry)))) return;
    state.entries.push(entry);
    save();
    resetForm(form, true);
    renderAll();
    toast(`${adj ? 'Adjustment' : 'Transaction'} saved. The trial balance has been updated.`);
  }

  /* ---------- Entry lists ---------- */
  function renderEntryList(kind) {
    const cfg = KINDS[kind];
    const all = state.entries.filter(e => e.kind === kind);
    const inP = all.filter(e => inPeriod(e.date)).sort((a, b) => a.date.localeCompare(b.date));
    const outside = all.length - inP.length;
    $(cfg.count).textContent = inP.length;

    let html = inP.length ? inP.map(e => {
      const rows = [...e.lines].sort((a, b) => (b.debit > 0) - (a.debit > 0)).map(l => {
        const a = accountByCode(l.acct);
        const nm = a ? `${esc(a.code)} – ${esc(a.name)}` : `${esc(l.acct)} (removed account)`;
        return `<tr><td class="${l.credit > 0 ? 'indent' : ''}">${nm}</td><td class="num">${l.debit ? money(l.debit) : ''}</td><td class="num">${l.credit ? money(l.credit) : ''}</td></tr>`;
      }).join('');
      const total = money(e.lines.reduce((s, l) => s + l.debit, 0));
      return `<div class="entry">
        <div class="entry-top">
          <div><div class="entry-title">${esc(e.desc)}</div><div class="entry-date">${fmtDate(e.date)} · Total ${total}</div></div>
          <button class="link-danger" data-del-entry="${e.id}">Delete</button>
        </div>
        <table><thead><tr><th>Account</th><th class="num">Debit</th><th class="num">Credit</th></tr></thead><tbody>${rows}</tbody></table>
        ${e.comment ? `<div class="entry-comment"><strong>Comment:</strong> ${esc(e.comment)}</div>` : ''}
      </div>`;
    }).join('') : `<div class="empty">No ${cfg.noun}s in this period yet. Use the form above to add your first one.</div>`;

    if (outside) html += `<div class="outside-note">${outside} ${cfg.noun}${outside > 1 ? 's are' : ' is'} outside the selected period and hidden. Change the period to see ${outside > 1 ? 'them' : 'it'}.</div>`;
    $(cfg.list).innerHTML = html;
  }

  function setupEntryLists() {
    document.addEventListener('click', async e => {
      const btn = e.target.closest('[data-del-entry]');
      if (!btn) return;
      const entry = state.entries.find(x => x.id === btn.dataset.delEntry);
      if (!entry || !confirm(`Delete "${entry.desc}"? This cannot be undone.`)) return;
      if (!(await guarded(btn, () => store.removeEntry(entry.id)))) return;
      state.entries = state.entries.filter(x => x.id !== entry.id);
      save(); renderAll(); toast('Entry deleted.');
    });
  }

  /* =========================================================
     3. TRIAL BALANCE (calculates automatically on every change)
     ========================================================= */
  function computeTrial() {
    const rows = new Map(state.accounts.map(a => [a.code, { a, ud: 0, uc: 0, ad: 0, ac: 0, used: false }]));
    state.entries.filter(e => inPeriod(e.date)).forEach(e => {
      e.lines.forEach(l => {
        const r = rows.get(l.acct);
        if (!r) return;
        r.used = true;
        if (e.kind === 'adjustment') { r.ad += l.debit; r.ac += l.credit; }
        else { r.ud += l.debit; r.uc += l.credit; }
      });
    });
    return [...rows.values()].sort((a, b) => a.a.code.localeCompare(b.a.code, undefined, { numeric: true }));
  }

  const side = net => ({ d: net > 0 ? round2(net) : 0, c: net < 0 ? round2(-net) : 0 });
  const cell = n => (n ? money(n) : '');

  function renderTrial() {
    const showAll = $('#tbAll').checked;
    const data = computeTrial();
    const t = { ud: 0, uc: 0, ad: 0, ac: 0, jd: 0, jc: 0 };
    let html = '';
    data.forEach(r => {
      if (!showAll && !r.used) return;
      const u = side(round2(r.ud - r.uc));
      const j = side(round2(r.ud + r.ad - r.uc - r.ac));
      t.ud += u.d; t.uc += u.c; t.ad += r.ad; t.ac += r.ac; t.jd += j.d; t.jc += j.c;
      html += `<tr>
        <td>${esc(r.a.code)}</td><td>${esc(r.a.name)}</td>
        <td class="num">${cell(u.d)}</td><td class="num">${cell(u.c)}</td>
        <td class="num">${cell(round2(r.ad))}</td><td class="num">${cell(round2(r.ac))}</td>
        <td class="num">${cell(j.d)}</td><td class="num">${cell(j.c)}</td>
      </tr>`;
    });
    Object.keys(t).forEach(k => (t[k] = round2(t[k])));

    $('#tbBody').innerHTML = html || `<tr><td colspan="8" class="empty">Nothing to show yet. Record a transaction and the trial balance will appear here automatically.</td></tr>`;
    $('#tbFoot').innerHTML = html ? `<tr><td colspan="2">TOTAL</td>
      <td class="num">${money(t.ud)}</td><td class="num">${money(t.uc)}</td>
      <td class="num">${money(t.ad)}</td><td class="num">${money(t.ac)}</td>
      <td class="num">${money(t.jd)}</td><td class="num">${money(t.jc)}</td></tr>` : '';

    const s = $('#tbStatus');
    if (!html) { s.className = 'tb-status neutral'; s.textContent = 'No activity in this period yet.'; }
    else if (t.jd === t.jc && t.ud === t.uc) { s.className = 'tb-status ok'; s.textContent = `✓ The trial balance is balanced (adjusted total: ${money(t.jd)}).`; }
    else { s.className = 'tb-status bad'; s.textContent = `✕ Out of balance. Unadjusted difference: ${money(Math.abs(t.ud - t.uc))}; adjusted difference: ${money(Math.abs(t.jd - t.jc))}. Check your entries.`; }

    // adjustment comments
    const adjs = state.entries.filter(e => e.kind === 'adjustment' && inPeriod(e.date)).sort((a, b) => a.date.localeCompare(b.date));
    $('#tbComments').innerHTML = adjs.length ? adjs.map(e => `<div class="comment-item">
        <strong>${esc(e.desc)}</strong> <span class="muted">· ${fmtDate(e.date)} · ${money(e.lines.reduce((s, l) => s + l.debit, 0))}</span>
        <div>${esc(e.comment)}</div></div>`).join('')
      : `<p class="muted">No adjustments in this period.</p>`;
  }

  /* =========================================================
     Sample data, reset, guide
     ========================================================= */
  async function loadSample() {
    if (state.entries.length && !confirm('This will replace your current accounts and entries with sample data. Continue?')) return;
    const next = freshState();
    next.settings = state.settings;
    const p = period();
    const T = (n, desc, lines, kind = 'transaction', comment = '') =>
      next.entries.push({ id: uid(), kind, date: addDays(p.start, n), desc, comment, lines: lines.map(([acct, debit, credit]) => ({ acct, debit, credit })) });
    T(1, 'Owner invested cash to start the business', [['1000', 50000, 0], ['3000', 0, 50000]]);
    T(3, 'Bought equipment for cash', [['1500', 12000, 0], ['1000', 0, 12000]]);
    T(5, 'Bought supplies on account', [['1200', 800, 0], ['2000', 0, 800]]);
    T(12, 'Earned service revenue (cash)', [['1000', 9500, 0], ['4000', 0, 9500]]);
    T(14, 'Paid monthly rent', [['5100', 2000, 0], ['1000', 0, 2000]]);
    T(33, 'Billed a customer on account', [['1100', 3200, 0], ['4000', 0, 3200]]);
    T(40, 'Paid monthly rent', [['5100', 2000, 0], ['1000', 0, 2000]]);
    T(45, 'Earned service revenue (cash)', [['1000', 7200, 0], ['4000', 0, 7200]]);
    T(55, 'Paid utilities', [['5200', 650, 0], ['1000', 0, 650]]);
    T(64, 'Paid staff salaries', [['5000', 4500, 0], ['1000', 0, 4500]]);
    T(75, 'Earned service revenue (cash)', [['1000', 11800, 0], ['4000', 0, 11800]]);
    T(80, 'Paid monthly rent', [['5100', 2000, 0], ['1000', 0, 2000]]);
    T(92, 'Customer paid the amount billed earlier', [['1000', 3200, 0], ['1100', 0, 3200]]);
    T(105, 'Earned service revenue (cash)', [['1000', 8900, 0], ['4000', 0, 8900]]);
    T(110, 'Paid insurance in advance', [['1300', 2400, 0], ['1000', 0, 2400]]);
    T(120, 'Paid staff salaries', [['5000', 4500, 0], ['1000', 0, 4500]]);
    T(135, 'Earned service revenue (cash)', [['1000', 13500, 0], ['4000', 0, 13500]]);
    T(140, 'Paid utilities', [['5200', 720, 0], ['1000', 0, 720]]);
    T(150, 'Paid monthly rent', [['5100', 2000, 0], ['1000', 0, 2000]]);
    T(150, 'Supplies used', [['5300', 500, 0], ['1200', 0, 500]], 'adjustment', 'Physical count shows 500 of supplies were used up during the period.');
    T(150, 'Record depreciation on equipment', [['5500', 200, 0], ['1590', 0, 200]], 'adjustment', 'Equipment depreciates evenly over its useful life; this is the amount for the period.');
    T(150, 'Insurance used up', [['5400', 400, 0], ['1300', 0, 400]], 'adjustment', 'Part of the prepaid insurance has expired and is now an expense.');
    if (!(await guarded($('#btnSample'), () => store.replaceAll(next.accounts, next.entries)))) return;
    state = next;
    save(); renderAll(); toast('Sample data loaded. Open the Trial Balance tab to see the result.');
  }

  function setupHeader() {
    $('#btnSample').addEventListener('click', loadSample);
    $('#btnReset').addEventListener('click', async () => {
      if (!confirm('Delete ALL accounts, transactions and adjustments and start over?')) return;
      const fresh = freshState();
      if (!(await guarded($('#btnReset'), () => store.replaceAll(fresh.accounts, [])))) return;
      state = fresh; save(); renderAll(); toast('Everything was reset.');
    });
    $('#btnPrint').addEventListener('click', () => window.print());
    $('#tbAll').addEventListener('change', renderTrial);

    const guide = $('#guide');
    try { if (localStorage.getItem(GUIDE_KEY)) guide.hidden = true; } catch (e) { /* ignore */ }
    $('#guideClose').addEventListener('click', () => {
      guide.hidden = true;
      try { localStorage.setItem(GUIDE_KEY, '1'); } catch (e) { /* ignore */ }
    });
  }

  /* =========================================================
     5. DASHBOARD
     Every figure is computed from the same entries as the Trial Balance,
     so the two always agree. Charts are plain SVG (no chart library).
     ========================================================= */
  const CUR = '₱';
  const DASH = { basis: 'adjusted', view: {}, defs: [] };
  const f = n => +Number(n).toFixed(1);
  const fmtCur = n => (n < 0 ? '−' : '') + CUR + money(Math.abs(n));
  const pct = (a, b) => (b ? (a / b * 100).toLocaleString('en-US', { maximumFractionDigits: 1 }) + '%' : '—');
  const PLURAL = { Asset: 'Assets', Liability: 'Liabilities', Equity: 'Equity', Revenue: 'Revenue', Expense: 'Expenses' };

  function compactNum(v) {
    const a = Math.abs(v), s = v < 0 ? '−' : '';
    if (a >= 1e9) return s + +(a / 1e9).toFixed(1) + 'B';
    if (a >= 1e6) return s + +(a / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return s + +(a / 1e3).toFixed(1) + 'K';
    return s + a;
  }
  const axisFmt = (v, compact) => (compact ? compactNum(v) : Math.round(v).toLocaleString('en-US'));

  // Clean axis: round numbers that always include zero
  function niceRange(min, max, n = 4) {
    min = Math.min(0, min); max = Math.max(0, max);
    if (max - min < 4) max = min + 4;
    const raw = (max - min) / n, mag = Math.pow(10, Math.floor(Math.log10(raw))), r = raw / mag;
    const step = (r <= 1 ? 1 : r <= 2 ? 2 : r <= 5 ? 5 : 10) * mag;
    const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step, ticks = [];
    for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 100) / 100);
    return { lo, hi, ticks };
  }

  // Bars: 4px rounded data-end, square at the baseline
  function barTop(x, y, w, h, r) {
    if (h <= 0) return '';
    r = Math.min(r, w / 2, h);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }
  function barRight(x, y, w, h, r) {
    r = Math.min(r, h / 2, w);
    return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
  }
  const svgOpen = (w, h, label) => `<svg class="viz-svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}">`;

  /* ---------- Numbers behind the dashboard ---------- */
  function dashData() {
    const adjusted = DASH.basis === 'adjusted';
    const p = period();
    const months = [];
    let [y, m] = p.start.split('-').map(Number);
    for (let i = 0; i < 12; i++) {
      months.push({ key: `${y}-${pad(m)}`, short: MONTHS[m - 1].slice(0, 3), full: `${MONTHS[m - 1]} ${y}` });
      if (++m > 12) { m = 1; y++; }
    }
    const rows = new Map(state.accounts.map(a => [a.code, { a, ud: 0, uc: 0, ad: 0, ac: 0, used: false, month: new Array(12).fill(0) }]));
    const entries = state.entries.filter(e => inPeriod(e.date));
    let lastIdx = -1;
    entries.forEach(e => {
      const mi = months.findIndex(x => x.key === e.date.slice(0, 7));
      if (mi < 0) return;
      if (mi > lastIdx) lastIdx = mi;
      e.lines.forEach(l => {
        const r = rows.get(l.acct);
        if (!r) return;
        r.used = true;
        if (e.kind === 'adjustment') { r.ad += l.debit; r.ac += l.credit; } else { r.ud += l.debit; r.uc += l.credit; }
        if (adjusted || e.kind !== 'adjustment') r.month[mi] += l.debit - l.credit;
      });
    });

    // value = balance on the account's natural side (assets & expenses: debit; the rest: credit)
    const sgn = t => (t === 'Asset' || t === 'Expense' ? 1 : -1);
    const list = [...rows.values()].filter(r => r.used).map(r => {
      const dr = round2(r.ud + (adjusted ? r.ad : 0)), cr = round2(r.uc + (adjusted ? r.ac : 0)), s = sgn(r.a.type);
      return { ...r, dr, cr, value: round2(s * (dr - cr)), before: round2(s * (r.ud - r.uc)), adjEffect: round2(s * (r.ad - r.ac)), series: r.month.map(v => round2(s * v)) };
    }).sort((a, b) => a.a.code.localeCompare(b.a.code, undefined, { numeric: true }));

    const sum = t => round2(list.filter(r => r.a.type === t).reduce((s, r) => s + r.value, 0));
    const tot = { Asset: sum('Asset'), Liability: sum('Liability'), Equity: sum('Equity'), Revenue: sum('Revenue'), Expense: sum('Expense') };
    const net = round2(tot.Revenue - tot.Expense);
    const equityTotal = round2(tot.Equity + net);
    const monthly = t => months.map((_, i) => round2(list.filter(r => r.a.type === t).reduce((s, r) => s + r.series[i], 0)));
    const rev = monthly('Revenue'), exp = monthly('Expense');
    const cumulative = arr => { let c = 0; return arr.map(v => (c = round2(c + v))); };
    const cashRow = list.find(r => r.a.type === 'Asset' && /^cash\b/i.test(r.a.name));
    const items = t => list.filter(r => r.a.type === t && r.value > 0).map(r => ({ name: r.a.name, value: r.value })).sort((a, b) => b.value - a.value);

    // Trial balance status (same rule as the Trial Balance tab)
    let ud = 0, uc = 0, jd = 0, jc = 0;
    list.forEach(r => {
      const u = side(round2(r.ud - r.uc)), j = side(round2(r.ud + r.ad - r.uc - r.ac));
      ud += u.d; uc += u.c; jd += j.d; jc += j.c;
    });
    const tb = { ud: round2(ud), uc: round2(uc), jd: round2(jd), jc: round2(jc) };
    tb.balanced = tb.ud === tb.uc && tb.jd === tb.jc;

    return {
      adjusted, months, lastIdx, entries, list, tot, net, equityTotal, rev, exp,
      netM: rev.map((v, i) => round2(v - exp[i])), cumNet: cumulative(rev.map((v, i) => v - exp[i])),
      cash: cashRow, cashCum: cashRow ? cumulative(cashRow.series) : null,
      revItems: items('Revenue'), expItems: items('Expense'), tb,
      eqDiff: round2(tot.Asset - (tot.Liability + equityTotal)),
      txCount: entries.filter(e => e.kind === 'transaction').length,
      adjCount: entries.filter(e => e.kind === 'adjustment').length,
      latest: entries.reduce((mx, e) => (e.date > mx ? e.date : mx), '')
    };
  }

  /* ---------- Tooltip (one tooltip, built with textContent) ---------- */
  function tipEl() {
    let t = $('#vizTip');
    if (!t) { t = document.createElement('div'); t.id = 'vizTip'; t.setAttribute('role', 'tooltip'); document.body.appendChild(t); }
    return t;
  }
  function showTip(data, x, y) {
    const t = tipEl();
    t.textContent = '';
    const h = document.createElement('div'); h.className = 'tip-title'; h.textContent = data.title; t.appendChild(h);
    data.rows.forEach(r => {
      const row = document.createElement('div'); row.className = 'tip-row';
      const key = document.createElement('span'); key.className = 'tip-key';
      if (r.color) key.style.background = r.color;
      const val = document.createElement('strong'); val.textContent = r.value;
      const nm = document.createElement('span'); nm.className = 'tip-name'; nm.textContent = r.name;
      row.append(key, val, nm); t.appendChild(row);
    });
    t.classList.add('show');
    const w = t.offsetWidth, hh = t.offsetHeight;
    let left = x + 14, top = y - hh - 12;
    if (left + w > window.innerWidth - 8) left = x - w - 14;
    if (left < 8) left = 8;
    if (top < 8) top = y + 18;
    t.style.left = left + 'px'; t.style.top = top + 'px';
  }
  function hideTip() { const t = $('#vizTip'); if (t) t.classList.remove('show'); }

  // Each .hit rect carries data-i; marks sharing data-b="i" light up together
  function attachHover(body, tips) {
    $$('.hit', body).forEach(el => {
      const i = Number(el.dataset.i);
      const mark = on => $$(`[data-b="${i}"]`, body).forEach(m => m.classList.toggle('is-on', on));
      const show = (x, y) => { if (tips[i]) { showTip(tips[i], x, y); mark(true); } };
      el.addEventListener('pointerenter', e => show(e.clientX, e.clientY));
      el.addEventListener('pointermove', e => show(e.clientX, e.clientY));
      el.addEventListener('pointerleave', () => { hideTip(); mark(false); });
      el.addEventListener('focus', () => { const b = el.getBoundingClientRect(); show(b.left + b.width / 2, b.top + Math.min(40, b.height / 2)); });
      el.addEventListener('blur', () => { hideTip(); mark(false); });
    });
  }

  /* ---------- Chart definitions ---------- */
  function monthlyDef(d) {
    const { rev, exp } = d;
    return {
      id: 'monthly', wide: true, title: 'Revenue and expenses by month', sub: 'What the business earned and what it spent in each month',
      legend: [{ cls: 's1', name: 'Revenue' }, { cls: 's2', name: 'Expenses' }],
      table: {
        head: ['Month', 'Revenue', 'Expenses', 'Net income'],
        rows: d.months.map((m, i) => [m.full, fmtCur(rev[i]), fmtCur(exp[i]), fmtCur(round2(rev[i] - exp[i]))])
          .concat([['Total', fmtCur(d.tot.Revenue), fmtCur(d.tot.Expense), fmtCur(d.net)]])
      },
      build(w) {
        const H = 300, L = 54, R = 10, T = 26, B = 30, pw = w - L - R, ph = H - T - B;
        const sc = niceRange(0, Math.max(0, ...rev, ...exp)), compact = sc.hi >= 10000;
        const y = v => f(T + ph - (v - sc.lo) / (sc.hi - sc.lo) * ph);
        const band = pw / 12, bw = Math.max(4, Math.min(24, (band - 8) / 2 - 1)), gw = bw * 2 + 2;
        let s = svgOpen(w, H, 'Revenue and expenses by month');
        sc.ticks.forEach(t => {
          s += `<line class="grid" x1="${L}" x2="${w - R}" y1="${y(t)}" y2="${y(t)}"/>`;
          s += `<text class="axis" x="${L - 8}" y="${y(t) + 4}" text-anchor="end">${axisFmt(t, compact)}</text>`;
        });
        s += `<line class="base" x1="${L}" x2="${w - R}" y1="${y(0)}" y2="${y(0)}"/>`;
        let peak = null;
        d.months.forEach((m, i) => {
          const gx = L + i * band + (band - gw) / 2;
          [[rev[i], 'b1', gx], [exp[i], 'b2', gx + bw + 2]].forEach(([v, cls, bx]) => {
            if (v <= 0) return;
            s += `<path class="bar ${cls}" data-b="${i}" d="${barTop(f(bx), y(v), bw, f(y(0) - y(v)), 4)}"/>`;
            if (!peak || v > peak.v) peak = { v, x: bx + bw / 2, yy: y(v) };
          });
          if (band >= 34 || i % 2 === 0) s += `<text class="axis" x="${f(L + (i + .5) * band)}" y="${H - 9}" text-anchor="middle">${m.short}</text>`;
        });
        if (peak) {
          const px = Math.min(Math.max(peak.x, L + 34), w - R - 34);
          s += `<text class="vlabel" x="${f(px)}" y="${f(peak.yy - 7)}" text-anchor="middle">${CUR}${money(peak.v)}</text>`;
        }
        const tips = d.months.map((m, i) => ({
          title: m.full,
          rows: [{ color: 'var(--viz-1)', name: 'Revenue', value: fmtCur(rev[i]) }, { color: 'var(--viz-2)', name: 'Expenses', value: fmtCur(exp[i]) },
            { name: 'Net income', value: fmtCur(round2(rev[i] - exp[i])) }]
        }));
        d.months.forEach((m, i) => {
          s += `<rect class="hit" data-i="${i}" tabindex="0" x="${f(L + i * band)}" y="${T}" width="${f(band)}" height="${ph}" aria-label="${esc(m.full)}: revenue ${fmtCur(rev[i])}, expenses ${fmtCur(exp[i])}"/>`;
        });
        return { svg: s + '</svg>', tips };
      }
    };
  }

  function lineDef(d, id, title, sub, name, series) {
    return {
      id, wide: false, title, sub, legend: null,
      table: {
        head: ['Month', name, 'Change in month'],
        rows: d.months.map((m, i) => (i > d.lastIdx ? [m.full, '—', '—'] : [m.full, fmtCur(series[i]), fmtCur(round2(series[i] - (i ? series[i - 1] : 0)))]))
      },
      build(w) {
        const H = 260, L = 54, R = 14, T = 28, B = 30, pw = w - L - R, ph = H - T - B, n = d.lastIdx + 1;
        const vals = series.slice(0, n);
        const sc = niceRange(Math.min(0, ...vals), Math.max(0, ...vals));
        const compact = Math.max(Math.abs(sc.lo), Math.abs(sc.hi)) >= 10000;
        const y = v => f(T + ph - (v - sc.lo) / (sc.hi - sc.lo) * ph);
        const band = pw / 12, x = i => f(L + (i + .5) * band);
        let s = svgOpen(w, H, `${title}, ${period().label}`);
        sc.ticks.forEach(t => {
          s += `<line class="grid" x1="${L}" x2="${w - R}" y1="${y(t)}" y2="${y(t)}"/>`;
          s += `<text class="axis" x="${L - 8}" y="${y(t) + 4}" text-anchor="end">${axisFmt(t, compact)}</text>`;
        });
        s += `<line class="base" x1="${L}" x2="${w - R}" y1="${y(0)}" y2="${y(0)}"/>`;
        d.months.forEach((m, i) => { if (band >= 34 || i % 2 === 0) s += `<text class="axis" x="${x(i)}" y="${H - 9}" text-anchor="middle">${m.short}</text>`; });
        if (n > 1) {
          const pts = vals.map((v, i) => `${x(i)},${y(v)}`);
          s += `<path d="M${x(0)},${y(0)} L${pts.join(' L')} L${x(n - 1)},${y(0)} Z" fill="var(--viz-3)" opacity=".10"/>`;
          s += `<polyline class="line" points="${pts.join(' ')}"/>`;
        }
        vals.forEach((v, i) => {
          s += `<line class="xh" data-b="${i}" x1="${x(i)}" x2="${x(i)}" y1="${T}" y2="${T + ph}"/>`;
          s += `<circle class="hdot" data-b="${i}" cx="${x(i)}" cy="${y(v)}" r="4"/>`;
        });
        const last = vals[n - 1];
        s += `<circle class="enddot" cx="${x(n - 1)}" cy="${y(last)}" r="4"/>`;
        s += `<text class="vlabel" x="${x(n - 1)}" y="${f(y(last) - 11)}" text-anchor="${n > 1 ? 'end' : 'middle'}">${fmtCur(last)}</text>`;
        const tips = vals.map((v, i) => ({
          title: d.months[i].full,
          rows: [{ color: 'var(--viz-3)', name: name, value: fmtCur(v) }, { name: 'Change this month', value: fmtCur(round2(v - (i ? vals[i - 1] : 0))) }]
        }));
        vals.forEach((v, i) => {
          s += `<rect class="hit" data-i="${i}" tabindex="0" x="${f(L + i * band)}" y="${T}" width="${f(band)}" height="${ph}" aria-label="${esc(d.months[i].full)}: ${esc(name)} ${fmtCur(v)}"/>`;
        });
        return { svg: s + '</svg>', tips };
      }
    };
  }

  function foldTop(items, n) {
    if (items.length <= n) return items;
    const rest = items.slice(n - 1);
    return items.slice(0, n - 1).concat([{ name: `Other (${rest.length} accounts)`, value: round2(rest.reduce((s, i) => s + i.value, 0)) }]);
  }

  function rankedDef(id, title, sub, all, color, noun) {
    const items = foldTop(all, 8), total = round2(all.reduce((s, i) => s + i.value, 0));
    return {
      id, wide: false, title, sub, legend: null,
      table: { head: ['Account', 'Amount', 'Share'], rows: all.map(i => [i.name, fmtCur(i.value), pct(i.value, total)]).concat(all.length ? [['Total', fmtCur(total), '100%']] : []) },
      build(w) {
        if (!items.length) return { svg: `<p class="viz-note">No ${noun} recorded in this period yet.</p>`, tips: [] };
        if (items.length === 1) return { svg: `<p class="viz-note">All ${noun} comes from one account: <strong>${esc(items[0].name)}</strong> (${fmtCur(items[0].value)}). A comparison needs at least two accounts.</p>`, tips: [] };
        const rowH = 34, T = 4, H = items.length * rowH + T * 2;
        const labelW = Math.min(180, Math.max(90, Math.max(...items.map(i => Math.min(i.name.length, 26))) * 6.6));
        const x0 = labelW + 10, maxW = Math.max(40, w - x0 - 100), mx = Math.max(...items.map(i => i.value));
        let s = svgOpen(w, H, title);
        items.forEach((it, i) => {
          const cy = T + i * rowH + rowH / 2, bw = Math.max(2, it.value / mx * maxW);
          const nm = it.name.length > 26 ? it.name.slice(0, 25) + '…' : it.name;
          s += `<text class="catlabel" x="${f(labelW)}" y="${f(cy + 4)}" text-anchor="end">${esc(nm)}</text>`;
          s += `<path class="bar" data-b="${i}" style="fill:${color}" d="${barRight(f(x0), f(cy - 9), f(bw), 18, 4)}"/>`;
          s += `<text class="vlabel" x="${f(x0 + bw + 8)}" y="${f(cy + 4)}">${fmtCur(it.value)}</text>`;
          s += `<rect class="hit" data-i="${i}" tabindex="0" x="0" y="${T + i * rowH}" width="${w}" height="${rowH}" aria-label="${esc(it.name)}: ${fmtCur(it.value)}"/>`;
        });
        const tips = items.map(it => ({ title: it.name, rows: [{ color, name: 'Amount', value: fmtCur(it.value) }, { name: 'Share of total', value: pct(it.value, total) }] }));
        return { svg: s + '</svg>', tips };
      }
    };
  }

  function chartDefs(d) {
    const defs = [monthlyDef(d)];
    if (d.cash) defs.push(lineDef(d, 'cash', 'Cash balance by month', 'Running balance of your cash account at the end of each month', 'Cash balance', d.cashCum));
    defs.push(lineDef(d, 'cum', 'Cumulative net income', 'Profit (or loss) built up month by month', 'Cumulative net income', d.cumNet));
    defs.push(rankedDef('revenue', 'Revenue by account', 'Where the money comes from', d.revItems, 'var(--viz-1)', 'revenue'));
    defs.push(rankedDef('expenses', 'Expenses by account', 'Where the money goes', d.expItems, 'var(--viz-2)', 'expenses'));
    return defs;
  }

  /* ---------- Page pieces ---------- */
  function spark(vals, upTo, color) {
    const v = vals.slice(0, upTo + 1), n = v.length;
    if (n < 2) return '';
    const w = 84, h = 26, pd = 3, mn = Math.min(...v), mx = Math.max(...v), span = mx - mn || 1;
    const pts = v.map((val, i) => [f(pd + i * (w - 2 * pd) / (n - 1)), f(h - pd - (val - mn) / span * (h - 2 * pd))]);
    const l = pts[n - 1];
    return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline points="${pts.map(p => p.join(',')).join(' ')}" fill="none" stroke="var(--viz-muted)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${l[0]}" cy="${l[1]}" r="4" fill="${color}" stroke="var(--card)" stroke-width="2"/></svg>`;
  }
  const tile = (label, value, sub, extra = '') => `<div class="tile"><div class="tile-label">${label}</div><div class="tile-value">${value}</div>${sub ? `<div class="tile-sub">${sub}</div>` : ''}${extra}</div>`;
  const status = (ok, good, bad) => `<span class="status ${ok ? 'ok' : 'bad'}">${ok ? '✓ ' + good : '✕ ' + bad}</span>`;

  function overviewHTML(d) {
    const { tot, net } = d, profit = net >= 0;
    const basis = d.adjusted ? 'after adjustments' : 'before adjustments';
    let h = `<section class="card hero">
      <div>
        <div class="tile-label">Net income · ${basis}</div>
        <div class="hero-value">${fmtCur(net)}</div>
        <div class="hero-sub"><span class="status ${profit ? 'ok' : 'bad'}">${profit ? '▲ Profit' : '▼ Loss'}</span>
          Net margin ${pct(net, tot.Revenue)} · Revenue ${fmtCur(tot.Revenue)} − Expenses ${fmtCur(tot.Expense)}</div>
      </div>
      <div class="hero-eq">
        <div class="tile-label">Accounting equation</div>
        <div class="eq"><span>Assets <b>${fmtCur(tot.Asset)}</b></span><span class="op">=</span><span>Liabilities <b>${fmtCur(tot.Liability)}</b></span><span class="op">+</span><span>Equity <b>${fmtCur(d.equityTotal)}</b></span></div>
        <div>${status(d.eqDiff === 0, 'Balanced', 'Off by ' + fmtCur(Math.abs(d.eqDiff)))}</div>
      </div></section>`;
    h += '<div class="tiles">';
    h += tile('Total revenue', fmtCur(tot.Revenue), 'Earned this period', spark(d.rev, d.lastIdx, 'var(--viz-1)'));
    h += tile('Total expenses', fmtCur(tot.Expense), 'Spent this period', spark(d.exp, d.lastIdx, 'var(--viz-2)'));
    if (d.cash) h += tile('Cash on hand', fmtCur(d.cash.value), esc(d.cash.a.name), spark(d.cashCum, d.lastIdx, 'var(--viz-3)'));
    h += tile('Total assets', fmtCur(tot.Asset), 'What the business owns');
    h += tile('Total liabilities', fmtCur(tot.Liability), 'What the business owes');
    h += tile('Equity', fmtCur(d.equityTotal), `Owner's equity ${fmtCur(tot.Equity)} + net income ${fmtCur(net)}`);
    h += tile('Trial balance', status(d.tb.balanced, 'Balanced', 'Out of balance'), `Debits ${fmtCur(d.tb.jd)} · Credits ${fmtCur(d.tb.jc)} (adjusted)`);
    h += tile('Entries', `${d.entries.length}`, `${d.txCount} transaction${d.txCount === 1 ? '' : 's'} · ${d.adjCount} adjustment${d.adjCount === 1 ? '' : 's'}`);
    h += tile('Accounts in use', `${d.list.length} <span class="of">of ${state.accounts.length}</span>`, d.latest ? `Latest entry ${fmtDate(d.latest)}` : '');
    return h + '</div>';
  }

  const cardHTML = def => `<section class="card viz-card${def.wide ? ' wide' : ''}">
    <div class="viz-head"><div><h3>${esc(def.title)}</h3><p class="muted">${esc(def.sub)}</p></div>
      <button type="button" class="btn ghost tiny" data-viewtoggle="${def.id}">${DASH.view[def.id] === 'table' ? 'Show chart' : 'Show table'}</button></div>
    ${def.legend ? `<div class="viz-legend">${def.legend.map(l => `<span class="lg"><i class="sw ${l.cls}"></i>${esc(l.name)}</span>`).join('')}</div>` : ''}
    <div class="viz-body" id="viz-${def.id}"></div></section>`;

  const tableHTML = (head, rows) => `<div class="table-wrap"><table class="mini"><thead><tr>${head.map((x, i) => `<th class="${i ? 'num' : ''}">${esc(x)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map((c, i) => `<td class="${i ? 'num' : ''}">${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;

  function tablesHTML(d) {
    // 1. Financial summary by account type
    let s = `<table><thead><tr><th>Code</th><th>Account</th><th class="num">Debits</th><th class="num">Credits</th><th class="num">Balance</th></tr></thead><tbody>`;
    ['Asset', 'Liability', 'Equity', 'Revenue', 'Expense'].forEach(t => {
      const rs = d.list.filter(r => r.a.type === t);
      if (!rs.length) return;
      s += `<tr class="grp"><td colspan="5"><span class="pill ${t}">${PLURAL[t]}</span></td></tr>`;
      rs.forEach(r => {
        s += `<tr><td>${esc(r.a.code)}</td><td>${esc(r.a.name)}${r.a.normal !== NORMAL[t] ? ' <span class="muted">(contra)</span>' : ''}</td><td class="num">${cell(r.dr)}</td><td class="num">${cell(r.cr)}</td><td class="num">${money(r.value)}</td></tr>`;
      });
      s += `<tr class="sub"><td colspan="4">Total ${PLURAL[t].toLowerCase()}</td><td class="num">${money(d.tot[t])}</td></tr>`;
    });
    [['Net income (revenue − expenses)', d.net], ['Total equity including net income', d.equityTotal],
      ['Total liabilities + equity', round2(d.tot.Liability + d.equityTotal)], ['Total assets', d.tot.Asset]]
      .forEach(([k, v]) => { s += `<tr class="sum"><td colspan="4">${k}</td><td class="num">${money(v)}</td></tr>`; });
    s += '</tbody></table>';
    const idle = state.accounts.length - d.list.length;
    const summary = `<section class="card"><div class="viz-head"><div><h3>Financial summary</h3><p class="muted">Every account with activity, grouped by type. Balances are shown on each account's normal side${d.adjusted ? ', after adjustments' : ', before adjustments'}.</p></div></div>
      <div class="table-wrap">${s}</div>${idle ? `<p class="muted small">${idle} other account${idle > 1 ? 's have' : ' has'} no activity in this period.</p>` : ''}</section>`;

    // 2. What the adjustments changed
    const adj = d.list.filter(r => r.ad || r.ac);
    const adjBody = adj.length
      ? tableHTML(['Account', 'Before adjustments', 'Adjustment', 'After adjustments'],
        adj.map(r => [`${r.a.code} – ${r.a.name}`, money(r.before), (r.adjEffect > 0 ? '+' : '') + money(r.adjEffect), money(round2(r.before + r.adjEffect))]))
      : '<p class="muted">No adjustments recorded in this period.</p>';
    const adjCard = `<section class="card"><div class="viz-head"><div><h3>What the adjustments changed</h3><p class="muted">Balance of each adjusted account before and after the adjusting entries.</p></div></div>${adjBody}</section>`;

    // 3. Latest entries
    const recent = d.entries.map((e, i) => ({ e, i })).sort((a, b) => b.e.date.localeCompare(a.e.date) || b.i - a.i).slice(0, 10);
    let r = `<table><thead><tr><th>Date</th><th>Type</th><th>Description</th><th class="num">Amount</th><th>Comment</th></tr></thead><tbody>`;
    recent.forEach(({ e }) => {
      r += `<tr><td>${fmtDate(e.date)}</td><td><span class="kind ${e.kind}">${e.kind === 'adjustment' ? 'Adjustment' : 'Transaction'}</span></td><td>${esc(e.desc)}</td><td class="num">${money(e.lines.reduce((s2, l) => s2 + l.debit, 0))}</td><td class="muted">${esc(e.comment || '')}</td></tr>`;
    });
    r += '</tbody></table>';
    const recentCard = `<section class="card"><div class="viz-head"><div><h3>Latest entries</h3><p class="muted">Showing ${recent.length} of ${d.entries.length} in this period, newest first.</p></div></div><div class="table-wrap">${r}</div></section>`;
    return summary + adjCard + recentCard;
  }

  /* ---------- Drawing ---------- */
  function drawChart(def) {
    const body = $('#viz-' + def.id);
    if (!body) return;
    hideTip();
    if (DASH.view[def.id] === 'table') { body.innerHTML = tableHTML(def.table.head, def.table.rows); return; }
    const out = def.build(Math.max(300, Math.floor(body.clientWidth)));
    body.innerHTML = out.svg;
    attachHover(body, out.tips);
  }
  const drawAll = () => DASH.defs.forEach(drawChart);

  function renderDashboard() {
    const root = $('#dashRoot');
    if (!root) return;
    hideTip();
    $('#dashPeriod').textContent = '📅 ' + period().label;
    const d = dashData();
    if (!d.entries.length) {
      const other = state.entries.length;
      DASH.defs = [];
      root.innerHTML = `<div class="card empty-dash"><h3>Nothing to chart yet</h3><p class="muted">${other
        ? `You have ${other} entr${other > 1 ? 'ies' : 'y'}, but none fall inside the selected accounting period. Change the period at the top of the page.`
        : 'Record a few transactions, or press <strong>Load sample data</strong> at the top of the page to see a full example.'}</p></div>`;
      return;
    }
    DASH.defs = chartDefs(d);
    root.innerHTML = overviewHTML(d) + `<div class="chart-grid">${DASH.defs.map(cardHTML).join('')}</div>` + tablesHTML(d);
    drawAll();
  }

  function setupDashboard() {
    $('#dashBasis').addEventListener('change', e => { DASH.basis = e.target.value; renderDashboard(); });
    document.addEventListener('click', e => {
      const b = e.target.closest('[data-viewtoggle]');
      if (!b) return;
      const id = b.dataset.viewtoggle, def = DASH.defs.find(x => x.id === id);
      if (!def) return;
      DASH.view[id] = DASH.view[id] === 'table' ? 'chart' : 'table';
      b.textContent = DASH.view[id] === 'table' ? 'Show chart' : 'Show table';
      drawChart(def);
    });
    let timer;
    window.addEventListener('resize', () => {
      clearTimeout(timer);
      timer = setTimeout(() => { if ($('#tab-dashboard').classList.contains('active')) drawAll(); }, 150);
    });
  }

  /* ---------- Render everything ---------- */
  function refreshAccountSelects() {
    $$('select[name=acct]').forEach(sel => {
      const v = sel.value;
      sel.innerHTML = acctOptions();
      if ([...sel.options].some(o => o.value === v)) sel.value = v;
    });
  }

  function renderAll() {
    renderPeriodBar();
    $$('.entry-form').forEach(f => setFormDate(f));
    refreshAccountSelects();
    renderAccounts();
    renderEntryList('transaction');
    renderEntryList('adjustment');
    renderTrial();
    if ($('#tab-dashboard').classList.contains('active')) renderDashboard();
    $$('.entry-form').forEach(updateTotals);
  }

  /* ---------- Start ---------- */
  document.addEventListener('DOMContentLoaded', async () => {
    setupPeriodBar();
    setupTabs();
    setupAccounts();
    setupEntryForms();
    setupEntryLists();
    setupHeader();
    setupDashboard();
    $('#accountForm').normal.value = NORMAL[$('#accountForm').type.value];

    if (useDB) {
      setDbStatus('loading');
      try {
        const data = await store.load();
        state.accounts = data.accounts;
        state.entries = data.entries;
        setDbStatus('ok');
      } catch (err) {
        state.accounts = []; state.entries = [];
        setDbStatus('error', (err && err.message) || String(err));
        fail(err);
      }
    } else {
      setDbStatus('local');
    }
    renderAll();
  });
})();