document.querySelectorAll('.btn').forEach((b) =>
  b.addEventListener('click', () => console.log('clicked', b.textContent))
);

// End-to-end test driver. Only runs with ?uigrabtest in the URL.
if (new URLSearchParams(location.search).has('uigrabtest')) {
  const ready = () => (window.__uiGrab ? drive() : setTimeout(ready, 25));
  ready();

  async function drive() {
    const api = window.__uiGrab;
    try {
      api.open(true);
      api.setPicking(true);

      api.pick(document.querySelector('#place-order'));
      api.comment('make this button 1.25x larger, keep the proportions');
      api.add();

      api.pick(document.querySelector('.checkout-title'));
      api.comment('tighten the leading');
      api.add();

      if (api.items().length !== 2) throw new Error('expected 2 queued, got ' + api.items().length);

      const r = await api.send();
      document.title = r.ok ? 'UIGRAB_OK:' + r.added : 'UIGRAB_FAIL:' + r.error;
    } catch (e) {
      document.title = 'UIGRAB_FAIL:' + e.message;
    }
  }
}
