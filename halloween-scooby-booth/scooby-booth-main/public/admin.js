const $ = (id) => document.getElementById(id);
const api = async (url, opts) => {
  const res = await fetch(url, opts);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
};
const esc = (s = '') => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

let currentFile = null, saved = '', photo = null, stream = null;

// --- Files & editor ---
async function loadFiles() {
  const files = await api('/api/admin/files');
  const groups = { prompts: 'Shared prompts', stories: 'Stories', 'lineup.json': 'Dial lineup' };
  $('files').replaceChildren();
  let lastGroup;
  for (const f of files) {
    const group = groups[f.split('/')[0]];
    if (group !== lastGroup) {
      const g = document.createElement('div');
      g.className = 'group';
      g.textContent = lastGroup = group;
      $('files').append(g);
    }
    const b = document.createElement('button');
    b.textContent = f.split('/').pop();
    b.dataset.file = f;
    b.classList.toggle('active', f === currentFile);
    b.onclick = () => openFile(f);
    $('files').append(b);
  }
}

async function openFile(file) {
  if (isDirty() && !confirm('You have unsaved changes. Discard them?')) return;
  const { content } = await api(`/api/admin/file?path=${encodeURIComponent(file)}`);
  currentFile = file;
  saved = content;
  $('editor').value = content;
  $('editor').disabled = false;
  $('file-name').textContent = file;
  document.querySelectorAll('#files button').forEach((b) => b.classList.toggle('active', b.dataset.file === file));
  updateStatus();
}

const isDirty = () => currentFile && $('editor').value !== saved;
function updateStatus(text) {
  $('save').disabled = !isDirty();
  $('save-status').textContent = text ?? (isDirty() ? 'Unsaved changes' : '');
}

async function save() {
  if (!isDirty()) return;
  try {
    await api(`/api/admin/file?path=${encodeURIComponent(currentFile)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: $('editor').value }),
    });
    saved = $('editor').value;
    updateStatus('Saved');
    if (currentFile.startsWith('stories/') || currentFile === 'lineup.json') loadStories();
  } catch (err) {
    updateStatus(`Not saved: ${err.message}`);
  }
}

$('editor').oninput = () => updateStatus();
$('save').onclick = save;
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); }
});
window.addEventListener('beforeunload', (e) => { if (isDirty()) e.preventDefault(); });

$('new-story').onsubmit = async (e) => {
  e.preventDefault();
  const id = $('new-story-id').value.trim().toLowerCase();
  const file = `stories/${id}.md`;
  const template = `# New Story Title\n\nCHARACTERS:\n- \n\nSTORY:\nPanel 1: \nPanel 2: \nPanel 3: \nPanel 4: \n\nTEXT: Exactly _ speech bubbles and _ sound effects.\n`;
  await api(`/api/admin/file?path=${encodeURIComponent(file)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: template }),
  });
  $('new-story-id').value = '';
  await loadFiles();
  await loadStories();
  openFile(file);
};

// --- Photo ---
function setPhoto(base64) {
  photo = base64;
  $('photo').style.backgroundImage = `url(data:image/jpeg;base64,${base64})`;
  $('photo').textContent = '';
  $('run').disabled = false;
}

// Square center crop at up to 1024px, same as the kiosk camera
function toSquareJpeg(source, w, h) {
  const side = Math.min(w, h);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = Math.min(side, 1024);
  canvas.getContext('2d').drawImage(source, (w - side) / 2, (h - side) / 2, side, side, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.92).split(',')[1];
}

$('upload').onchange = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const img = new Image();
  img.onload = () => { setPhoto(toSquareJpeg(img, img.naturalWidth, img.naturalHeight)); URL.revokeObjectURL(img.src); };
  img.src = URL.createObjectURL(file);
  e.target.value = '';
};

$('webcam').onclick = async () => {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1920, height: 1080 } });
  } catch (err) {
    return showStage(`Couldn't open the webcam: ${err.message}`, true);
  }
  const video = document.createElement('video');
  Object.assign(video, { autoplay: true, playsInline: true, muted: true, srcObject: stream });
  $('photo').replaceChildren(video);
  $('photo').style.backgroundImage = '';
  $('snap').hidden = false;
};

$('snap').onclick = () => {
  const video = $('photo').querySelector('video');
  const shot = toSquareJpeg(video, video.videoWidth, video.videoHeight);
  stream.getTracks().forEach((t) => t.stop());
  $('photo').replaceChildren();
  $('snap').hidden = true;
  setPhoto(shot);
};

async function usePhotoFromRun(run) {
  const blob = await (await fetch(`/outputs/${run}/photo.jpg`)).blob();
  const reader = new FileReader();
  reader.onload = () => setPhoto(reader.result.split(',')[1]);
  reader.readAsDataURL(blob);
}

// --- Test run ---
async function loadStories() {
  // Grouped like the booth: dial position, then button A or B
  const groups = await api('/api/admin/stories');
  const current = $('story').value;
  $('story').replaceChildren(...groups.map((g) => {
    const group = document.createElement('optgroup');
    group.label = g.name;
    group.append(...g.stories.map((s) => new Option(s.button ? `${s.button} · ${s.title}  (${s.label})` : s.title, s.id)));
    return group;
  }));
  if (groups.some((g) => g.stories.some((s) => s.id === current))) $('story').value = current;
}

function showStage(text, isError = false) {
  $('stage').textContent = text;
  $('stage').classList.toggle('err', isError);
}

const STAGE_TEXT = {
  starting: 'Starting...', describing: 'Describing the photo...',
  drawing: 'Drawing (attempt 1)...', redrawing: 'Redrawing', checking: 'Checking likeness', printing: 'Printing...',
};

$('run').onclick = async () => {
  if (isDirty() && !confirm('The open file has unsaved changes, so this run will use the saved version. Run anyway?')) return;
  $('run').disabled = true;
  $('result').replaceChildren();
  showStage('Starting...');
  try {
    const { id } = await api('/api/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        photo, story: $('story').value, maxAttempts: Number($('attempts').value),
        print: $('auto-print').checked, printer: $('printer').value,
      }),
    });
    await pollJob(id);
  } catch (err) {
    showStage(err.message, true);
  }
  $('run').disabled = false;
  loadRuns();
};

async function pollJob(id) {
  for (;;) {
    const job = await api(`/api/jobs/${id}`);
    if (job.log) renderLog(job.log);
    if (job.stage === 'error') return showStage(job.error, true);
    if (job.stage === 'done') {
      const { passed, attempts, print } = job.result;
      return showStage(`Done: ${passed ? 'passed both checks' : 'did not pass the checks'} after ${attempts} attempt${attempts > 1 ? 's' : ''}.${print ? ` ${print}` : ''}`);
    }
    const base = STAGE_TEXT[job.stage] || job.stage;
    showStage(job.attempt && job.stage !== 'drawing' ? `${base} (attempt ${job.attempt})...` : base);
    await new Promise((r) => setTimeout(r, 1500));
  }
}

function renderLog(log) {
  const parts = [];
  if (log.description) parts.push(`<div class="desc"><b>Description of the photo</b>${esc(log.description)}</div>`);
  for (const a of [...log.attempts].reverse()) {
    const url = a.file ? `/outputs/${log.run}/${a.file}` : null;
    const badge = (label, c) => c
      ? `<span class="badge ${c.pass ? 'pass' : 'fail'}">${label} ${c.pass ? 'PASS' : 'FAIL'} ${c.score}/10</span>`
      : '';
    const check = a.check ? badge('Likeness', a.check) + badge('Story', a.storyCheck) : `<span class="badge fail">ERROR</span>`;
    const issues = [
      ...(a.check?.issues || []).map((i) => `Likeness: ${i}`),
      ...(a.storyCheck?.issues || []).map((i) => `Story: ${i}`),
      ...(a.error ? [a.error] : []),
    ].map((i) => `<li>${esc(i)}</li>`).join('');
    parts.push(`<div class="attempt ${log.final && log.final === a.file ? 'final' : ''}">
      ${url ? `<a href="${url}" target="_blank"><img src="${url}" alt="Attempt ${a.attempt}"></a>` : ''}
      <div class="meta">${check} Attempt ${a.attempt}${log.final === a.file ? ' · final (printed for the guest)' : ''}
        ${issues ? `<ul>${issues}</ul>` : ''}
        ${a.file ? `<button class="btn print" data-run="${esc(log.run)}" data-file="${esc(a.file)}">Print card</button>` : ''}
        ${a.prompt ? `<details><summary>Prompt sent</summary><pre>${esc(a.prompt)}</pre></details>` : ''}
      </div></div>`);
  }
  $('result').innerHTML = parts.join('');
  $('result').querySelectorAll('button.print').forEach((b) => (b.onclick = () => printComic(b)));
}

// --- Printing ---
async function loadPrinters() {
  try {
    const { printers, default: preferred } = await api('/api/admin/printers');
    $('printer').replaceChildren(new Option('Windows default printer', ''), ...printers.map((p) => new Option(p, p)));
    // Pick PRINTER_NAME from .env, or a card printer if one is installed
    $('printer').value = preferred || printers.find((p) => /scc|swift|card/i.test(p)) || '';
  } catch (err) {
    $('printer').replaceChildren(new Option(`Couldn't list printers`, ''));
  }
}

async function printComic(button) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Printing...';
  try {
    const { message } = await api('/api/admin/print', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ run: button.dataset.run, file: button.dataset.file, printer: $('printer').value }),
    });
    button.textContent = message;
  } catch (err) {
    button.textContent = `Print failed: ${err.message}`;
  }
  setTimeout(() => { button.textContent = label; button.disabled = false; }, 5000);
}

// --- Card back ---
function showBack() {
  // Cache-bust so a new upload shows right away
  const img = new Image();
  img.onload = () => { $('back-preview').style.backgroundImage = `url(${img.src})`; $('back-preview').textContent = ''; };
  img.src = `/api/admin/card-back?t=${Date.now()}`;
}

$('back-upload').onchange = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      await api('/api/admin/card-back', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: reader.result.split(',')[1] }),
      });
      $('back-status').textContent = 'Card back saved.';
      showBack();
    } catch (err) {
      $('back-status').textContent = `Upload failed: ${err.message}`;
    }
  };
  reader.readAsDataURL(file);
  e.target.value = '';
};

$('print-back').onclick = async () => {
  $('print-back').disabled = true;
  const copies = Math.min(100, Math.max(1, Math.floor(Number($('back-copies').value) || 1)));
  $('back-copies').value = copies;
  $('back-status').textContent = copies > 1 ? `Printing ${copies} card backs...` : 'Printing card back...';
  try {
    const { message } = await api('/api/admin/print-back', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ printer: $('printer').value, rotate180: $('back-rotate').checked, copies }),
    });
    $('back-status').textContent = message;
  } catch (err) {
    $('back-status').textContent = `Print failed: ${err.message}`;
  }
  $('print-back').disabled = false;
};

// --- Runs ---
async function loadRuns() {
  const runs = await api('/api/admin/runs');
  $('runs').replaceChildren(...runs.map((r) => {
    const b = document.createElement('button');
    b.className = !r.done ? '' : r.passed ? 'passed' : 'failed';
    const thumb = r.final ? `/outputs/${r.run}/${r.final}` : `/outputs/${r.run}/photo.jpg`;
    b.innerHTML = `<img src="${thumb}" loading="lazy" alt=""><span>${esc(r.story || '')} · ${esc(r.run.slice(5, 16).replace('T', ' '))}</span>`;
    b.title = 'Click to view this run. Shift+click to use its photo.';
    b.onclick = async (e) => {
      if (e.shiftKey) return usePhotoFromRun(r.run);
      if (!r.done) return;
      const log = await api(`/api/admin/runs/${r.run}`);
      renderLog(log);
      showStage(`Viewing run ${r.run}`);
      const reuse = document.createElement('button');
      reuse.className = 'btn';
      reuse.textContent = 'Use this photo for a new run';
      reuse.onclick = () => usePhotoFromRun(r.run);
      $('result').prepend(reuse);
      if (log.story) $('story').value = log.story;
    };
    return b;
  }));
}

// --- Init ---
api('/api/admin/info').then(({ imageModel, textModel, maxAttempts }) => {
  $('models').textContent = `Image: ${imageModel} · Text: ${textModel} · Kiosk max attempts: ${maxAttempts}`;
});
loadFiles();
loadStories();
loadRuns();
loadPrinters();
showBack();

// Header dot: green when the booth screen, Mega and LED panel are all connected (details on /connections)
async function checkConnections() {
  try {
    const { booth, mega, led } = await (await fetch('/api/connections')).json();
    const all = booth?.fresh && mega.link === 'connected' && led.displays.length;
    $('conn-dot').style.background = all ? 'var(--lime)' : 'var(--orange)';
    $('connections-link').title = all ? 'Everything connected' : 'Something needs attention';
  } catch {
    $('conn-dot').style.background = 'var(--red)';
  }
}
checkConnections();
setInterval(checkConnections, 5000);
