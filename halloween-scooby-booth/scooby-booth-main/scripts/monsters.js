// Generates a one-shot portrait of each story's monster into public/monsters/<story>.png (320x480)
// Usage: npm run monsters               (only ones that don't exist yet)
//        npm run monsters -- fred velma (redraw just these)
import { readFile, writeFile, mkdir, access, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { generate, image, labeled, IMAGE_MODEL } from '../lib/gemini.js';

const MONSTERS = {
  velma: 'The Mummy: a tall, lumbering mummy wrapped head to toe in loose, dirty-white bandages, with glowing yellow eyes peering out, arms stretched forward.',
  'velma-library': 'The Ghost Librarian: a glowing pale blue ghost draped in a long white sheet with hollow black eyes, a gray hair bun on top and cat-eye glasses, one long bony finger raised to where her lips would be, shushing.',
  fred: 'The Phantom of the Disco: a tall glowing pale green ghost in a white 1970s disco suit with huge bell-bottoms and a wide pointed collar, a long black cape spread wide, and a blank white ghost mask with hollow black eyes, striking a disco pose.',
  'fred-shortcut': 'The Swamp Creature: a hulking swamp monster covered in dripping green moss and weeds, with long arms, clawed hands and glowing red eyes, arms raised.',
  daphne: 'The Mannequin Monster: a stiff figure in a plain mustard-yellow 1970s pantsuit and white gloves, wearing a smooth, blank white plastic mannequin mask with glowing red eyes, gray hair curlers peeking out around it, arms stiffly outstretched.',
  'daphne-door': 'The Door Monster: a hulking, shaggy purple monster with huge fangs, curved horns and glowing yellow eyes, roaring with its mouth wide open and claws raised.',
  shaggy: 'The S\'more Werewolf: a hunched, hairy werewolf with shaggy dark gray fur, pointed ears, sharp teeth and glowing yellow eyes, clawed hands raised.',
  'shaggy-snacks': 'The Taffy Monster: a blobby, dripping monster made of stretchy bright pink taffy, with glowing yellow eyes and long gooey arms reaching out.',
  scooby: 'The Phantom Chef: a glowing pale green ghost in a tall white chef\'s hat and a white apron, with hollow black eyes and long grabby green fingers, holding a ladle.',
  'scooby-ghost': 'The Amusement Park Ghost: a glowing green ghost in a tattered white sheet with hollow black eyes, arms raised in a spooky pose.',
};

const PROMPT = `Image 1 is the art style reference.

Draw a single full-body portrait of one original cartoon monster: {{MONSTER}}

- Only this ONE monster, alone, standing and filling most of the frame, facing the viewer in a spooky but fun pose. No other characters, no people, no text, no logo, no speech bubbles, no panel border.
- Background: one flat, solid, very dark warm brown-black color (#0f0d0b) with no scenery, filling the ENTIRE image edge to edge. No paper border, no white or cream margin, no frame around the image.
- Absolutely no text, letters or words anywhere, including on the monster itself. No objects floating around the monster.
- Drawn in the style of Image 1: a vintage 1970s cartoon comic book printed on cheap newsprint, with visible halftone dots in the colors, slight color misregistration, hand-inked brush linework with thick-to-thin wobbly lines, scratchy black hatching for shadows, and flat print colors. Not a modern digital illustration.
- The ENTIRE monster fits inside the image, centered, with a clear margin of empty background on all four sides: nothing cut off at the edges (head, hands, sheet, tail or feet all fully visible), and no glow or drips running off the edge.
- Overall tone: fun, comical 1970s Saturday-morning cartoon monster, spooky but friendly, never gory or truly frightening.`;

const run = promisify(execFile);
const exists = (f) => access(f).then(() => true, () => false);
const requested = process.argv.slice(2);
const ids = requested.length ? requested : Object.keys(MONSTERS);

await mkdir('public/monsters', { recursive: true });
const style = (await readFile('references/style.png')).toString('base64');

for (const id of ids) {
  if (!MONSTERS[id]) { console.log(`Unknown story: ${id}`); continue; }
  const out = `public/monsters/${id}.png`;
  if (!requested.length && await exists(out)) { console.log(`${id}: already exists, skipping`); continue; }
  console.log(`${id}: generating with ${IMAGE_MODEL}...`);
  const draw = () => generate(IMAGE_MODEL, [...labeled(image(style, 'image/png')), { text: PROMPT.replace('{{MONSTER}}', MONSTERS[id]) }],
    { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '2:3' } });
  let result = await draw();
  if (!result.images[0]) result = await draw();
  const img = result.images[0];
  if (!img) { console.log(`${id}: no image (${result.text || result.reason})`); continue; }
  // The model returns 2:3; resize to exactly 320x480 with ffmpeg
  const raw = `public/monsters/${id}.raw.${img.mimeType === 'image/png' ? 'png' : 'jpg'}`;
  await writeFile(raw, Buffer.from(img.data, 'base64'));
  await run('ffmpeg', ['-v', 'error', '-y', '-i', raw, '-vf', 'scale=320:480:force_original_aspect_ratio=increase:flags=lanczos,crop=320:480', out]);
  await unlink(raw);
  console.log(`${id}: saved ${out}`);
}
