import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { generate, generateJson, image, labeled, IMAGE_MODEL, TEXT_MODEL } from './gemini.js';

const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS || 2);

// A random starting idea for the hero's pants and shoes (the webcam rarely shows them),
// so guests don't all end up in the same jeans. None of these are from the gang's outfits.
const PANTS = ['black jeans', 'light-wash jeans', 'olive cargo pants', 'khaki chinos', 'navy corduroys', 'gray joggers', 'black cargo pants', 'dark-wash jeans', 'charcoal trousers'];
const SHOES = ['white sneakers', 'black boots', 'brown leather boots', 'canvas high-tops', 'black sneakers', 'brown loafers', 'retro running shoes'];
// Comic shapes: "card" fits the 700x1100 portrait print card, "wide" is the original on-screen shape
export const FORMATS = {
  card: {
    aspectRatio: '2:3',
    // One of these exact page layouts is picked at random per run: varied, but always exactly four panels
    layouts: [
      'ROW 1: panel 1, full width. ROW 2: panels 2 and 3 side by side. ROW 3: panel 4, full width.',
      'ROW 1: panels 1 and 2 side by side. ROW 2: panel 3, full width. ROW 3: panel 4, full width.',
      'ROW 1: panel 1, full width. ROW 2: panel 2, full width. ROW 3: panels 3 and 4 side by side.',
      'ROW 1: panels 1 and 2 side by side. ROW 2: panels 3 and 4 side by side.',
    ],
    layout: (rows) => `a tall portrait page (taller than it is wide) with EXACTLY FOUR panels in exactly this layout, and no other panels: ${rows} There is no fifth panel, no inset panel and no close-up panel. Each story panel is drawn as ONE panel: never split a scene into two panels, and everything a scene describes (including an unmasking) happens inside its one panel. In narrow panels, place figures in depth (one in front, others slightly behind) instead of squeezing them into a row, and keep speech bubbles narrow, near the top of the panel.`,
  },
  wide: { aspectRatio: '4:3', layout: 'a landscape page with a 2x2 grid of four equal, wide panels.' },
};
const DEFAULT_FORMAT = FORMATS[process.env.COMIC_FORMAT] ? process.env.COMIC_FORMAT : 'card';

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const read = (f) => readFile(f, 'utf8');
const readBase64 = async (f) => (await readFile(f)).toString('base64');

// Each story file starts with "# Title". If it contains {{HERO_DESCRIPTION}} it's a complete
// prompt on its own; otherwise it's just the CHARACTERS/STORY/TEXT part and gets wrapped in base.md.
// The file name before the first "-" is the character: velma.md and velma-library.md are both "velma".
export async function loadStories() {
  const files = (await readdir('stories')).filter((f) => f.endsWith('.md'));
  return Promise.all(files.map(async (f) => {
    const id = path.basename(f, '.md');
    const [first, ...rest] = (await read(path.join('stories', f))).split('\n');
    return { id, character: id.split('-')[0], title: first.replace(/^#\s*/, '').trim(), body: rest.join('\n').trim() };
  }));
}

function buildPrompt(base, story, description, retryIssues, layout) {
  const retryNotes = retryIssues?.length
    ? `IMPORTANT — a previous attempt of this comic had problems. Fix all of these:\n${retryIssues.map((i) => `- ${i}`).join('\n')}`
    : '';
  const template = story.body.includes('{{HERO_DESCRIPTION}}') ? story.body : base.replace('{{STORY}}', story.body);
  return template
    .replace('{{LAYOUT}}', layout)
    .replace('{{HERO_DESCRIPTION}}', description)
    .replace('{{RETRY_NOTES}}', retryNotes)
    .replace(/\n{3,}/g, '\n\n');
}

// photo: base64 JPEG. onStage(stage, attempt) reports progress; onLog(log) hands over the
// run log, which keeps filling in (description, attempts) so the admin page can watch it live.
export async function createComic({ photo, story, base: baseName = 'base', format = DEFAULT_FORMAT, maxAttempts = MAX_ATTEMPTS, onStage = () => {}, onLog = () => {} }) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const run = `${stamp}-${story.id}`;
  const dir = path.join('outputs', run);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'photo.jpg'), Buffer.from(photo, 'base64'));
  const fmt = FORMATS[format] ?? FORMATS[DEFAULT_FORMAT];
  const { aspectRatio } = fmt;
  const layout = fmt.layouts ? fmt.layout(pick(fmt.layouts)) : fmt.layout;
  const log = { run, story: story.id, base: baseName, format, imageModel: IMAGE_MODEL, textModel: TEXT_MODEL, attempts: [] };
  onLog(log);

  onStage('describing');
  const photoPart = image(photo);
  const describePrompt = (await read('prompts/describe.md')).replace('{{LOWER_HALF_IDEA}}', `${pick(PANTS)} and ${pick(SHOES)}`);
  const look = await generateJson([{ text: describePrompt }, photoPart]);
  const description = look.lowerHalf
    ? `${look.description}\nLower half (same in every panel): ${look.lowerHalf}`
    : look.description;
  log.description = description;

  const [base, checkPrompt, storyCheckPrompt, style, lettering] = await Promise.all([
    read(`prompts/${baseName}.md`),
    read('prompts/check.md'),
    read('prompts/story-check.md'),
    readBase64('references/style.png'),
    readBase64('references/lettering.png'),
  ]);

  let best = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    onStage(attempt === 1 ? 'drawing' : 'redrawing', attempt);
    const last = log.attempts.at(-1);
    const prompt = buildPrompt(base, story, description, [...(last?.check?.issues ?? []), ...(last?.storyCheck?.issues ?? [])], layout);
    const draw = () => generate(IMAGE_MODEL, [
      ...labeled(image(style, 'image/png'), image(lettering, 'image/png'), photoPart),
      { text: prompt },
    ], { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio } });
    // The model occasionally replies with text and no image; ask once more before counting it as a failed attempt
    let result = await draw();
    if (!result.images[0]) result = await draw();

    const comic = result.images[0];
    if (!comic) {
      log.attempts.push({ attempt, prompt, error: result.text || `No image returned (${result.reason})` });
      continue;
    }
    const file = `comic-${attempt}.${comic.mimeType === 'image/png' ? 'png' : 'jpg'}`;
    await writeFile(path.join(dir, file), Buffer.from(comic.data, 'base64'));

    // Likeness and story checks run side by side; the comic must pass both
    onStage('checking', attempt);
    const comicPart = image(comic.data, comic.mimeType);
    const [check, storyCheck] = await Promise.all([
      generateJson([{ text: checkPrompt.replace('{{HERO_DESCRIPTION}}', description) }, ...labeled(photoPart, comicPart)]),
      generateJson([{ text: storyCheckPrompt.replace('{{STORY}}', story.body) }, { text: 'The comic:' }, comicPart]),
    ]);
    const pass = check.pass && storyCheck.pass;
    // Best = passed both, then likeness (weighted double), then story
    const rank = (pass ? 100 : 0) + check.score * 2 + storyCheck.score;
    log.attempts.push({ attempt, file, prompt, check, storyCheck, pass });
    if (!best || rank > best.rank) best = { file, pass, rank };
    if (pass) break;
  }

  log.final = best?.file;
  log.passed = best?.pass ?? false;
  await writeFile(path.join(dir, 'log.json'), JSON.stringify(log, null, 2));
  if (!best) throw new Error(log.attempts.at(-1)?.error || 'No comic was generated');
  return { url: `/outputs/${run}/${best.file}`, passed: best.pass, attempts: log.attempts.length };
}

// Recent runs for the admin page, newest first
export async function listRuns(limit = 60) {
  const runs = (await readdir('outputs', { withFileTypes: true }).catch(() => []))
    .filter((d) => d.isDirectory()).map((d) => d.name).sort().reverse().slice(0, limit);
  return Promise.all(runs.map(async (run) => {
    const log = await read(path.join('outputs', run, 'log.json')).then(JSON.parse).catch(() => null);
    return { run, story: log?.story, final: log?.final, passed: log?.passed, attempts: log?.attempts.length, done: !!log };
  }));
}

export const readRunLog = (run) => read(path.join('outputs', path.basename(run), 'log.json')).then(JSON.parse);
