const $ = (id) => document.getElementById(id);

const MODES = ['off', 'wait', 'wake', 'both'];
const BLURB = {
  off: 'You run <code>/grab</code> in Claude Code yourself.',
  wait: 'Claude holds each turn open for a few seconds, so clicks land in the turn it just finished.',
  wake: 'An idle session gets poked as soon as a batch arrives.',
  both: 'Holds the turn open first; wakes an idle session if that window passes.',
};

function renderMode(cfg) {
  const seg = $('seg');
  seg.textContent = '';
  for (const m of MODES) {
    const b = document.createElement('button');
    b.textContent = m;
    if (m === cfg.mode) b.className = 'sel';
    b.addEventListener('click', async () => {
      const r = await chrome.runtime.sendMessage({ type: 'setConfig', config: { mode: m } });
      if (r && r.ok) renderMode(r.config);
      else $('modehint').textContent = (r && r.error) || 'could not save';
    });
    seg.appendChild(b);
  }
  let hint = BLURB[cfg.mode];
  // Wake needs somewhere to send the poke; saying so beats silently doing nothing.
  if ((cfg.mode === 'wake' || cfg.mode === 'both') && !cfg.wake.tmux && !cfg.wake.resume) {
    hint += ' <b>No wake method enabled</b> — see <code>ui-grab-bridge --help</code>.';
  }
  $('modehint').innerHTML = hint;
}

async function refresh(force = false) {
  const r = await chrome.runtime.sendMessage({ type: 'status', force });
  const b = r && r.bridge;
  const { items } = await chrome.storage.local.get('items');
  const queued = (items || []).length;

  if (b) {
    $('dot').className = 'dot on';
    $('bridge').textContent = `connected :${b.port}`;
    $('root').textContent = b.root;
    $('rootrow').hidden = false;
    $('pendrow').hidden = false;
    const waiting = b.config && b.config.mode !== 'off' ? 'waiting for Claude' : 'waiting for /grab';
    $('pending').textContent = `${queued} here · ${b.pending} ${waiting}`;
    $('hint').innerHTML = `<kbd>Alt+Shift+G</kbd> toggles the picker on any page.`;
    if (b.config) {
      $('modecard').hidden = false;
      renderMode(b.config);
    }
  } else {
    $('dot').className = 'dot off';
    $('bridge').textContent = 'not running';
    $('rootrow').hidden = true;
    $('pendrow').hidden = true;
    $('modecard').hidden = true;
    $('hint').innerHTML =
      `Start it in the project you want to edit:<br><code>npx ui-grab-bridge</code>` +
      (queued ? `<br><br>${queued} pick${queued === 1 ? '' : 's'} held locally — they'll send once it's up.` : '');
  }
}

$('pick').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'toggle' });
  window.close();
});
$('recheck').addEventListener('click', () => refresh(true));
refresh();
