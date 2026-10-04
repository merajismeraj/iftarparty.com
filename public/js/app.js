'use strict';
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
      if (guests && (guests < minPax || guests > maxPax)) problem = `This hall takes ${minPax}–${maxPax} guests.`;
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

  document.addEventListener('DOMContentLoaded', () => {
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
