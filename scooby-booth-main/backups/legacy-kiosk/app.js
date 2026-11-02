const $ = (id) => document.getElementById(id);
const RESULT_TIMEOUT = 120_000; // return to the start screen after 2 minutes on the result
const STAGES = {
  starting: ['Opening the case file...', 'Hang tight.'],
  describing: ['Studying your mug shot...', 'Our artist is taking notes.'],
  drawing: ['Inking your comic...', 'This takes about a minute.'],
  checking: ['Checking it really looks like you...', 'Almost there.'],
  redrawing: ['Redrawing a few panels...', 'The artist wants to get you just right.'],
};

let quiz, chosenStory = null, stream, resultTimer;
const forcedStory = new URLSearchParams(location.search).get('story'); // e.g. ?story=velma for testing

function show(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
  if (id === 'start') reset();
  if (id === 'pick') renderCharacters();
  if (id === 'camera') startCamera();
}

function reset() {
  chosenStory = null;
  clearTimeout(resultTimer);
  stopCamera();
}

// --- Step 1: pick a character (portraits live in /characters/<id>.png) ---
async function renderCharacters() {
  quiz ??= await (await fetch('/api/quiz')).json();
  $('pick-title').textContent = quiz.title;
  $('characters').replaceChildren(...quiz.characters.map((c) => {
    const b = document.createElement('button');
    b.className = 'character';
    const img = document.createElement('img');
    img.src = `/characters/${c.id}.png`;
    img.alt = '';
    img.onerror = () => img.remove(); // no portrait yet: show the name only
    const name = document.createElement('span');
    name.textContent = c.name;
    b.append(img, name);
    b.onclick = () => renderQuestion(c);
    return b;
  }));
}

// --- Step 2: pick that character's scenario ---
function renderQuestion(character) {
  $('quiz-portrait').hidden = false;
  $('quiz-portrait').src = `/characters/${character.id}.png`;
  $('quiz-portrait').onerror = () => ($('quiz-portrait').hidden = true);
  $('quiz-question').textContent = character.question;
  $('quiz-answers').replaceChildren(...character.answers.map((a) => {
    const b = document.createElement('button');
    b.textContent = a.text;
    b.onclick = () => {
      chosenStory = a.story;
      show('camera');
    };
    return b;
  }));
  show('quiz');
}

// --- Camera ---
async function startCamera() {
  $('snap').disabled = false;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1920, height: 1080, facingMode: 'user' } });
    $('video').srcObject = stream;
  } catch (err) {
    fail(`Couldn't open the camera: ${err.message}`);
  }
}

function stopCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
}

// Grabs a square crop from the center of the video (matches the viewfinder), unmirrored
function capture() {
  const v = $('video');
  const side = Math.min(v.videoWidth, v.videoHeight);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = Math.min(side, 1024);
  canvas.getContext('2d').drawImage(v, (v.videoWidth - side) / 2, (v.videoHeight - side) / 2, side, side, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.92).split(',')[1];
}

$('snap').onclick = async () => {
  $('snap').disabled = true;
  for (const n of [3, 2, 1]) {
    $('countdown').textContent = n;
    await new Promise((r) => setTimeout(r, 1000));
  }
  $('countdown').textContent = '';
  $('video').parentElement.classList.add('flash');
  const photo = capture();
  setTimeout(() => $('video').parentElement.classList.remove('flash'), 400);
  stopCamera();
  create(photo);
};

// --- Generate ---
async function create(photo) {
  show('working');
  setStage('starting');
  try {
    const res = await fetch('/api/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ photo, story: forcedStory || chosenStory }),
    });
    const { id, story, error } = await res.json();
    if (!res.ok) throw new Error(error);
    $('result-title').textContent = story;
    poll(id);
  } catch (err) {
    fail(err.message);
  }
}

function setStage(stage) {
  const [title, sub] = STAGES[stage] || STAGES.drawing;
  $('working-title').textContent = title;
  $('working-sub').textContent = sub;
}

async function poll(id) {
  try {
    const job = await (await fetch(`/api/jobs/${id}`)).json();
    if (job.stage === 'error') return fail(job.error);
    if (job.stage === 'done') return showResult(job.result);
    setStage(job.stage);
    setTimeout(() => poll(id), 1500);
  } catch (err) {
    fail(err.message);
  }
}

function showResult({ url }) {
  $('comic').src = url;
  show('result');
  resultTimer = setTimeout(() => show('start'), RESULT_TIMEOUT);
}

function fail(message) {
  $('error-message').textContent = message;
  show('error');
}

document.querySelectorAll('[data-go]').forEach((b) => (b.onclick = () => show(b.dataset.go)));
