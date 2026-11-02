# scooby-booth

Halloween party booth: a guest takes a photo, turns a dial to pick a Scooby-Doo character, presses A or B to pick a scenario, and gets a printed card with a 4-panel 1970s Scooby-Doo comic starring them. The guest flow runs on the 192x192 LED screen (`/led`), driven by the key, dial, buttons and lever on an Arduino Mega; the admin page is the prompt workbench. (The old touchscreen quiz kiosk is archived in `backups/legacy-kiosk/`.)

## Run

1. `.env` holds the Gemini key, models and printer settings (see `.env.example`)
2. `npm start`, then open http://localhost:3001

## Admin

Prompt workbench: edit any prompt, story or the dial lineup (Ctrl+S saves), add stories, and test-run a story on an uploaded or webcam photo. Stories are listed the way the booth sees them: dial position 1-5, then button A or B. Each run shows the photo description, every attempt with its likeness and story checks, and the exact prompt sent. Tick **Print when done** to send the final comic straight to the card printer, like the booth will. Click a recent run to view it; Shift+click (or "Use this photo") reuses its photo. Saved changes apply to the next run without restarting. The admin page is only reachable from the machine running it.

## Printing cards

Cards print through the printer's Windows driver (SwiftColor SCC4000D), same as the old mbti project, so install the driver and make sure a Windows test page prints first. In the admin page, pick the printer at the top, then use **Print card** under any attempt. The comic is fitted onto the card without stretching (`PRINT_FILL=true` in `.env` fills the card edge to edge instead, cropping a little). Set `PRINTER_NAME` in `.env` to preselect the printer. The card size is picked automatically from `PRINT_PAPER` (3.5 x 5.5 in, the 700x1100 card); color and other settings come from the driver's printing preferences. To test without the printer, pick "Microsoft Print to PDF".

**Card back:** the SCC-4000D driver is single-sided, so the back is its own print job. Upload the static back design once in the admin's "Card back" section (saved as `references/card-back.png`, ideally 700x1100 portrait), then after printing a comic, flip the card and press **Print card back**. If the back comes out upside down, tick "Rotate 180°". Set **Copies** to print a stack of backs in one go (up to 100, sent as one job).

## Hardware (Arduino Mega)

The key, dial, blue/red buttons and lever are read by an Arduino Mega (`halloween-machine/mega_controller`), plugged into this computer by USB. The server finds it automatically (or set `MEGA_PORT=COM5`) and passes its controls to the booth screen (`/led`) as the same actions as the keyboard: key = take the photo, dial = character, blue = story A, red = story B (`BUTTONS` in `server.js`), lever = make the comic. The booth screen reports back, and the server sends the Mega the progress (`PROGRESS:n`, fills the LED strip), `DONE` when "take your card" shows (that's `PRINT_DONE_DELAY` seconds after the card is sent to the printer), and `RESET` whenever the screen goes back to the start or shows an error.

**The booth screen's timing is the one that counts** (`IDLE_TIMEOUT`, `DONE_TIME`, `ERROR_TIME` in `public/led.js`). The app asks the Mega its state every 2.5 s, and while it does, the Mega's own timeouts are off; they only kick in if the app stops talking for 10 s. This needs the updated firmware in `halloween-machine/mega_controller` (the original is in `backups/mega_controller-original.ino`).

**Connections** (`/connections`, linked from the admin header): the booth screen, Mega, LED panel, printer, webcam and Gemini at a glance, the live Mega message log, and buttons to ping/reset it or send any command (`CAL:n` to calibrate the meter). With `MEGA_PORT=sim` a pretend Mega gets buttons for the key, dial, buttons and lever, to try the whole flow without the hardware. Only one program can use the Mega's port at a time, so close the Arduino IDE's serial monitor while the booth runs.

The booth screen remembers its Real run / Print checkboxes, so set them once on the event computer.

## How a comic gets made (`lib/pipeline.js`)

1. **Describe:** a text model writes a gender-neutral description of the guest from their photo, plus pants and shoes for the half the webcam can't see, starting from a random idea so guests don't all match (`prompts/describe.md`)
2. **Draw:** the image model gets the style reference, lettering reference and photo, plus `prompts/base.md` with the description and the story filled in
3. **Check:** two text checks run side by side: likeness against the photo (`prompts/check.md`) and the comic against the story script (`prompts/story-check.md`)
4. **Redraw:** if either check fails, it draws again with all the problems listed, up to `MAX_ATTEMPTS`. The best comic is shown (passing both first, then likeness, then story)

Every run is saved in `outputs/<time>-<story>/`: the photo, every attempt, and `log.json` with the description and check results.

## Editing

- **Stories:** one file per story in `stories/`. First line is `# Title`, then the CHARACTERS / STORY / TEXT sections. The file name (before the first "-") says which character it belongs to. A story can also be a complete prompt on its own if it includes `{{HERO_DESCRIPTION}}` (and optionally `{{RETRY_NOTES}}`)
- **Writing stories that work:** one clear action per panel, and each panel causes the next. The image model can't draw two things happening at once, and tends to duplicate characters when asked (two villains, a missing hero). Set up the gag in panel 1 and pay it off in panel 4. Spell out who stands where, left to right, in any panel with 3+ figures. Give each character one action (especially hands). Never write "both do the same pose"; describe each character's pose separately, or the model may draw two copies of one of them. Describe recurring objects (the door, the van) the same way in every panel. Keep the villain out of panels where they haven't arrived yet, say "ONE single person" for the villain, and describe their real human face under the mask.
- **Shared rules:** likeness, style, panels and text rules live in `prompts/base.md`, so a style fix applies to every story
- **Dial lineup:** `lineup.json`. The 5 dial positions in order, each with an A and a B story and a short label (for the LED screen). The admin page refuses to save a lineup that points at a story that doesn't exist.
- **LED screen pictures:** `public/gang.jpg` (the gang picture the spotlight moves over; each character's spotlight spot is `focus` in `lineup.json`), `public/logo.png`, `public/mystery-machine.png` and `public/walk-sheet.png` (the walking gang, 8x6 frames)
- **Monster pictures:** `public/monsters/<story>.png` (320x480), one per story, for the separate monster TV. `npm run monsters` draws any that are missing (`npm run monsters -- fred` redraws one)
- **References:** `references/style.png` (Image 1) and `references/lettering.png` (Image 2)
