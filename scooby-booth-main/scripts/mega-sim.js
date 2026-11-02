// A pretend Arduino Mega for testing without the hardware: MEGA_PORT=sim in .env.
// Speaks the same stdin/stdout protocol as serial-bridge.ps1 and follows the firmware's state machine
// (halloween-machine/mega_controller). The physical controls are faked with lines starting with "!":
//   !KEY  !POT 1-5  !BLUE  !RED  !KNIFE   (the Connections page has buttons for these)
import readline from 'node:readline';

const HOST_SILENT_MS = 10_000, SESSION_TIMEOUT_MS = 120_000, PRINT_TIMEOUT_MS = 120_000, DONE_ANIM_MS = 3_000;
let state = 'IDLE', stateSince = Date.now(), lastActivity = Date.now(), lastNucMsg = Date.now();
let pot = 1, char = 1, chosen = null;

const out = (line) => console.log(`< ${line}`);
const setState = (s) => { state = s; stateSince = lastActivity = Date.now(); out(`# state -> ${s}`); };
const goIdle = () => { setState('IDLE'); out('IDLE'); };

function command(cmd) {
  lastNucMsg = Date.now();
  if (cmd === 'PING') return out('PONG');
  if (cmd === 'STATE') return out(`STATE:${state}`);
  if (['ARM', 'DONE', 'RESET'].includes(cmd)) out(`ACK:${cmd}`);
  if (cmd === 'ARM' && state === 'LOCKED') { setState('ARMED'); out('ARMED'); }
  if (cmd === 'DONE' && (state === 'PRINTING' || state === 'ARMED')) setState('DONE_ANIM');
  if (cmd === 'RESET') goIdle();
}

function control(line) {
  const [what, arg] = line.slice(1).split(' ');
  if (what === 'KEY') {
    if (state !== 'IDLE' && state !== 'DONE_ANIM') return out('# key ignored (session running)');
    char = pot; chosen = null; setState('SELECT'); out('START'); out(`CHAR:${char}`);
  }
  if (what === 'POT') {
    pot = Math.min(5, Math.max(1, Number(arg) || 1));
    // Until the knife switch, turning the knob after a button goes back to SELECT
    if (['SELECT', 'LOCKED', 'ARMED'].includes(state) && pot !== char) {
      char = pot; lastActivity = Date.now();
      if (state !== 'SELECT') { chosen = null; setState('SELECT'); }
      out(`CHAR:${char}`);
    }
  }
  // The other button switches the story; the same one again does nothing
  if ((what === 'BLUE' || what === 'RED') && ['SELECT', 'LOCKED', 'ARMED'].includes(state) && !(state !== 'SELECT' && what === chosen)) {
    chosen = what;
    out(`MODE:${what}:${char}`); setState('LOCKED'); setState('ARMED'); out('ARMED');
  }
  if (what === 'KNIFE') {
    if (state !== 'ARMED') return out('# knife ignored (not armed)');
    out('PRINT'); setState('PRINTING');
  }
}

// The same timeouts as the firmware, which only apply when the app has gone quiet
setInterval(() => {
  const now = Date.now(), hostAlive = now - lastNucMsg < HOST_SILENT_MS;
  if (hostAlive) return;
  if (['SELECT', 'LOCKED', 'ARMED'].includes(state) && now - lastActivity > SESSION_TIMEOUT_MS) { out('TIMEOUT'); goIdle(); }
  if (state === 'PRINTING' && now - Math.max(stateSince, lastNucMsg) > PRINT_TIMEOUT_MS) { out('TIMEOUT'); goIdle(); }
  if (state === 'DONE_ANIM' && now - stateSince > DONE_ANIM_MS) goIdle();
}, 200);

console.log('OPEN sim');
out('READY');
readline.createInterface({ input: process.stdin })
  .on('line', (line) => (line.startsWith('!') ? control(line.trim().toUpperCase()) : command(line.trim().toUpperCase())))
  .on('close', () => process.exit(0));
