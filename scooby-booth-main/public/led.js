// Booth screen for the 192x192 LED panel. Everything is drawn into a 192x192 canvas (#led),
// which is what gets streamed to the Pi; #display is just a scaled-up preview of it.
// Look: a quiet vintage instrument panel. Dark warm panel, one amber accent, indicator lamps, a tuning scale.
const $ = (id) => document.getElementById(id);
const W = 192;
const led = $('led').getContext('2d');
const display = $('display').getContext('2d');

const C = {
  bg: '#0f0d0b', rule: '#3a332b', screw: '#2a241e',
  amber: '#ffb547', blue: '#4f8dff', redBtn: '#ff4a3d', amberMid: '#a8742c', amberDim: '#3d2a12',
  cream: '#e9e1cf', creamDim: '#8c8474', red: '#e0573a',
};

// All on-screen wording in one place. The physical buttons aren't labeled yet, so this stays neutral.
const COPY = {
  title: 'MYSTERY INC.',
  start: 'TURN KEY TO BEGIN',
  look: 'LOOK AT THE CAMERA',
  taken: 'PHOTO TAKEN',
  dial: 'TURN THE DIAL',
  choose: 'CHOOSE RED OR BLUE',
  go: 'FLIP THE LEVER',
  done1: 'ALL DONE',
  done2: 'TAKE YOUR CARD',
  error1: 'SOMETHING WENT WRONG',
  error2: 'PLEASE TRY AGAIN',
};
const STAGE_WORDS = {
  starting: 'WARMING UP', describing: 'STUDYING', drawing: 'DRAWING',
  checking: 'CHECKING', redrawing: 'TOUCH-UPS', printing: 'PRINTING', done: 'DONE',
};
const IDLE_TIMEOUT = 45_000;   // picking screen resets after this long with no input
const LAMPS_AFTER = 4_000;    // the red/blue lamps appear this long into the picking screen, so guests play with the dial first
const DONE_TIME = 15_000;      // "take your card" screen
const ERROR_TIME = 8_000;

let lineup = [], scene = null;
let state = 'attract', stateAt = performance.now(), lastInput = performance.now();
let dial = 0, dialShown = 0, choice = null;  // dial index 0-4 (dialShown eases toward it); choice 'a' (blue) | 'b' (red)
let lampsAt = null;                          // when the red/blue lamps started to show
let view = null;                             // where the spotlight/camera currently is: { x, y, r } in scene pixels
let photo = null, photoArt = null;           // base64 JPEG for the API, 192x192 amber version for the wait screen
let progress = 0, progressTarget = 0, stage = 'starting', countdown = 3;

function go(next) {
  state = next;
  stateAt = performance.now();
  lastInput = stateAt;
}

// ---------- Inputs (keyboard, or the Mega's key/dial/buttons/lever relayed by the server) ----------
let session = 0, goQueued = false;
function input(action) {
  lastInput = performance.now();
  // The key starts a session from the start screen, and also from the last guest's "take your card" or error screen
  if (action === 'photo' && ['attract', 'done', 'error'].includes(state)) return startCountdown();
  // The Mega went back to idle: drop a session that hasn't started drawing yet
  if (action === 'idle') return ['countdown', 'flash', 'pick'].includes(state) && endSession();
  // The dial and buttons already work during the countdown, since the hardware does; a lever pull that
  // early waits until the photo is taken
  if (!['countdown', 'flash', 'pick'].includes(state)) return;
  let next = dial;
  if (action === 'left') next = (dial + lineup.length - 1) % lineup.length;
  if (action === 'right') next = (dial + 1) % lineup.length;
  if (action.startsWith('dial')) next = Math.min(Number(action.slice(4)) - 1, lineup.length - 1);
  if (next !== dial) {
    // Turning the dial after a button cancels the choice (the Mega does the same)
    dial = next; choice = null; goQueued = false;
  }
  if (action === 'a' || action === 'b') { choice = action; lampsAt ??= performance.now(); }
  if (action === 'go' && choice) state === 'pick' ? startComic() : (goQueued = true);
}

function endSession() {
  session++;
  go('attract');
}

const KEYS = {
  ArrowLeft: 'left', ArrowRight: 'right', a: 'a', b: 'b', p: 'photo', ' ': 'photo', Enter: 'go', g: 'go',
  1: 'dial1', 2: 'dial2', 3: 'dial3', 4: 'dial4', 5: 'dial5',
};
document.addEventListener('keydown', (e) => {
  const action = KEYS[e.key] ?? KEYS[e.key.toLowerCase()];
  if (action && !e.target.matches('input')) { e.preventDefault(); input(action); }
});
$('dial-left').onclick = () => input('left');
$('dial-right').onclick = () => input('right');
document.querySelectorAll('[data-dial]').forEach((b) => (b.onclick = () => input(`dial${b.dataset.dial}`)));
$('btn-photo').onclick = () => input('photo');
$('btn-a').onclick = () => input('a');
$('btn-b').onclick = () => input('b');
$('btn-go').onclick = () => input('go');

// ---------- Camera (no preview is ever shown on the LED) ----------
let camera = null;
navigator.mediaDevices?.getUserMedia({ video: { width: 1920, height: 1080 } })
  .then((stream) => { camera = stream; $('video').srcObject = stream; })
  .catch((err) => status(`No camera (${err.message}); demo photos will use a placeholder.`));

function capturePhoto() {
  const v = $('video');
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1024;
  const g = canvas.getContext('2d');
  if (camera && v.videoWidth) {
    const side = Math.min(v.videoWidth, v.videoHeight);
    g.drawImage(v, (v.videoWidth - side) / 2, (v.videoHeight - side) / 2, side, side, 0, 0, 1024, 1024);
  } else {
    // Placeholder "person" so the demo still has something to reveal
    g.fillStyle = '#8a9aa8'; g.fillRect(0, 0, 1024, 1024);
    g.fillStyle = '#e8c4a8'; g.beginPath(); g.arc(512, 420, 200, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#3a6ea8'; g.beginPath(); g.ellipse(512, 1024, 380, 340, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#4a3020'; g.beginPath(); g.arc(512, 330, 210, Math.PI, 0); g.fill();
  }
  photo = canvas.toDataURL('image/jpeg', 0.92).split(',')[1];
  photoArt = amberImage(canvas);
}

// The photo as a dithered amber monochrome image, like an old phosphor screen
function amberImage(source) {
  const c = document.createElement('canvas');
  c.width = c.height = W;
  const g = c.getContext('2d');
  g.drawImage(source, 0, 0, W, W);
  const img = g.getImageData(0, 0, W, W);
  const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  const tones = [[15, 13, 11], [61, 42, 18], [168, 116, 44], [255, 181, 71]];
  for (let i = 0; i < img.data.length; i += 4) {
    const x = (i / 4) % W, y = Math.floor(i / 4 / W);
    const lum = (img.data[i] * 0.3 + img.data[i + 1] * 0.59 + img.data[i + 2] * 0.11) / 255;
    const t = lum + (bayer[(y % 4) * 4 + (x % 4)] / 16 - 0.5) * 0.3;
    img.data.set(tones[Math.max(0, Math.min(3, Math.floor(t * 4)))], i);
  }
  g.putImageData(img, 0, 0);
  return c;
}

// ---------- Flow ----------
async function startCountdown() {
  const mine = ++session;
  dial = 0; dialShown = 0; choice = null; view = null; goQueued = false; lampsAt = null;
  go('countdown');
  for (countdown = 3; countdown > 0; countdown--) {
    await wait(1000);
    if (session !== mine) return;
  }
  capturePhoto();
  go('flash');
  await wait(1400);
  if (session !== mine) return;
  dialShown = dial;
  go('pick');
  if (goQueued && choice) startComic();
}

async function startComic() {
  const character = lineup[dial];
  const story = character[choice].story;
  progress = 0; progressTarget = 0; stage = 'starting';
  $('result-img').style.display = 'none';
  go('working');
  if (!$('real').checked) return demoRun(story);
  try {
    const res = await fetch('/api/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ photo, story, print: $('print').checked }),
    });
    const { id, error } = await res.json();
    if (!res.ok) throw new Error(error);
    status(`Real run: ${story}`);
    for (;;) {
      await wait(1500);
      const job = await (await fetch(`/api/jobs/${id}`)).json();
      if (job.stage === 'error') throw new Error(job.error);
      stage = job.stage;
      if (job.stage === 'done') {
        $('result-img').src = job.result.url;
        $('result-img').style.display = 'block';
        status(`Done: ${story}${job.result.print ? `\n${job.result.print}` : ''}`);
        return finish();
      }
    }
  } catch (err) {
    status(`Error: ${err.message}`);
    go('error');
  }
}

// Fake timeline so the screens can be tried without spending API calls
async function demoRun(story) {
  status(`Demo run (no API): ${story}`);
  for (const [s, ms] of [['describing', 3000], ['drawing', 9000], ['checking', 4000], ['printing', 3000]]) {
    stage = s;
    await wait(ms);
  }
  finish();
}

async function finish() {
  stage = 'done';
  while (progress < 0.999) await wait(50); // let the reveal finish before switching screens
  await wait(600);
  go('done');
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const status = (text) => ($('status').textContent = text);

// ---------- Drawing helpers ----------
function text(str, x, y, { size = 8, color = C.cream, align = 'center' } = {}) {
  led.font = `${size}px "Silkscreen"`;
  led.textAlign = align;
  led.textBaseline = 'middle';
  led.fillStyle = color;
  led.fillText(str, Math.round(x), Math.round(y));
}

// Slow 0..1 breathing, for lamps and prompts (no hard blinking)
const breathe = (t, period = 2400) => 0.5 - Math.cos((t % period) / period * Math.PI * 2) / 2;

function mix(a, b, k) {
  const pa = a.match(/\w\w/g).map((h) => parseInt(h, 16)), pb = b.match(/\w\w/g).map((h) => parseInt(h, 16));
  return `rgb(${pa.map((v, i) => Math.round(v + (pb[i] - v) * k)).join(',')})`;
}

// An indicator lamp: dim when off, amber with a soft halo when on (glow 0..1)
function lamp(x, y, r, glow, color = C.amber) {
  if (glow > 0) {
    // fades to transparent, so the glow never covers anything nearby
    const [r8, g8, b8] = color.slice(1).match(/\w\w/g).map((h) => parseInt(h, 16));
    const halo = led.createRadialGradient(x, y, r * 0.5, x, y, r * 2.4);
    halo.addColorStop(0, `rgba(${r8}, ${g8}, ${b8}, ${0.35 * glow})`);
    halo.addColorStop(1, `rgba(${r8}, ${g8}, ${b8}, 0)`);
    led.fillStyle = halo;
    led.beginPath(); led.arc(x, y, r * 2.4, 0, Math.PI * 2); led.fill();
  }
  // off = a dim version of the lamp's own color; on = full color
  led.fillStyle = mix(C.bg.slice(1), color.slice(1), 0.28 + 0.72 * glow);
  led.beginPath(); led.arc(x, y, r, 0, Math.PI * 2); led.fill();
  led.strokeStyle = C.rule; led.lineWidth = 1;
  led.beginPath(); led.arc(x, y, r + 1.5, 0, Math.PI * 2); led.stroke();
}

// A small key that turns a quarter turn and back, centered at (x, y)
function drawKey(x, y, t, color) {
  const phase = (t % 2400) / 2400;
  const turn = phase < 0.35 ? phase / 0.35 : phase < 0.6 ? 1 : phase < 0.8 ? 1 - (phase - 0.6) / 0.2 : 0;
  led.save();
  led.translate(Math.round(x), Math.round(y));
  led.rotate(turn * Math.PI / 2);
  led.strokeStyle = color; led.fillStyle = color; led.lineWidth = 1.5;
  led.beginPath(); led.arc(-3, 0, 2.5, 0, Math.PI * 2); led.stroke(); // bow
  led.fillRect(-0.5, -0.75, 6, 1.5);                                  // shaft
  led.fillRect(3, 0.5, 1.2, 2); led.fillRect(4.8, 0.5, 1.2, 1.5);     // teeth
  led.restore();
}

// A hand-switch lever on a base plate, pivoting at (x, y + 6): it pulls down, holds, and springs back up
// s scales the whole lever (1 = about 20 pixels tall)
function drawLever(x, y, t, s = 1) {
  const phase = (t % 1800) / 1800;
  const pull = phase < 0.4 ? phase / 0.4 : phase < 0.65 ? 1 : phase < 0.8 ? 1 - (phase - 0.65) / 0.15 : 0;
  const ease = 0.5 - Math.cos(pull * Math.PI) / 2;
  const px = x, py = y + 6 * s, len = 13 * s;
  led.fillStyle = C.rule; led.fillRect(Math.round(px - 10 * s), Math.round(py), Math.round(20 * s), Math.max(2, Math.round(3 * s))); // base plate
  const a = -Math.PI / 2 + ease * (Math.PI * 0.75);                                      // up -> down-forward
  const kx = px + Math.cos(a) * len, ky = py + Math.sin(a) * len;
  led.strokeStyle = C.cream; led.lineWidth = Math.max(1.5, 2 * s);
  led.beginPath(); led.moveTo(px, py); led.lineTo(kx, ky); led.stroke();                 // arm
  led.fillStyle = C.creamDim; led.beginPath(); led.arc(px, py, 2.5 * s, 0, Math.PI * 2); led.fill(); // pivot
  led.fillStyle = C.amber; led.beginPath(); led.arc(kx, ky, Math.max(2, 3 * s), 0, Math.PI * 2); led.fill(); // knob
}

// An analog panel meter: a scale arc with numbered ticks, a red needle, and the needle's pivot drawn as
// a grey/white knob with a notch (it stands for the physical dial: turning it swings the needle). pos 0..1
function drawMeter(cx, cy, radius, pos, labels) {
  const from = Math.PI * 1.17, to = Math.PI * 1.83;          // left end to right end of the arc (angles below horizontal)
  const angle = (p) => from + (to - from) * p;
  // scale arc with minor ticks, and major ticks + numbers at each dial position
  led.strokeStyle = C.creamDim; led.lineWidth = 1;
  led.beginPath(); led.arc(cx, cy, radius, from, to); led.stroke();
  const minor = (labels.length - 1) * 4;
  for (let i = 0; i <= minor; i++) {
    const a = angle(i / minor), major = i % 4 === 0, len = major ? 5 : 2;
    led.beginPath();
    led.moveTo(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius);
    led.lineTo(cx + Math.cos(a) * (radius - len), cy + Math.sin(a) * (radius - len));
    led.stroke();
    if (major) {
      const label = labels[i / 4];
      text(label, cx + Math.cos(a) * (radius + 7), cy + Math.sin(a) * (radius + 7), { color: C.creamDim });
    }
  }
  // red needle
  const a = angle(pos);
  led.strokeStyle = C.red; led.lineWidth = 1.5;
  led.beginPath(); led.moveTo(cx, cy); led.lineTo(cx + Math.cos(a) * (radius - 2), cy + Math.sin(a) * (radius - 2)); led.stroke();
  // the knob: grey/white circle with a darker rim and a notch pointing where the needle points
  led.fillStyle = '#d9d4ca'; led.beginPath(); led.arc(cx, cy, 6, 0, Math.PI * 2); led.fill();
  led.strokeStyle = '#7d776c'; led.lineWidth = 1; led.beginPath(); led.arc(cx, cy, 6.5, 0, Math.PI * 2); led.stroke();
  led.strokeStyle = '#4a453d'; led.lineWidth = 1.5;
  led.beginPath(); led.moveTo(cx + Math.cos(a) * 1.5, cy + Math.sin(a) * 1.5); led.lineTo(cx + Math.cos(a) * 5.5, cy + Math.sin(a) * 5.5); led.stroke();
}

// The panel itself: dark face, a thin engraved border and four screws
function panel() {
  led.fillStyle = C.bg;
  led.fillRect(0, 0, W, W);
  led.strokeStyle = C.rule; led.lineWidth = 1;
  led.strokeRect(4.5, 4.5, W - 9, W - 9);
  led.fillStyle = C.screw;
  for (const [x, y] of [[2, 2], [W - 4, 2], [2, W - 4], [W - 4, W - 4]]) led.fillRect(x, y, 2, 2);
}

// A radio-style tuning scale with tick marks and a sliding pointer (pos 0..1)
function scale(x, y, w, pos, ticks, labels = []) {
  led.fillStyle = C.rule;
  led.fillRect(x, y, w, 1);
  for (let i = 0; i < ticks; i++) {
    const tx = Math.round(x + (w * i) / (ticks - 1));
    const major = labels.length ? true : i % 5 === 0;
    led.fillRect(tx, y - (major ? 4 : 2), 1, major ? 4 : 2);
    if (labels[i]) text(labels[i], tx, y + 7, { color: C.creamDim });
  }
  const px = Math.round(x + w * pos);
  led.fillStyle = C.amber;
  led.fillRect(px - 1, y - 8, 2, 9);
}

// An arced tuning scale, like an old radio dial: ticks and numbers along a shallow arc, with an amber pointer (pos 0..1)
function arcScale(cx, top, halfWidth, sag, pos, labels) {
  const r = (halfWidth ** 2 + sag ** 2) / (2 * sag);   // circle through the two ends and the top
  const cy = top + r, span = Math.asin(halfWidth / r);
  const at = (p, rad) => {
    const a = -Math.PI / 2 - span + p * span * 2;
    return [cx + Math.cos(a) * rad, cy + Math.sin(a) * rad, a];
  };
  led.strokeStyle = C.rule; led.lineWidth = 1;
  led.beginPath(); led.arc(cx, cy, r, -Math.PI / 2 - span, -Math.PI / 2 + span); led.stroke();
  labels.forEach((label, i) => {
    const p = i / (labels.length - 1);
    const [x1, y1] = at(p, r), [x2, y2] = at(p, r - 4), [lx, ly] = at(p, r - 11);
    led.beginPath(); led.moveTo(x1, y1); led.lineTo(x2, y2); led.stroke();
    text(label, lx, ly, { color: C.creamDim });
  });
  const [px1, py1] = at(pos, r + 5), [px2, py2] = at(pos, r - 3);
  led.strokeStyle = C.amber; led.lineWidth = 2;
  led.beginPath(); led.moveTo(px1, py1); led.lineTo(px2, py2); led.stroke();
}

// ---------- Screens ----------
// Start screen logo: public/logo.png if present (a flat Scooby-Doo logo, ideally transparent PNG),
// shown in amber tones to match the panel. LOGO_IN_COLOR = true shows it in its own colors instead.
const LOGO_IN_COLOR = true;
const logo = new Image();
logo.src = '/logo.png';

function drawAttract(t) {
  panel();
  if (logo.complete && logo.naturalWidth) {
    const [bw, bh] = [160, 70];
    const s = Math.min(bw / logo.naturalWidth, bh / logo.naturalHeight);
    const w = logo.naturalWidth * s, h = logo.naturalHeight * s;
    led.save();
    if (!LOGO_IN_COLOR) led.filter = 'grayscale(1) sepia(1) saturate(2.6) hue-rotate(-8deg) brightness(1.05)';
    led.drawImage(logo, (W - w) / 2, 12 + (bh - h) / 2, w, h);
    led.restore();
  } else {
    text(COPY.title, W / 2, 26, { color: C.creamDim });
    led.fillStyle = C.rule; led.fillRect(56, 36, 80, 1);
  }
  // The van idles in the middle, with a gentle bob and a soft glow that breathes like the old lamp
  drawVan(W / 2, 128, 56, t, 0.25 + breathe(t) * 0.75);
  const startColor = mix(C.amberMid.slice(1), C.amber.slice(1), breathe(t));
  text(COPY.start, W / 2 + 7, 158, { color: startColor });
  led.font = '8px "Silkscreen"';
  drawKey(W / 2 + 7 - led.measureText(COPY.start).width / 2 - 9, 158, t, C.amber);
}

function drawCountdown(t, elapsed) {
  panel();
  text(COPY.look, W / 2, 24, { color: C.creamDim });
  // ring of ticks that empties over each second
  const left = 1 - (elapsed % 1000) / 1000;
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2 - Math.PI / 2;
    led.fillStyle = i / 24 < left ? C.amber : C.amberDim;
    led.fillRect(Math.round(W / 2 + Math.cos(a) * 52) - 1, Math.round(104 + Math.sin(a) * 52) - 1, 3, 3);
  }
  text(String(countdown), W / 2, 106, { size: 48, color: C.amber });
}

function drawFlash(t, elapsed) {
  panel();
  if (elapsed < 400) {
    led.fillStyle = mix('fff3dc', C.bg.slice(1), elapsed / 400);
    led.fillRect(0, 0, W, W);
    return;
  }
  lamp(W / 2, 86, 10, 1);
  text(COPY.taken, W / 2, 130, { color: C.cream });
}

// The 1969 gang picture in a window: dark, with a flashlight spotlight on the selected character.
// The view glides and zooms toward them as the dial turns. Focus points live in lineup.json (scene pixels).
const ZOOM = 1.9;                 // how close the view is, relative to fitting the whole picture
const spot = document.createElement('canvas');
function drawScene(wx, wy, ww, wh, c, dt) {
  if (!scene?.complete || !scene.naturalWidth) return;
  const target = c.focus || { x: scene.naturalWidth / 2, y: scene.naturalHeight / 2, r: 40 };
  view ??= { ...target };
  const k = Math.min(1, dt / 160);
  for (const key of ['x', 'y', 'r']) view[key] += (target[key] - view[key]) * k;

  // Camera: zoomed in around the spotlight, without showing past the picture's edges
  const s = (ww / scene.naturalWidth) * ZOOM;
  const vw = ww / s, vh = wh / s;
  const sx = Math.max(0, Math.min(scene.naturalWidth - vw, view.x - vw / 2));
  const sy = Math.max(0, Math.min(scene.naturalHeight - vh, view.y - vh / 2));
  led.save();
  led.beginPath(); led.rect(wx, wy, ww, wh); led.clip();
  led.filter = 'saturate(0.6) sepia(0.15)';
  led.drawImage(scene, sx, sy, vw, vh, wx, wy, ww, wh);
  led.restore();

  // Darken everything outside the spotlight circle
  const cx = wx + (view.x - sx) * s, cy = wy + (view.y - sy) * s, cr = view.r * s;
  spot.width = ww; spot.height = wh;
  const g = spot.getContext('2d');
  g.fillStyle = 'rgba(8, 6, 4, 0.78)';
  g.fillRect(0, 0, ww, wh);
  g.globalCompositeOperation = 'destination-out';
  const beam = g.createRadialGradient(cx - wx, cy - wy, cr * 0.75, cx - wx, cy - wy, cr);
  beam.addColorStop(0, 'rgba(0,0,0,1)');
  beam.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = beam;
  g.beginPath(); g.arc(cx - wx, cy - wy, cr, 0, Math.PI * 2); g.fill();
  led.drawImage(spot, wx, wy);
  led.strokeStyle = C.rule; led.lineWidth = 1;
  led.strokeRect(wx - 0.5, wy - 0.5, ww + 1, wh + 1);
}

function drawPick(t, elapsed, dt) {
  panel();
  const c = lineup[dial];
  drawScene(10, 10, 172, 92, c, dt);
  text(c.name.toUpperCase(), W / 2, 114, { color: C.cream });

  // Arced tuning scale showing the dial position (the pointer glides to it)
  dialShown += (dial - dialShown) * Math.min(1, dt / 120);
  drawMeter(W / 2, 161, 27, dialShown / Math.max(1, lineup.length - 1), lineup.map((_, i) => String(i + 1)));

  // Two choices as lamps, left and right (no labels; the hardware buttons decide what they mean)
  // Left = big red button, right = big blue button (matching the physical buttons). They fade in after
  // LAMPS_AFTER (or right away if a button is pressed), so guests pick a character first
  if (lampsAt === null && elapsed > LAMPS_AFTER) lampsAt = t;
  const lampsShown = lampsAt === null ? 0 : Math.min(1, (t - lampsAt) / 500);
  if (lampsShown > 0) {
    led.globalAlpha = lampsShown;
    lamp(144, 156, 8, choice === 'a' ? 1 : 0.15 + breathe(t, 2000) * (choice ? 0 : 0.25), C.blue);
    lamp(48, 156, 8, choice === 'b' ? 1 : 0.15 + breathe(t + 1000, 2000) * (choice ? 0 : 0.25), C.redBtn);
    led.globalAlpha = 1;
  }

  // One step at a time: turn the dial, then choose a button, then flip the lever
  const hint = choice ? COPY.go : lampsAt !== null ? COPY.choose : COPY.dial;
  const hintY = 177;
  if (choice && SHOW_LEVER) {
    // 'FLIP THE LEVER' with a small animated lever to its left
    text(hint, W / 2 + 9, hintY, { color: mix(C.amberMid.slice(1), C.amber.slice(1), breathe(t, 1600)) });
    led.font = '8px "Silkscreen"';
    drawLever(W / 2 + 9 - led.measureText(hint).width / 2 - 14, hintY - 7, t, 0.75);
  } else {
    text(hint, W / 2, hintY, { color: choice ? mix(C.amberMid.slice(1), C.amber.slice(1), breathe(t, 1600)) : C.creamDim });
  }
}
// The animated lever icon next to "FLIP THE LEVER" is off for now; set to true to bring it back
const SHOW_LEVER = false;

function drawWorking(t, elapsed, dt) {
  // A target creeps toward 95% while waiting and is nudged up by each stage; the shown progress glides
  // toward it at a capped speed, so a stage change never makes the picture or the walkers jump.
  const floors = { starting: 0, describing: 0.04, drawing: 0.12, checking: 0.7, redrawing: 0.75, printing: 0.9, done: 1 };
  const creep = $('real').checked ? 0.03 : 0.1;
  progressTarget = stage === 'done' ? 1
    : Math.min(0.95, Math.max(progressTarget + (0.95 - progressTarget) * creep * dt / 1000, floors[stage] ?? 0));
  const maxSpeed = stage === 'done' ? 0.5 : 0.06; // fraction of the bar per second
  progress = Math.min(progressTarget, progress + maxSpeed * dt / 1000);

  panel();
  // The guest's photo slowly scans in from the top, like an old screen warming up
  const [ix, iy, iw, ih] = [12, 12, 168, 124];
  led.strokeStyle = C.rule; led.lineWidth = 1;
  led.strokeRect(ix - 0.5, iy - 0.5, iw + 1, ih + 1);
  if (photoArt) {
    const rows = Math.round(ih * progress);
    // Same scale as the photo (no squashing), centered vertically
    if (rows > 0) led.drawImage(photoArt, 12, 12 + (168 - ih) / 2, iw, rows, ix, iy, iw, rows);
    if (rows < ih) { led.fillStyle = C.amber; led.fillRect(ix, iy + rows, iw, 1); } // the scanning line
  }
  text(STAGE_WORDS[stage] || 'WORKING', W / 2, 146, { color: C.creamDim });
  if (walkFrames.length) drawWalkRoad(t, progress);
  else drawVanRoad(t, progress);
}

// The gang walking along the road, from public/walk-sheet.png (an 8x6 grid of 48 frames, 12 fps, white background).
// The white background is removed once at load by flood-filling from each frame's edges, so whites inside
// the characters (eyes, collar tag) stay white.
const WALK = { src: '/walk-sheet.png', cols: 8, rows: 6, fps: 12, height: 26 };
const walkFrames = [];
const walkSheet = new Image();
walkSheet.onload = () => {
  const fw = walkSheet.naturalWidth / WALK.cols, fh = walkSheet.naturalHeight / WALK.rows;
  for (let i = 0; i < WALK.cols * WALK.rows; i++) {
    const c = document.createElement('canvas');
    c.width = fw; c.height = fh;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(walkSheet, (i % WALK.cols) * fw, Math.floor(i / WALK.cols) * fh, fw, fh, 0, 0, fw, fh);
    clearEdgeWhite(g, fw, fh);
    walkFrames.push(c);
  }
};
walkSheet.src = WALK.src;

// Makes the background transparent: every white area that touches the frame's edge, plus any enclosed
// white area bigger than a few pixels (gaps between legs). Small whites (eyes, tags) are kept.
function clearEdgeWhite(g, w, h) {
  const img = g.getImageData(0, 0, w, h), d = img.data;
  const isWhite = (p) => d[p * 4] > 225 && d[p * 4 + 1] > 225 && d[p * 4 + 2] > 225;
  const seen = new Uint8Array(w * h);
  const MAX_KEPT = Math.round(w * h * 0.004); // enclosed white areas up to this size stay
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || !isWhite(start)) continue;
    const region = [], stack = [start];
    let touchesEdge = false;
    seen[start] = 1;
    while (stack.length) {
      const p = stack.pop(), x = p % w, y = (p - x) / w;
      region.push(p);
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touchesEdge = true;
      for (const q of [x > 0 && p - 1, x < w - 1 && p + 1, y > 0 && p - w, y < h - 1 && p + w]) {
        if (q !== false && !seen[q] && isWhite(q)) { seen[q] = 1; stack.push(q); }
      }
    }
    if (touchesEdge || region.length > MAX_KEPT) for (const p of region) d[p * 4 + 3] = 0;
  }
  g.putImageData(img, 0, 0);
}

function drawWalkRoad(t, p) {
  const roadY = 184;
  const frame = walkFrames[Math.floor((t / 1000) * WALK.fps) % walkFrames.length];
  const h = WALK.height, w = Math.round(h * (frame.width / frame.height));
  const x = Math.round(10 + p * (W - 20 - w));
  led.save();
  led.filter = 'saturate(0.85)';
  led.drawImage(frame, x, roadY - h + 2, w, h);
  led.restore();
}

// The Mystery Machine drives along a road at the bottom, left to right as the comic progresses
const van = new Image();
van.src = '/mystery-machine.png';

// The van centered at (cx, bottom), w pixels wide, with a 1-pixel idle bob and a warm glow (0..1) under it
function drawVan(cx, bottom, w, t, glow) {
  if (!van.complete || !van.naturalWidth) return lamp(cx, bottom - 12, 10, glow);
  const h = Math.round(w * (van.naturalHeight / van.naturalWidth));
  // Soft glow that fades to transparent, so it never covers anything drawn above it (like the logo)
  const r = w * 0.8;
  const halo = led.createRadialGradient(cx, bottom - h / 2, 4, cx, bottom - h / 2, r);
  halo.addColorStop(0, `rgba(255, 181, 71, ${0.22 * glow})`);
  halo.addColorStop(1, 'rgba(255, 181, 71, 0)');
  led.fillStyle = halo;
  led.beginPath(); led.arc(cx, bottom - h / 2, r, 0, Math.PI * 2); led.fill();
  led.fillStyle = C.rule;
  led.fillRect(Math.round(cx - w * 0.6), bottom + 1, Math.round(w * 1.2), 1); // a bit of road
  const bob = Math.floor(t / 400) % 2;
  led.save();
  led.filter = 'saturate(0.8)';
  led.drawImage(van, Math.round(cx - w / 2), bottom - h + 3 - bob, w, h);
  led.restore();
}
function drawVanRoad(t, p) {
  const roadY = 184, vw = 40;
  // road: a solid line with dashes scrolling under the van
  led.fillStyle = C.rule;
  led.fillRect(10, roadY, W - 20, 1);
  const scroll = Math.floor(t / 40) % 8;
  for (let x = 10 - scroll; x < W - 10; x += 8) if (x >= 10) led.fillRect(x, roadY + 3, 4, 1);
  if (!van.complete || !van.naturalWidth) return;
  const vh = Math.round(vw * (van.naturalHeight / van.naturalWidth));
  const x = Math.round(10 + p * (W - 20 - vw));
  const bob = Math.floor(t / 120) % 2; // 1-pixel bounce, like driving on a bumpy road
  // a few dust puffs behind the van
  led.fillStyle = C.creamDim;
  for (let i = 0; i < 3; i++) {
    const age = ((t / 300 + i / 3) % 1);
    if (x - 4 - age * 10 > 10) led.fillRect(Math.round(x - 4 - age * 10), roadY - 3 - Math.round(age * 4), 2, 2);
  }
  led.save();
  led.filter = 'saturate(0.8)';
  led.drawImage(van, x, roadY - vh + 3 - bob, vw, vh);
  led.restore();
}

function drawDone(t) {
  panel();
  drawVan(W / 2, 95, 64, t, 1);
  text(COPY.done1, W / 2, 119, { color: C.cream });
  text(COPY.done2, W / 2, 137, { color: mix(C.amberMid.slice(1), C.amber.slice(1), breathe(t)) });
}

function drawError(t) {
  panel();
  lamp(W / 2, 70, 10, 0.4 + breathe(t, 1200) * 0.6, C.red);
  text(COPY.error1, W / 2, 114, { color: C.cream });
  text(COPY.error2, W / 2, 132, { color: C.creamDim });
}

// ---------- Main loop ----------
let last = performance.now();
function frame(now) {
  const dt = now - last; last = now;
  const elapsed = now - stateAt;
  // These timings are the booth's: the Mega follows them (it's reset whenever this screen returns to the start)
  if (state === 'pick' && now - lastInput > IDLE_TIMEOUT) endSession();
  if (state === 'done' && elapsed > DONE_TIME) endSession();
  if (state === 'error' && elapsed > ERROR_TIME) endSession();

  led.imageSmoothingEnabled = true;
  try {
    ({ attract: drawAttract, countdown: drawCountdown, flash: drawFlash, pick: drawPick, working: drawWorking, done: drawDone, error: drawError })[state](now, elapsed, dt);
  } catch (err) {
    // Never let a drawing bug freeze the panel: show it and fall back to the start screen
    console.error(err);
    status(`Screen error on "${state}": ${err.message}`);
    go('attract');
  }
  present();
  requestAnimationFrame(frame);
}

// Scaled-up preview with an optional LED dot grid
let mask = null;
function present() {
  const size = $('display').width, px = size / W;
  display.imageSmoothingEnabled = false;
  display.drawImage($('led'), 0, 0, size, size);
  if (!$('dots').checked) return;
  if (!mask) {
    mask = document.createElement('canvas');
    mask.width = mask.height = size;
    const g = mask.getContext('2d');
    g.fillStyle = '#000';
    g.fillRect(0, 0, size, size);
    g.globalCompositeOperation = 'destination-out';
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
      g.beginPath();
      g.arc(x * px + px / 2, y * px + px / 2, px * 0.42, 0, Math.PI * 2);
      g.fill();
    }
  }
  display.drawImage(mask, 0, 0);
}

// ---------- Streaming to the Pi ----------
// Sends the 192x192 canvas to the server ~20 times a second; the server forwards it to the Pi.
let sending = false;
setInterval(() => {
  if (!$('stream').checked || sending) return;
  sending = true;
  $('led').toBlob((blob) => {
    fetch('/api/led/frame', { method: 'POST', body: blob }).catch(() => {}).finally(() => (sending = false));
  }, 'image/jpeg', 0.9);
}, 50);

setInterval(async () => {
  try {
    const { displays, port, addresses } = await (await fetch('/api/led/status')).json();
    $('led-status').textContent = displays
      ? `LED panel connected (${displays})`
      : `No LED panel connected. On the Pi: sudo python3 ~/displayer.py --host <${addresses.join(' or ')}> --port ${port}`;
  } catch {}
}, 2000);

// ---------- Hardware (the Arduino Mega, through the server) ----------
// The Mega's key, dial, buttons and lever arrive as the same actions as the keyboard
const hardware = new EventSource('/api/booth/events');
hardware.onmessage = (e) => input(JSON.parse(e.data).action);

// What this screen is showing, a few times a second. The server turns it into Mega commands:
// the progress fills the LED strip, "done" flashes it, and going back to the start resets the Mega.
setInterval(() => {
  const track = camera?.getVideoTracks()[0];
  fetch('/api/booth/state', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      state, progress: Math.round(progress * 100), stage, real: $('real').checked, print: $('print').checked,
      camera: track?.readyState === 'live' ? track.label || 'Camera' : null,
      timing: { idle: IDLE_TIMEOUT / 1000, done: DONE_TIME / 1000, error: ERROR_TIME / 1000 },
    }),
  }).catch(() => {});
}, 250);

setInterval(async () => {
  try {
    const { mega } = await (await fetch('/api/connections')).json();
    $('mega-status').textContent = mega.link === 'connected' ? `Mega connected (${mega.port})`
      : mega.link === 'off' ? 'Mega off (MEGA_PORT=off)' : `No Mega: ${mega.error || 'looking for it'}`;
  } catch {}
}, 3000);

// The mode checkboxes are remembered on this computer, so the booth comes back up the way it was left
for (const id of ['real', 'print', 'dots', 'stream']) {
  try {
    const saved = localStorage.getItem(`led-${id}`);
    if (saved !== null) $(id).checked = saved === 'true';
  } catch {}
  $(id).addEventListener('change', () => { try { localStorage.setItem(`led-${id}`, $(id).checked); } catch {} });
}

// ---------- Start ----------
const setup = await (await fetch('/api/lineup')).json();
lineup = Array.isArray(setup) ? setup : setup.characters; // older servers send just the list
scene = new Image();
scene.src = `/${setup.scene || 'gang.jpg'}`;
await Promise.all(['8px "Silkscreen"', '48px "Silkscreen"'].map((f) => document.fonts.load(f)));
requestAnimationFrame(frame);
