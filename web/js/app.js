const state = {
  groups: [],
  currentGroupIndex: 0,
  mode: 'run',
  editing: false,
  editSnapshot: null,
  ws: null,
};

const $ = (sel) => document.querySelector(sel);

function stepIndexToGroupIndex(groups, stepIndex) {
  let count = 0;
  for (let i = 0; i < groups.length; i++) {
    count += groups[i].steps.length;
    if (stepIndex < count) return i;
  }
  return Math.max(0, groups.length - 1);
}

function clampGroupIndex(idx) {
  const max = Math.max(0, state.groups.length - 1);
  return Math.max(0, Math.min(idx, max));
}

function groupPreview(group) {
  if (!group?.steps.length) return '(empty)';
  const preview = group.steps.slice(0, 2).join(' · ');
  if (group.steps.length > 2) return `${preview} · …`;
  return preview;
}

async function loadProgress() {
  const res = await fetch('/api/progress');
  const data = await res.json();
  state.groups = data.groups;
  if (data.currentGroupIndex !== undefined) {
    state.currentGroupIndex = data.currentGroupIndex;
  } else if (data.currentStepIndex !== undefined) {
    state.currentGroupIndex = stepIndexToGroupIndex(state.groups, data.currentStepIndex);
  } else {
    state.currentGroupIndex = 0;
  }
  state.currentGroupIndex = clampGroupIndex(state.currentGroupIndex);
}

async function saveProgress() {
  await fetch('/api/progress', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      groups: state.groups,
      currentGroupIndex: state.currentGroupIndex,
    }),
  });
}

function sendWs(msg) {
  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(msg));
  }
}

function connectWs() {
  if (location.protocol !== 'http:' && location.protocol !== 'https:') {
    return;
  }

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  state.ws = new WebSocket(`${proto}://${location.host}/ws`);

  state.ws.onerror = () => {};

  state.ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'nav') {
      navigate(msg.direction === 'next' ? 1 : -1, false);
    } else if (msg.type === 'state' && msg.currentGroupIndex !== undefined) {
      state.currentGroupIndex = clampGroupIndex(msg.currentGroupIndex);
      renderRunView();
    }
  };

  state.ws.onclose = () => setTimeout(connectWs, 2000);
}

function clearCarouselAnim() {
  const carousel = $('.carousel');
  carousel.classList.remove('anim-next', 'anim-prev');
  const slide = carousel.querySelector('.current-slide');
  slide.style.animation = 'none';
  void slide.offsetWidth;
  slide.style.animation = '';
}

function navigate(delta, persist = true) {
  const next = state.currentGroupIndex + delta;
  if (next < 0 || next >= state.groups.length) return;

  const carousel = $('.carousel');
  const animClass = delta > 0 ? 'anim-next' : 'anim-prev';
  const slide = carousel.querySelector('.current-slide');

  carousel.classList.remove('anim-next', 'anim-prev');
  void carousel.offsetWidth;
  carousel.classList.add(animClass);

  const finish = () => {
    carousel.classList.remove('anim-next', 'anim-prev');
    clearCarouselAnim();
    state.currentGroupIndex = next;
    renderRunView();
    if (persist) {
      saveProgress();
      sendWs({ type: 'state', currentGroupIndex: state.currentGroupIndex });
    }
  };

  slide.addEventListener('animationend', finish, { once: true });
}

function renderRunView() {
  clearCarouselAnim();

  const cur = state.groups[state.currentGroupIndex];
  if (!cur) return;

  const prev = state.currentGroupIndex > 0 ? state.groups[state.currentGroupIndex - 1] : null;
  const next =
    state.currentGroupIndex < state.groups.length - 1
      ? state.groups[state.currentGroupIndex + 1]
      : null;

  const act = cur.act;
  $('#act-label').textContent = typeof act === 'number' ? `Act ${act}` : String(act);
  $('#zone-title').textContent = cur.zone;

  const list = $('#step-list');
  list.innerHTML = '';
  cur.steps.forEach((text) => {
    const li = document.createElement('li');
    li.textContent = text;
    list.appendChild(li);
  });

  $('#step-counter').textContent = `${state.currentGroupIndex + 1} / ${state.groups.length}`;

  $('#prev-text').textContent = prev ? `${prev.zone}: ${groupPreview(prev)}` : '(start)';
  $('#next-text').textContent = next ? `${next.zone}: ${groupPreview(next)}` : '(done)';

  updateRunChrome();
}

function updateRunChrome() {
  const atStart = state.currentGroupIndex === 0;
  $('#reset-btn').classList.toggle('hidden', atStart || state.mode !== 'run' || state.editing);
  $('#config-btn').classList.toggle('hidden', state.mode !== 'run' || state.editing);
  $('#mode-toggle').classList.toggle('hidden', state.editing);
  $('#config-actions').classList.toggle('hidden', !state.editing);
}

async function setMode(mode) {
  if (state.mode === 'list' && mode === 'run' && !state.editing) {
    state.currentGroupIndex = clampGroupIndex(state.currentGroupIndex);
    await saveProgress();
  }
  state.mode = mode;
  $('#run-view').classList.toggle('hidden', mode !== 'run');
  $('#list-view').classList.toggle('hidden', mode !== 'list');
  if (mode === 'run') {
    renderRunView();
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
      state.currentGroupIndex = clampGroupIndex(state.currentGroupIndex);
      renderListView();
    });
    card.querySelector('.add-step-btn').addEventListener('click', () => {
      state.groups[gi].steps.push('New step');
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
    state.currentGroupIndex = clampGroupIndex(state.currentGroupIndex);
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
  state.currentGroupIndex = clampGroupIndex(state.currentGroupIndex);
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
  state.currentGroupIndex = clampGroupIndex(state.currentGroupIndex);
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
    state.currentGroupIndex = 0;
    renderRunView();
    await saveProgress();
    sendWs({ type: 'state', currentGroupIndex: 0 });
    toast('Reset to start');
  });

  $('#add-group-btn').addEventListener('click', () => {
    state.groups.push({
      id: `custom-${Date.now()}`,
      act: 1,
      zone: 'New Zone',
      steps: ['New step'],
    });
    renderListView();
  });

  window.addEventListener('keydown', (e) => {
    if (state.mode !== 'run' || state.editing) return;
    if (e.ctrlKey && e.key === 'ArrowLeft') {
      e.preventDefault();
      navigate(-1);
    } else if (e.ctrlKey && e.key === 'ArrowRight') {
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
