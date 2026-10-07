'use strict';
// Lets CSS start collapsible UI (nav drawer, planner steps) closed only when JS can reopen it.
document.documentElement.classList.add('js');
(function () {
  function money(minor, currency) {
    const major = minor / 100;
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: Number.isInteger(major) ? 0 : 2 }).format(major);
  }

  // Live price quote on the venue page (mirrors src/services/pricing.js; the server recomputes).
  function initQuote(form) {
    const hireFee = Number(form.dataset.hireFee);
    const feePct = Number(form.dataset.feePercent);
    const currency = form.dataset.currency;
    const minPax = Number(form.dataset.minPax);
    const maxPax = Number(form.dataset.maxPax);
    const box = form.querySelector('[data-quote-box]');
    const err = form.querySelector('[data-quote-error]');
    const guestsInput = form.elements.guests;
    const set = (sel, v) => { form.querySelector(sel).textContent = v; };

    function update() {
      const menu = form.querySelector('input[name="menu_id"]:checked');
      const guests = Number.parseInt(guestsInput.value, 10);
      let problem = '';
      if (guests && (guests < minPax || guests > maxPax)) problem = `This venue takes ${minPax}–${maxPax} guests.`;
      else if (menu && guests && guests < Number(menu.dataset.min)) problem = `This menu needs at least ${menu.dataset.min} guests.`;
      err.hidden = !problem;
      err.textContent = problem;
      if (!menu || !guests || problem) { box.hidden = true; syncBudget(0, menu ? Number(menu.dataset.price) : 0); return; }
      const price = Number(menu.dataset.price);
      const food = price * guests;
      let addons = 0;
      form.querySelectorAll('input[name="addon_ids"]:checked').forEach((a) => {
        addons += Number(a.dataset.addonPrice) * (a.dataset.addonPricing === 'per_guest' ? guests : 1);
      });
      const fee = Math.round(((food + hireFee + addons) * feePct) / 100);
      set('[data-q-food-label]', `${guests} × ${money(price, currency)}`);
      set('[data-q-food]', money(food, currency));
      const addonsRow = form.querySelector('[data-q-addons-row]');
      if (addonsRow) { addonsRow.hidden = !addons; set('[data-q-addons]', money(addons, currency)); }
      set('[data-q-hire]', money(hireFee, currency));
      set('[data-q-fee]', money(fee, currency));
      set('[data-q-total]', money(food + hireFee + addons + fee, currency));
      const cta = document.querySelector('[data-mobile-cta]');
      if (cta) {
        cta.querySelector('[data-cta-label]').textContent = `${guests} guests · total`;
        cta.querySelector('[data-cta-amount]').textContent = money(food + hireFee + addons + fee, currency);
      }
      syncBudget(food + hireFee + addons + fee, price);
      box.hidden = false;
    }
    // Package dish pickers: only the selected package's picker is shown and submitted,
    // and each course stops accepting picks once its quota is reached.
    function syncPickers() {
      const menu = form.querySelector('input[name="menu_id"]:checked');
      form.querySelectorAll('[data-picker-for]').forEach((p) => {
        const active = menu && p.dataset.pickerFor === menu.value;
        p.hidden = !active;
        p.querySelectorAll('[data-course]').forEach((c) => {
          const boxes = [...c.querySelectorAll('input[type=checkbox]')];
          const n = boxes.filter((b) => b.checked).length;
          const max = Number(c.dataset.choose);
          boxes.forEach((b) => { b.disabled = !active || (!b.checked && n >= max); });
          const count = c.querySelector('[data-course-count]');
          count.textContent = n;
          count.classList.toggle('done', n > 0);
        });
        syncTotal(p);
      });
    }

    const budgetMsg = form.querySelector('[data-budget-msg]');
    function syncBudget(total, perGuest) {
      if (!budgetMsg || !form.dataset.budget) return;
      const budget = Number(form.dataset.budget);
      const spend = form.dataset.budgetType === 'total' ? total : perGuest;
      if (!spend) { budgetMsg.hidden = true; return; }
      const left = budget - spend;
      budgetMsg.hidden = false;
      budgetMsg.className = `small ${left >= 0 ? 'good' : 'bad'}`;
      budgetMsg.textContent = left >= 0
        ? `Within your budget ✓ (${money(left, currency)} to spare${form.dataset.budgetType === 'total' ? '' : ' per guest'})`
        : `Over your budget by ${money(-left, currency)}${form.dataset.budgetType === 'total' ? '' : ' per guest'}`;
    }

    form.addEventListener('input', () => { syncPickers(); update(); });
    form.addEventListener('change', () => { syncPickers(); update(); });
    syncPickers();
    update();

    const date = form.querySelector('[data-availability]');
    const msg = form.querySelector('[data-availability-msg]');
    const btn = form.querySelector('[data-reserve-btn]');
    if (date && msg) {
      date.addEventListener('change', async () => {
        msg.className = 'availability';
        msg.textContent = date.value ? 'Checking…' : '';
        if (!date.value) return;
        try {
          const res = await fetch(`/api/venues/${form.dataset.venue}/availability?date=${encodeURIComponent(date.value)}`);
          const data = await res.json();
          msg.textContent = data.available ? 'Available ✓' : `Reserved · ${data.label}`;
          msg.classList.add(data.available ? 'good' : 'bad');
          if (btn) btn.disabled = !data.available;
        } catch { msg.textContent = ''; }
      });
    }
  }

  /** Running "N of min" dish counter; the server enforces the same minimum. */
  function syncTotal(picker) {
    const out = picker.querySelector('[data-picker-total]');
    if (!out) return;
    const min = Number(picker.dataset.minTotal || 0);
    const n = picker.querySelectorAll('input[type=checkbox]:checked').length;
    out.textContent = n >= min ? `${n} dishes selected ✓` : `${n} of ${min} minimum dishes selected – pick ${min - n} more`;
    out.className = `small picker-total ${n >= min ? 'good' : 'bad'}`;
  }

  // Countdown for the payment hold.
  function initCountdown(el) {
    const end = Date.parse(el.dataset.countdown);
    const out = el.querySelector('[data-countdown-text]');
    const tick = () => {
      const left = Math.max(0, end - Date.now());
      const m = Math.floor(left / 60000);
      const s = Math.floor((left % 60000) / 1000);
      out.textContent = `${m}:${String(s).padStart(2, '0')}`;
      if (!left) { clearInterval(t); location.reload(); }
    };
    const t = setInterval(tick, 1000);
    tick();
  }

  // Hand off to Cashfree's hosted checkout (SDK loaded only on this page).
  function initCashfree(el) {
    const fail = () => { el.querySelector('[data-cashfree-error]').hidden = false; };
    if (typeof window.Cashfree !== 'function') return fail();
    try {
      const cashfree = window.Cashfree({ mode: el.dataset.cashfreeMode });
      Promise.resolve(cashfree.checkout({ paymentSessionId: el.dataset.cashfreeSession, redirectTarget: '_self' }))
        .then((r) => { if (r && r.error) fail(); }, fail);
    } catch { fail(); }
  }

  // Phones: hamburger drawer for the main nav.
  function initNav() {
    const header = document.querySelector('[data-site-header]');
    const toggle = document.querySelector('[data-nav-toggle]');
    if (!header || !toggle) return;
    toggle.hidden = false;
    toggle.addEventListener('click', () => {
      const open = header.classList.toggle('nav-open');
      toggle.setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && header.classList.contains('nav-open')) { header.classList.remove('nav-open'); toggle.setAttribute('aria-expanded', 'false'); toggle.focus(); }
    });
  }

  // Phones: tables render as stacked cards; label each cell with its column header.
  function labelTables() {
    document.querySelectorAll('.table-wrap table').forEach((table) => {
      const heads = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim());
      if (!heads.length) return;
      table.querySelectorAll('tbody tr').forEach((tr) => {
        [...tr.children].forEach((td, i) => { if (!td.hasAttribute('data-label') && td.colSpan === 1) td.setAttribute('data-label', heads[i] || ''); });
      });
    });
  }

  // Home planner: guests + date first, then budget + location. Without JS both steps show as one form.
  function initPlanner(form) {
    const steps = [...form.querySelectorAll('[data-step]')];
    const dots = [...form.querySelectorAll('.plan-progress li')];
    const estimate = form.querySelector('[data-plan-estimate]');
    const show = (n) => {
      steps.forEach((s) => { s.hidden = Number(s.dataset.step) !== n; });
      dots.forEach((d, i) => d.classList.toggle('on', i < n));
      const first = steps[n - 1].querySelector('input:not([type=radio]), input:checked, input');
      if (first && n > 1) first.focus({ preventScroll: true });
    };
    form.classList.add('stepped');
    show(1);
    form.querySelector('[data-next]').addEventListener('click', () => {
      const missing = [...steps[0].querySelectorAll('input')].find((i) => !i.checkValidity());
      if (missing) { missing.reportValidity(); return; }
      show(2);
    });
    form.querySelector('[data-back]').addEventListener('click', () => show(1));
    // Enter on step 1 moves on instead of submitting half a search.
    steps[0].addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); form.querySelector('[data-next]').click(); }
    });
    form.querySelectorAll('[data-quick]').forEach((row) => {
      const input = form.elements[row.dataset.quick];
      const mark = () => row.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c.dataset.value === input.value));
      row.addEventListener('click', (e) => {
        const chip = e.target.closest('.chip');
        if (!chip) return;
        input.value = chip.dataset.value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      input.addEventListener('input', mark);
      mark();
    });
    const syncEstimate = () => {
      const guests = Number.parseInt(form.elements.guests.value, 10);
      const per = Number(form.querySelector('input[name=budget]:checked')?.value);
      estimate.textContent = guests > 0 && per > 0 ? `≈ ${money(guests * per * 100, form.dataset.currency)} food for ${guests} guests` : '';
    };
    form.addEventListener('input', syncEstimate);
    form.addEventListener('change', syncEstimate);
    syncEstimate();
    // Keep the results URL short: drop empty answers.
    form.addEventListener('submit', () => {
      form.querySelectorAll('input').forEach((i) => { if (!i.value) i.disabled = true; });
    });
    window.addEventListener('pageshow', () => form.querySelectorAll('input').forEach((i) => { i.disabled = false; }));
  }

  // Venue photos: shrink in the browser before upload (phone photos are 3–8 MB; requests are capped at ~4.5 MB).
  function initPhotoInput(input) {
    const MAX_EDGE = 1600;
    const BUDGET = 4 * 1024 * 1024;
    const note = input.closest('label')?.querySelector('[data-upload-note]');
    const original = note ? note.textContent : '';
    async function shrink(file) {
      if (file.size < 350 * 1024 && file.type === 'image/jpeg') return file;
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bmp.width * scale);
      canvas.height = Math.round(bmp.height * scale);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; // transparent PNGs become JPEGs on white
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((done) => canvas.toBlob(done, 'image/jpeg', 0.82));
      return blob && blob.size < file.size ? new File([blob], `${file.name.replace(/\.\w+$/, '')}.jpg`, { type: 'image/jpeg' }) : file;
    }
    input.addEventListener('change', async () => {
      const files = [...input.files];
      if (!files.length || !window.DataTransfer || !window.createImageBitmap) return;
      input.setCustomValidity('Preparing photos…');
      if (note) note.textContent = 'Preparing photos…';
      const out = new DataTransfer();
      let total = 0;
      for (const f of files) {
        let file = f;
        try { file = await shrink(f); } catch { /* keep the original */ }
        total += file.size;
        out.items.add(file);
      }
      input.files = out.files;
      const mb = (total / 1048576).toFixed(1);
      const tooBig = total > BUDGET;
      input.setCustomValidity(tooBig ? `These photos add up to ${mb} MB. Add fewer at a time (max 4 MB per save).` : '');
      if (note) {
        note.textContent = tooBig ? `${mb} MB – too large together. Save a few now and add the rest after.`
          : `${files.length} photo${files.length === 1 ? '' : 's'} ready (${mb} MB). ${original}`;
        note.classList.toggle('bad', tooBig);
      }
    });
  }

  // Phones: sticky "Reserve" bar, hidden while the booking form itself is on screen.
  function initMobileCta() {
    const cta = document.querySelector('[data-mobile-cta]');
    const target = document.getElementById('reserve');
    if (!cta || !target) return;
    document.body.classList.add('has-mobile-cta');
    if (!('IntersectionObserver' in window)) return;
    new IntersectionObserver(([entry]) => cta.classList.toggle('hide', entry.isIntersecting), { threshold: 0.15 }).observe(target);
  }

  document.addEventListener('DOMContentLoaded', () => {
    initNav();
    labelTables();
    document.querySelectorAll('form[data-planner]').forEach(initPlanner);
    document.querySelectorAll('input[data-photo-input]').forEach(initPhotoInput);
    initMobileCta();
    document.querySelectorAll('[data-cashfree-session]').forEach(initCashfree);
    // Restaurant menu form: show the set-menu or package section for the chosen type.
    document.querySelectorAll('form[data-menu-form]').forEach((form) => {
      const sync = () => {
        const kind = form.querySelector('input[name="kind"]:checked')?.value || 'set';
        form.querySelectorAll('[data-kind-section]').forEach((sec) => { sec.hidden = sec.dataset.kindSection !== kind; });
      };
      form.addEventListener('change', (e) => { if (e.target.name === 'kind') sync(); });
      sync();
    });

    // Standalone dish picker (edit menu page): enforce per-course quotas.
    document.querySelectorAll('form[data-picker-form]').forEach((form) => {
      const sync = () => {
        form.querySelectorAll('[data-course]').forEach((c) => {
          const boxes = [...c.querySelectorAll('input[type=checkbox]')];
          const n = boxes.filter((b) => b.checked).length;
          boxes.forEach((b) => { b.disabled = !b.checked && n >= Number(c.dataset.choose); });
          const count = c.querySelector('[data-course-count]');
          count.textContent = n;
          count.classList.toggle('done', n > 0);
        });
        form.querySelectorAll('[data-picker-for]').forEach(syncTotal);
      };
      form.addEventListener('change', sync);
      sync();
    });
    document.querySelectorAll('form[data-quote]').forEach(initQuote);
    document.querySelectorAll('[data-countdown]').forEach(initCountdown);
    document.addEventListener('click', (e) => {
      const el = e.target.closest('[data-confirm]');
      if (el && el.dataset.confirm && !window.confirm(el.dataset.confirm)) e.preventDefault();
    });
  });
})();
