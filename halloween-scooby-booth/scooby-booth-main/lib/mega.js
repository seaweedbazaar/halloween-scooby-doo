// Link to the Arduino Mega that reads the booth's key, dial, buttons and lever (halloween-machine/mega_controller).
// Same protocol as halloween-machine/nuc/mega_link.py: 115200 baud, one message per line; ARM / DONE / RESET
// are resent until the Mega answers ACK:<cmd>. The serial port itself is opened by scripts/serial-bridge.ps1.
//
// The app is in charge of all timing: it asks STATE every few seconds, and while it does, the Mega's own
// timeouts stay off (the firmware only falls back to them if the app goes quiet for 10 seconds).
//
// MEGA_PORT in .env: empty = find the Mega automatically, COM5 = that port, sim = a pretend Mega
// (scripts/mega-sim.js), off = don't connect.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';

const SETTING = (process.env.MEGA_PORT || '').trim();
const ACKED = new Set(['ARM', 'DONE', 'RESET']);
const HEARTBEAT_MS = 2500;   // how often we ask STATE (keeps the Mega in "app decides" mode)
const SILENT_MS = 10_000;    // no answer for this long = the connection is dead, reopen it
const RETRY_MS = 3000;       // wait between attempts to find/open the port

export const mega = new EventEmitter(); // 'event' (name, args) for every message from the Mega
const status = { link: SETTING.toLowerCase() === 'off' ? 'off' : 'searching', port: null, setting: SETTING || 'auto',
  since: Date.now(), lastHeard: null, megaState: null, error: null };
const log = [];             // recent traffic for the Connections page: { at, dir: 'in' | 'out' | 'info', text }
const acks = new Map();     // cmd -> resolve
let bridge = null;

function addLog(dir, text) {
  // A run of PROGRESS messages collapses into one line that updates in place
  const last = log.at(-1);
  if (last && dir === 'out' && text.startsWith('PROGRESS:') && last.text.startsWith('PROGRESS:')) Object.assign(last, { at: Date.now(), text });
  else log.push({ at: Date.now(), dir, text });
  if (log.length > 200) log.shift();
}

function setLink(link, extra = {}) {
  if (status.link !== link) Object.assign(status, { link, since: Date.now() });
  Object.assign(status, extra);
}

function write(line) {
  if (status.link !== 'connected') return false;
  bridge.stdin.write(`${line}\n`);
  if (line !== 'STATE') addLog('out', line);
  return true;
}

// Sends a command; ARM / DONE / RESET wait for the ACK and are resent (5 tries, like mega_link.py)
export async function send(cmd) {
  cmd = cmd.trim().toUpperCase();
  if (!ACKED.has(cmd)) return write(cmd);
  for (let i = 0; i < 5; i++) {
    const acked = new Promise((resolve) => { acks.set(cmd, resolve); setTimeout(() => resolve(false), 300); });
    if (!write(cmd)) return false;
    if (await acked) return true;
  }
  addLog('info', `No ACK for ${cmd}`);
  return false;
}

function onLine(raw) {
  if (raw === 'NOPORT') return setLink('searching', { error: 'No Arduino found on any USB port' });
  if (raw.startsWith('ERROR ')) return setLink('error', { error: raw.slice(6) });
  if (raw.startsWith('OPEN ')) {
    setLink('connected', { port: raw.slice(5), error: null, lastHeard: Date.now() });
    addLog('info', `Connected on ${status.port}`);
    return;
  }
  if (!raw.startsWith('< ')) return;
  const line = raw.slice(2);
  status.lastHeard = Date.now();
  if (line.startsWith('#')) return addLog('debug', line.slice(1).trim());
  const [name, ...args] = line.split(':');
  if (name === 'STATE') return (status.megaState = args[0]);
  addLog('in', line);
  if (name === 'ACK') return acks.get(args[0])?.(true);
  if (name === 'PONG') return;
  if (name === 'READY' || name === 'IDLE' || name === 'TIMEOUT') status.megaState = 'IDLE';
  mega.emit('event', name, args);
}

function open() {
  if (status.link === 'off') return;
  const sim = SETTING.toLowerCase() === 'sim';
  bridge = sim
    ? spawn(process.execPath, [path.resolve('scripts/mega-sim.js')])
    : spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.resolve('scripts/serial-bridge.ps1'),
      ...(SETTING ? ['-Port', SETTING] : [])], { windowsHide: true });
  let buf = '';
  bridge.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) onLine(line);
    }
  });
  bridge.stderr.on('data', (chunk) => setLink('error', { error: String(chunk).trim().split(/\r?\n/)[0] }));
  bridge.stdin.on('error', () => {});
  bridge.on('exit', () => {
    if (status.link === 'connected') { addLog('info', 'Disconnected'); setLink('searching', { megaState: null }); }
    bridge = null;
    setTimeout(open, RETRY_MS);
  });
}

// Reopens the port (the Mega restarts when the port opens)
export function reconnect() {
  addLog('info', 'Reconnecting');
  if (bridge) bridge.kill(); else open();
}

export const megaStatus = () => ({ ...status, log });

export function startMega() {
  if (status.link === 'off') return;
  open();
  setInterval(() => {
    if (status.link !== 'connected') return;
    if (Date.now() - status.lastHeard > SILENT_MS) {
      addLog('info', 'The Mega stopped answering');
      setLink('error', { error: 'Stopped answering' });
      return bridge?.kill();
    }
    write('STATE');
  }, HEARTBEAT_MS);
}
