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
      if (!menu || !guests || problem) { box.hidden = true; return; }
      const price = Number(menu.dataset.price);
      const food = price * guests;
      const fee = Math.round(((food + hireFee) * feePct) / 100);
      set('[data-q-food-label]', `${guests} × ${money(price, currency)}`);
      set('[data-q-food]', money(food, currency));
      set('[data-q-hire]', money(hireFee, currency));
      set('[data-q-fee]', money(fee, currency));
      set('[data-q-total]', money(food + hireFee + fee, currency));
      box.hidden = false;
    }
    form.addEventListener('input', update);
    form.addEventListener('change', update);
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

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('form[data-quote]').forEach(initQuote);
    document.querySelectorAll('[data-countdown]').forEach(initCountdown);
    document.addEventListener('click', (e) => {
      const el = e.target.closest('[data-confirm]');
      if (el && !window.confirm(el.dataset.confirm)) e.preventDefault();
    });
  });
})();
