import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createComic, loadStories, listRuns, readRunLog, FORMATS } from './lib/pipeline.js';
import { IMAGE_MODEL, TEXT_MODEL } from './lib/gemini.js';
import { listPrinters, printCard } from './lib/printer.js';
import { mega, send as megaSend, reconnect as megaReconnect, megaStatus, startMega } from './lib/mega.js';

const PORT = process.env.PORT || 3001;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
};
const CARD_BACK = 'references/card-back.png';
const jobs = new Map(); // jobId -> { stage, attempt, result, error, log }
let lastJob = null;     // the most recent comic, for the Connections page
// After the card is sent to the printer, the booth keeps saying "PRINTING" this long before "TAKE YOUR CARD"
// (and the Mega's DONE flash), so the card is actually out when we say so
const PRINT_DONE_DELAY = Number(process.env.PRINT_DONE_DELAY ?? 10) * 1000;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Files the admin page may read and write
const EDITABLE = /^(prompts\/[\w-]+\.md|stories\/[\w-]+\.md|lineup\.json)$/;
async function listEditable() {
  const md = async (dir) => (await readdir(dir)).filter((f) => f.endsWith('.md')).map((f) => `${dir}/${f}`);
  return [...(await md('prompts')), ...(await md('stories')), 'lineup.json'];
}

// lineup.json: the 5 dial positions, each with an A and a B story (and a short label for the LED)
const loadLineup = async () => JSON.parse(await readFile('lineup.json', 'utf8')).characters;

async function validateLineup(content) {
  let characters;
  try { characters = JSON.parse(content).characters; } catch (err) { return `lineup.json is not valid JSON: ${err.message}`; }
  if (!Array.isArray(characters)) return 'lineup.json needs a "characters" list';
  const ids = new Set((await loadStories()).map((s) => s.id));
  const missing = characters.flatMap((c) => [c.a?.story, c.b?.story]).filter((id) => !ids.has(id));
  return missing.length ? `lineup.json points at stories that don't exist: ${missing.join(', ')}` : null;
}

const send = (res, status, body, type = 'application/json') => {
  res.writeHead(status, { 'Content-Type': type });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// ---------- LED panel stream ----------
// The Pi runs the streamer repo's displayer/main.py --host <this PC>, which connects here and reads
// frames as [uint32 big-endian length][JPEG bytes]. The /led page renders the 192x192 screen and posts each frame.
const LED_PORT = Number(process.env.LED_PORT || 9002);
const ledClients = new Set();
let ledFrame = null, ledFrameAt = null;

function sendLedFrame(socket, jpeg) {
  if (socket.writableLength > 256 * 1024) return; // the Pi is behind; drop frames rather than queue them
  const header = Buffer.alloc(4);
  header.writeUInt32BE(jpeg.length);
  socket.write(Buffer.concat([header, jpeg]));
}

net.createServer((socket) => {
  socket.setNoDelay(true);
  ledClients.add(socket);
  console.log(`LED display connected from ${socket.remoteAddress}`);
  if (ledFrame) sendLedFrame(socket, ledFrame);
  socket.on('close', () => { ledClients.delete(socket); console.log('LED display disconnected'); });
  socket.on('error', () => {});
}).listen(LED_PORT, '0.0.0.0');

const localAddresses = () => Object.values(os.networkInterfaces()).flat()
  .filter((a) => a.family === 'IPv4' && !a.internal).map((a) => a.address);

// ---------- Booth screen <-> Mega ----------
// The /led page runs the guest flow. The Mega's controls arrive here and are passed to the page as the same
// actions the keyboard makes; the page reports its screen and progress back, which become Mega commands.
// The page's timing is the one that counts: when its screen goes back to the start, the Mega is reset to match.
const BUTTONS = { BLUE: 'a', RED: 'b' };   // which physical button picks story A / B
const boothClients = new Set();            // open /led pages listening for hardware actions
let booth = null;                          // what the booth screen last reported: { state, progress, camera, timing, at }
let lastPrint = null;

function toBooth(action) {
  for (const res of boothClients) res.write(`data: ${JSON.stringify({ action })}\n\n`);
}

mega.on('event', (name, args) => {
  if (name === 'START') toBooth('photo');
  if (name === 'CHAR') toBooth(`dial${args[0]}`);
  if (name === 'MODE' && BUTTONS[args[0]]) { toBooth(`dial${args[1]}`); toBooth(BUTTONS[args[0]]); }
  if (name === 'PRINT') toBooth('go');
  // The Mega went back to idle on its own (restarted, or the app had gone quiet): end any unfinished session
  if (name === 'READY' || name === 'IDLE' || name === 'TIMEOUT') toBooth('idle');
});

function boothReport(report) {
  const before = booth?.state;
  booth = { ...report, at: Date.now() };
  if (report.state !== before) {
    if (report.state === 'done') megaSend('DONE');
    if (report.state === 'attract' || report.state === 'error') megaSend('RESET');
  }
  if (report.state === 'working' && report.progress !== lastProgress) megaSend(`PROGRESS:${report.progress}`);
  lastProgress = report.state === 'working' ? report.progress : null;
}
let lastProgress = null;

// Printer list for the Connections page (asking Windows takes a second, so it's cached)
let printerCache = { at: 0, list: [] };
async function printers() {
  if (Date.now() - printerCache.at > 30_000) printerCache = { at: Date.now(), list: await listPrinters().catch(() => []) };
  return printerCache.list;
}

async function connections() {
  const printerName = process.env.PRINTER_NAME || '';
  const installed = await printers();
  return {
    now: Date.now(),
    booth: booth && { ...booth, open: boothClients.size, fresh: Date.now() - booth.at < 3000 },
    mega: megaStatus(),
    led: { displays: [...ledClients].map((s) => s.remoteAddress?.replace(/^::ffff:/, '')), port: LED_PORT, addresses: localAddresses(), lastFrame: ledFrameAt },
    printer: { name: printerName || '(Windows default)', installed: printerName ? installed.includes(printerName) : installed.length > 0, last: lastPrint, doneDelay: PRINT_DONE_DELAY / 1000 },
    gemini: { key: !!process.env.GEMINI_API_KEY, imageModel: IMAGE_MODEL, textModel: TEXT_MODEL,
      lastJob: lastJob && { story: lastJob.story, stage: lastJob.stage, error: lastJob.error, startedAt: lastJob.startedAt, endedAt: lastJob.endedAt } },
  };
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return JSON.parse(body);
}

// Serves a file from inside `root` only (no ../ escapes)
async function serveFile(res, root, urlPath) {
  const file = path.resolve(root, '.' + decodeURIComponent(urlPath));
  const type = TYPES[path.extname(file)];
  if (!file.startsWith(path.resolve(root)) || !type) return send(res, 404, { error: 'Not found' });
  try {
    send(res, 200, await readFile(file), type);
  } catch {
    send(res, 404, { error: 'Not found' });
  }
}

const randomItem = (list) => list[Math.floor(Math.random() * list.length)];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'POST' && url.pathname === '/api/create') {
      const { photo, story: storyId, maxAttempts, base, format, print, printer } = await readJson(req);
      if (!photo) return send(res, 400, { error: 'Photo is required' });
      const stories = await loadStories();
      // Unknown or missing story ids fall back to a random story
      const story = stories.find((s) => s.id === storyId) || randomItem(stories);
      const id = randomUUID();
      const job = { stage: 'starting', story: story.title, startedAt: Date.now() };
      jobs.set(id, job);
      lastJob = job;
      createComic({
        photo,
        story,
        // Admin can test another base prompt (prompts/base-*.md); the kiosk always uses base.md
        base: /^base(-[\w-]+)?$/.test(base || '') ? base : undefined,
        // Admin can test either shape; the kiosk uses COMIC_FORMAT from .env
        format: FORMATS[format] ? format : undefined,
        maxAttempts: maxAttempts ? Math.min(Math.max(Number(maxAttempts), 1), 2) : undefined,
        onStage: (stage, attempt) => Object.assign(job, { stage, attempt }),
        onLog: (log) => (job.log = log),
      })
        .then(async (result) => {
          // Optional: send the finished comic straight to the card printer, like the booth will
          if (print) {
            Object.assign(job, { stage: 'printing' });
            const image = path.join('outputs', result.url.replace(/^\/outputs\//, ''));
            const outFile = /print to pdf/i.test(printer || '') ? image.replace(/\.(jpg|png)$/, '-card.pdf') : undefined;
            result.print = await printCard(image, { printer: printer || undefined, outFile })
              .then((msg) => (outFile ? `Saved ${outFile}` : msg), (err) => `Print failed: ${err.message}`);
            lastPrint = { at: Date.now(), message: result.print };
            if (!outFile) await wait(PRINT_DONE_DELAY);
          }
          Object.assign(job, { stage: 'done', result, endedAt: Date.now() });
        })
        .catch((err) => {
          console.error(err);
          Object.assign(job, { stage: 'error', error: err.message, endedAt: Date.now() });
        });
      return send(res, 200, { id, story: story.title });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/jobs/')) {
      const job = jobs.get(url.pathname.split('/').pop());
      return job ? send(res, 200, job) : send(res, 404, { error: 'Job not found' });
    }
    // --- Admin ---
    if (url.pathname === '/api/admin/files' && req.method === 'GET') {
      return send(res, 200, await listEditable());
    }
    if (url.pathname === '/api/admin/file') {
      const file = url.searchParams.get('path') || '';
      if (!EDITABLE.test(file)) return send(res, 400, { error: 'That file is not editable' });
      if (req.method === 'GET') return send(res, 200, { content: await readFile(file, 'utf8') });
      if (req.method === 'PUT') {
        const { content } = await readJson(req);
        if (file === 'lineup.json') {
          const problem = await validateLineup(content);
          if (problem) return send(res, 400, { error: problem });
        }
        await writeFile(file, content);
        return send(res, 200, { ok: true });
      }
    }
    if (url.pathname === '/api/admin/printers' && req.method === 'GET') {
      return send(res, 200, { printers: await listPrinters(), default: process.env.PRINTER_NAME || '' });
    }
    if (url.pathname === '/api/admin/print' && req.method === 'POST') {
      const { run, file, printer } = await readJson(req);
      // Only comic images inside a run folder can be printed
      const image = path.join('outputs', path.basename(run || ''), path.basename(file || ''));
      if (!/^comic-\d+\.(jpg|png)$/.test(path.basename(file || ''))) return send(res, 400, { error: 'Not a comic image' });
      // The PDF printer would pop up a save dialog, so test prints go straight into the run folder
      const outFile = /print to pdf/i.test(printer || '') ? image.replace(/\.(jpg|png)$/, '-card.pdf') : undefined;
      const message = await printCard(image, { printer: printer || undefined, outFile });
      return send(res, 200, { message: outFile ? `Saved ${outFile}` : message });
    }
    // The card back is one static design, references/card-back.png, printed as its own job (the printer is single-sided)
    if (url.pathname === '/api/admin/card-back') {
      if (req.method === 'GET') {
        return readFile(CARD_BACK).then((data) => send(res, 200, data, 'image/png'), () => send(res, 404, { error: 'No card back uploaded yet' }));
      }
      if (req.method === 'PUT') {
        const { image } = await readJson(req);
        if (!image) return send(res, 400, { error: 'No image' });
        await writeFile(CARD_BACK, Buffer.from(image, 'base64'));
        return send(res, 200, { ok: true });
      }
    }
    if (url.pathname === '/api/admin/print-back' && req.method === 'POST') {
      const { printer, rotate180, copies } = await readJson(req);
      const count = Math.min(100, Math.max(1, Math.floor(Number(copies) || 1)));
      const exists = await readFile(CARD_BACK).then(() => true, () => false);
      if (!exists) return send(res, 400, { error: 'Upload a card back design first' });
      const outFile = /print to pdf/i.test(printer || '') ? 'outputs/card-back-test.pdf' : undefined;
      const message = await printCard(CARD_BACK, { printer: printer || undefined, rotate180: !!rotate180, copies: count, outFile });
      return send(res, 200, { message: outFile ? `Saved ${outFile}` : message });
    }
    if (url.pathname === '/api/admin/info' && req.method === 'GET') {
      return send(res, 200, { imageModel: IMAGE_MODEL, textModel: TEXT_MODEL, maxAttempts: Number(process.env.MAX_ATTEMPTS || 2) });
    }
    if (url.pathname === '/api/admin/stories' && req.method === 'GET') {
      // Stories grouped the way the booth sees them: dial position, then button A or B
      const [stories, lineup] = await Promise.all([loadStories(), loadLineup().catch(() => [])]);
      const groups = lineup.map((c) => ({
        name: `${c.dial} · ${c.name}`,
        stories: ['a', 'b'].map((k) => c[k] && { ...stories.find((s) => s.id === c[k].story), button: k.toUpperCase(), label: c[k].label })
          .filter((s) => s?.id),
      }));
      const used = new Set(groups.flatMap((g) => g.stories.map((s) => s.id)));
      const unused = stories.filter((s) => !used.has(s.id));
      if (unused.length) groups.push({ name: 'Not on the dial', stories: unused });
      return send(res, 200, groups.map((g) => ({ ...g, stories: g.stories.map(({ id, title, button, label }) => ({ id, title, button, label })) })));
    }
    if (url.pathname === '/api/admin/runs' && req.method === 'GET') {
      return send(res, 200, await listRuns());
    }
    if (url.pathname.startsWith('/api/admin/runs/') && req.method === 'GET') {
      return send(res, 200, await readRunLog(url.pathname.split('/').pop()));
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/admin')) {
      return serveFile(res, 'public', '/admin.html');
    }
    if (req.method === 'GET' && url.pathname === '/connections') {
      return serveFile(res, 'public', '/connections.html');
    }
    if (req.method === 'GET' && url.pathname === '/api/connections') {
      return send(res, 200, await connections());
    }
    if (req.method === 'POST' && url.pathname === '/api/mega/send') {
      const { cmd } = await readJson(req);
      if (!/^!?[\w: -]{1,40}$/.test(cmd || '')) return send(res, 400, { error: 'Not a valid command' });
      return send(res, 200, { ok: await megaSend(cmd) });
    }
    if (req.method === 'POST' && url.pathname === '/api/mega/reconnect') {
      megaReconnect();
      return send(res, 200, { ok: true });
    }
    // The booth screen listens here for the Mega's controls...
    if (req.method === 'GET' && url.pathname === '/api/booth/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': connected\n\n');
      boothClients.add(res);
      req.on('close', () => boothClients.delete(res));
      return;
    }
    // ...and reports what it's showing a few times a second
    if (req.method === 'POST' && url.pathname === '/api/booth/state') {
      boothReport(await readJson(req));
      res.writeHead(204);
      return res.end();
    }
    if (req.method === 'GET' && url.pathname === '/led') {
      return serveFile(res, 'public', '/led.html');
    }
    if (req.method === 'POST' && url.pathname === '/api/led/frame') {
      ledFrame = await readBody(req);
      ledFrameAt = Date.now();
      for (const socket of ledClients) sendLedFrame(socket, ledFrame);
      res.writeHead(204);
      return res.end();
    }
    if (req.method === 'GET' && url.pathname === '/api/led/status') {
      return send(res, 200, { displays: ledClients.size, port: LED_PORT, addresses: localAddresses() });
    }
    if (req.method === 'GET' && url.pathname === '/api/lineup') {
      return send(res, 200, JSON.parse(await readFile('lineup.json', 'utf8')));
    }

    if (req.method === 'GET' && url.pathname.startsWith('/outputs/')) {
      return serveFile(res, 'outputs', url.pathname.slice('/outputs'.length));
    }
    if (req.method === 'GET') {
      return serveFile(res, 'public', url.pathname);
    }
    send(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(err);
    send(res, 500, { error: err.message });
  }
});

startMega();
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Scooby booth admin running at http://localhost:${PORT}`);
  console.log(`Image model: ${IMAGE_MODEL}   Text model: ${TEXT_MODEL}`);
  console.log(`LED stream on port ${LED_PORT} (this PC: ${localAddresses().join(', ')})`);
  console.log(`Connections: http://localhost:${PORT}/connections`);
});
