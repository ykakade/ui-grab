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

      // One comment about several elements at once.
      api.pick(document.querySelector('.checkout-sub'));
      api.pickAlso(document.querySelector('.btn-ghost'));
      if (api.state().extra !== 1) throw new Error('pickAlso did not stick');
      api.comment('these two should use the same muted grey');
      api.add();

      // Walking up to a parent you cannot hover: the li is covered by its spans.
      api.pick(document.querySelector('.li-name'));
      api.navigate('up');
      api.comment('placeholder');
      api.add();

      // Reword it, then move it above the multi-element pick.
      api.edit(3, 'give this row more room');
      api.move(3, -1);

      // The screenshot toggle is off unless you turn it on.
      const shotsOff = api.state().shots === false;
      api.setShots(true);
      const shotsOn = api.state().shots === true;
      api.setShots(false);

      if (api.items().length !== 4) throw new Error('expected 4 queued, got ' + api.items().length);

      const r = await api.send();
      document.title = r.ok
        ? `UIGRAB_OK:${r.added}:watch=${api.watching().length}:shots=${shotsOff && shotsOn}`
        : 'UIGRAB_FAIL:' + r.error;
    } catch (e) {
      document.title = 'UIGRAB_FAIL:' + e.message;
    }
  }
}
