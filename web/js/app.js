const state = {
  groups: [],
  currentStepIndex: 0,
  mode: 'run',
  editing: false,
  editSnapshot: null,
  ws: null,
  totalSteps: 0,
};

const $ = (sel) => document.querySelector(sel);

function flattenSteps(groups) {
  const flat = [];
  for (const g of groups) {
    g.steps.forEach((text, i) => {
      flat.push({ groupId: g.id, group, stepIndex: i, text });
    });
  }
  return flat;
}

function totalStepCount(groups) {
  return groups.reduce((n, g) => n + g.steps.length, 0);
}

function clampIndex(idx) {
  const max = Math.max(0, state.totalSteps - 1);
  return Math.max(0, Math.min(idx, max));
}

async function loadProgress() {
  const res = await fetch('/api/progress');
  const data = await res.json();
  state.groups = data.groups;
  state.currentStepIndex = data.currentStepIndex ?? 0;
  state.totalSteps = totalStepCount(state.groups);
  state.currentStepIndex = clampIndex(state.currentStepIndex);
}

async function saveProgress() {
  await fetch('/api/progress', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      groups: state.groups,
      currentStepIndex: state.currentStepIndex,
    }),
  });
}

function sendWs(msg) {
  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(msg));
  }
}

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  state.ws = new WebSocket(`${proto}://${location.host}/ws`);

  state.ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'nav') {
      navigate(msg.direction === 'next' ? 1 : -1, false);
    } else if (msg.type === 'state' && msg.currentStepIndex !== undefined) {
      state.currentStepIndex = clampIndex(msg.currentStepIndex);
      renderRunView(false);
    }
  };

  state.ws.onclose = () => setTimeout(connectWs, 2000);
}

function navigate(delta, persist = true) {
  const next = state.currentStepIndex + delta;
  if (next < 0 || next >= state.totalSteps) return;

  const carousel = $('.carousel');
  carousel.classList.remove('anim-next', 'anim-prev');
  void carousel.offsetWidth;
  carousel.classList.add(delta > 0 ? 'anim-next' : 'anim-prev');

  state.currentStepIndex = next;
  renderRunView(true);

  if (persist) {
    saveProgress();
    sendWs({ type: 'state', currentStepIndex: state.currentStepIndex });
  }
}

function renderRunView(animate) {
  const flat = flattenSteps(state.groups);
  const cur = flat[state.currentStepIndex];
  if (!cur) return;

  const prev = state.currentStepIndex > 0 ? flat[state.currentStepIndex - 1] : null;
  const next = state.currentStepIndex < flat.length - 1 ? flat[state.currentStepIndex + 1] : null;

  const act = cur.group.act;
  $('#act-label').textContent = typeof act === 'number' ? `Act ${act}` : String(act);
  $('#zone-title').textContent = cur.group.zone;
  $('#step-text').textContent = cur.text;
  $('#step-counter').textContent = `${state.currentStepIndex + 1} / ${state.totalSteps}`;

  $('#prev-text').textContent = prev
    ? `${prev.group.zone}: ${prev.text}`
    : '(start)';
  $('#next-text').textContent = next
    ? `${next.group.zone}: ${next.text}`
    : '(done)';

  updateRunChrome();
}

function updateRunChrome() {
  const atStart = state.currentStepIndex === 0;
  $('#reset-btn').classList.toggle('hidden', atStart || state.mode !== 'run' || state.editing);
  $('#config-btn').classList.toggle('hidden', state.mode !== 'run' || state.editing);
  $('#mode-toggle').classList.toggle('hidden', state.editing);
  $('#config-actions').classList.toggle('hidden', !state.editing);
}

async function setMode(mode) {
  if (state.mode === 'list' && mode === 'run' && !state.editing) {
    state.totalSteps = totalStepCount(state.groups);
    state.currentStepIndex = clampIndex(state.currentStepIndex);
    await saveProgress();
  }
  state.mode = mode;
  $('#run-view').classList.toggle('hidden', mode !== 'run');
  $('#list-view').classList.toggle('hidden', mode !== 'list');
  if (mode === 'run') {
    renderRunView(false);
  } else {
    renderListView();
  }
  updateRunChrome();
}

function renderListView() {
  const container = $('#group-list');
  container.innerHTML = '';

  state.groups.forEach((group, gi) => {
    const card = document.createElement('div');
    card.className = 'group-card';
    card.dataset.index = gi;

    card.innerHTML = `
      <div class="group-header">
        <input type="text" class="zone-input" placeholder="Zone name">
        <div class="group-meta">
          <input type="text" class="act-input" placeholder="Act">
          <div class="group-actions">
            <button type="button" class="remove-group" title="Remove group">✕</button>
          </div>
        </div>
      </div>
      <div class="step-list"></div>
      <button type="button" class="add-step-btn">+ Step</button>
    `;
    card.querySelector('.zone-input').value = group.zone;
    card.querySelector('.act-input').value = String(group.act);

    const stepList = card.querySelector('.step-list');
    group.steps.forEach((text, si) => {
      stepList.appendChild(makeStepRow(text, gi, si));
    });

    card.querySelector('.zone-input').addEventListener('input', (e) => {
      state.groups[gi].zone = e.target.value;
    });
    card.querySelector('.act-input').addEventListener('input', (e) => {
      const v = e.target.value;
      state.groups[gi].act = isNaN(Number(v)) ? v : Number(v);
    });
    card.querySelector('.remove-group').addEventListener('click', () => {
      state.groups.splice(gi, 1);
      state.totalSteps = totalStepCount(state.groups);
      state.currentStepIndex = clampIndex(state.currentStepIndex);
      renderListView();
    });
    card.querySelector('.add-step-btn').addEventListener('click', () => {
      state.groups[gi].steps.push('New step');
      state.totalSteps = totalStepCount(state.groups);
      renderListView();
    });

    container.appendChild(card);
  });
}

function makeStepRow(text, gi, si) {
  const row = document.createElement('div');
  row.className = 'step-item';
  row.innerHTML = `
    <span class="step-handle">${si + 1}</span>
    <textarea rows="2"></textarea>
    <button type="button" class="remove-step" title="Remove">×</button>
  `;
  row.querySelector('textarea').value = text;
  row.querySelector('textarea').addEventListener('input', (e) => {
    state.groups[gi].steps[si] = e.target.value;
  });
  row.querySelector('.remove-step').addEventListener('click', () => {
    state.groups[gi].steps.splice(si, 1);
    state.totalSteps = totalStepCount(state.groups);
    state.currentStepIndex = clampIndex(state.currentStepIndex);
    renderListView();
  });
  return row;
}

function startEditing() {
  state.editing = true;
  state.editSnapshot = JSON.parse(JSON.stringify(state.groups));
  setMode('list');
  updateRunChrome();
}

async function saveEditing() {
  state.editing = false;
  state.editSnapshot = null;
  state.totalSteps = totalStepCount(state.groups);
  state.currentStepIndex = clampIndex(state.currentStepIndex);
  await saveProgress();
  setMode('run');
  toast('Saved');
}

function cancelEditing() {
  if (state.editSnapshot) {
    state.groups = state.editSnapshot;
  }
  state.editing = false;
  state.editSnapshot = null;
  state.totalSteps = totalStepCount(state.groups);
  setMode('run');
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  el.classList.add('show');
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.classList.add('hidden'), 300);
  }, 1800);
}

function bindEvents() {
  document.querySelectorAll('[data-nav]').forEach((el) => {
    el.addEventListener('click', () => {
      if (state.mode !== 'run' || state.editing) return;
      navigate(el.dataset.nav === 'next' ? 1 : -1);
    });
  });

  $('#mode-toggle').addEventListener('click', async () => {
    if (state.editing) return;
    await setMode(state.mode === 'run' ? 'list' : 'run');
  });

  $('#config-btn').addEventListener('click', startEditing);
  $('#save-btn').addEventListener('click', saveEditing);
  $('#cancel-btn').addEventListener('click', cancelEditing);

  $('#reset-btn').addEventListener('click', async () => {
    state.currentStepIndex = 0;
    renderRunView(false);
    await saveProgress();
    sendWs({ type: 'state', currentStepIndex: 0 });
    toast('Reset to start');
  });

  $('#add-group-btn').addEventListener('click', () => {
    state.groups.push({
      id: `custom-${Date.now()}`,
      act: 1,
      zone: 'New Zone',
      steps: ['New step'],
    });
    state.totalSteps = totalStepCount(state.groups);
    renderListView();
  });

  window.addEventListener('keydown', (e) => {
    if (state.mode !== 'run' || state.editing) return;
    if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'ArrowLeft')) {
      e.preventDefault();
      navigate(-1);
    } else if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'ArrowRight')) {
      e.preventDefault();
      navigate(1);
    }
  });
}

async function init() {
  bindEvents();
  await loadProgress();
  connectWs();
  setMode('run');
}

init();
