/* =========================================================
   Accounting Management System
   Modules: Chart of Accounts · Transactions · Trial Balance · Adjustments
   Data is saved in the browser (localStorage).
   ========================================================= */
(() => {
  'use strict';

  /* ---------- Constants & helpers ---------- */
  const STORE_KEY = 'ams-v1';
  const GUIDE_KEY = 'ams-guide-hidden';
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
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
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

  let state = load();

  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORE_KEY));
      if (raw && raw.settings && Array.isArray(raw.accounts) && Array.isArray(raw.entries)) return raw;
    } catch (e) { /* ignore */ }
    return freshState();
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
    catch (e) { toast('Could not save to this browser (storage is full or blocked).', true); }
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
    }));
  }

  /* =========================================================
     1. CHART OF ACCOUNTS
     ========================================================= */
  function setupAccounts() {
    const form = $('#accountForm');
    form.type.addEventListener('change', () => { form.normal.value = NORMAL[form.type.value]; });
    form.code.addEventListener('input', () => { form.code.value = form.code.value.replace(/\D/g, ''); });

    form.addEventListener('submit', e => {
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

      state.accounts.push({ code, name, type: form.type.value, normal: form.normal.value });
      save(); form.reset(); form.normal.value = NORMAL[form.type.value];
      renderAll(); toast(`Added account ${code} – ${name}`);
      form.code.focus();
    });

    $('#accFilter').addEventListener('change', renderAccounts);

    $('#accBody').addEventListener('click', e => {
      const btn = e.target.closest('[data-del-acct]');
      if (!btn) return;
      const code = btn.dataset.delAcct;
      const acc = accountByCode(code);
      if (usageCount(code) > 0) {
        toast(`"${acc.name}" is used in ${usageCount(code)} journal line(s). Delete those entries first.`, true);
        return;
      }
      if (!confirm(`Remove account ${code} – ${acc.name}?`)) return;
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

  function submitEntry(form) {
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

    state.entries.push({ id: uid(), kind, date, desc, comment, lines });
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
    document.addEventListener('click', e => {
      const btn = e.target.closest('[data-del-entry]');
      if (!btn) return;
      const entry = state.entries.find(x => x.id === btn.dataset.delEntry);
      if (!entry || !confirm(`Delete "${entry.desc}"? This cannot be undone.`)) return;
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
  function loadSample() {
    if (state.entries.length && !confirm('This will replace your current accounts and entries with sample data. Continue?')) return;
    const keep = state.settings;
    state = freshState();
    state.settings = keep;
    const p = period();
    const T = (n, desc, lines, kind = 'transaction', comment = '') =>
      state.entries.push({ id: uid(), kind, date: addDays(p.start, n), desc, comment, lines: lines.map(([acct, debit, credit]) => ({ acct, debit, credit })) });
    T(1, 'Owner invested cash to start the business', [['1000', 50000, 0], ['3000', 0, 50000]]);
    T(3, 'Bought equipment for cash', [['1500', 12000, 0], ['1000', 0, 12000]]);
    T(5, 'Bought supplies on account', [['1200', 800, 0], ['2000', 0, 800]]);
    T(10, 'Earned service revenue (cash)', [['1000', 9500, 0], ['4000', 0, 9500]]);
    T(14, 'Paid monthly rent', [['5100', 2000, 0], ['1000', 0, 2000]]);
    T(20, 'Billed a customer on account', [['1100', 3200, 0], ['4000', 0, 3200]]);
    T(25, 'Paid utilities', [['5200', 650, 0], ['1000', 0, 650]]);
    T(28, 'Supplies used', [['5300', 500, 0], ['1200', 0, 500]], 'adjustment', 'Physical count shows 500 of supplies were used up during the period.');
    T(28, 'Record depreciation on equipment', [['5500', 200, 0], ['1590', 0, 200]], 'adjustment', 'Equipment depreciates evenly over its useful life; this is the amount for the period.');
    save(); renderAll(); toast('Sample data loaded. Open the Trial Balance tab to see the result.');
  }

  function setupHeader() {
    $('#btnSample').addEventListener('click', loadSample);
    $('#btnReset').addEventListener('click', () => {
      if (!confirm('Delete ALL accounts, transactions and adjustments and start over?')) return;
      state = freshState(); save(); renderAll(); toast('Everything was reset.');
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
    $$('.entry-form').forEach(updateTotals);
  }

  /* ---------- Start ---------- */
  document.addEventListener('DOMContentLoaded', () => {
    setupPeriodBar();
    setupTabs();
    setupAccounts();
    setupEntryForms();
    setupEntryLists();
    setupHeader();
    $('#accountForm').normal.value = NORMAL[$('#accountForm').type.value];
    renderAll();
  });
})();