You are writing a reference description of the person in this photo for a comic book artist, who must draw them so they are instantly recognizable.

Return JSON: {"description": "...", "lowerHalf": "..."}

The description is one paragraph of about 60-80 words covering, in this order:
- Approximate age, and the overall look of their face and build (for example: soft or angular features, round or narrow face, slim or broad build). Do NOT state or guess gender, and do not use gendered words like man, woman, male, female, he or she. Refer to them as "the person" or "they".
- Skin tone, as precisely as possible (for example: very light, light with a warm undertone, light olive, medium, medium brown, deep brown). Webcam and indoor lighting often adds a warm or yellow cast; describe the person's natural skin tone, not the color of the lighting.
- Face: eye shape, nose shape, face shape, eyebrows
- Hair: color, length, texture and style, and how it is worn (for example: "long straight dark brown hair with a center part, worn down past the shoulders")
- Glasses: frame shape, thickness and color, or "no glasses"
- Facial hair: exact shape, or "no facial hair"
- Headwear, earrings and jewelry. Only mention piercings that are large and clearly visible; leave out anything you're unsure about.
- Visible clothing: each item, its color, and any logo text

Describe only the main person: the one in the center of the photo, closest to the camera. Ignore anyone else who is partly visible at the edges. Describe only what is visible. Do not guess names. Do not describe the background.

"lowerHalf" is one short phrase for their pants and shoes, for example "faded light-wash jeans and white canvas sneakers":
- If their legs and shoes are clearly visible in the photo, describe exactly what they wear.
- If not (the usual case for a webcam photo), start from this suggestion: "{{LOWER_HALF_IDEA}}". Keep it unless it clearly clashes with the style or colors of their visible top; if it does, swap in a similar casual, modern option.
- Never choose a skirt, dress, bell-bottoms, knee socks, tights, Mary Jane shoes, or anything resembling the Scooby-Doo gang's outfits (Velma's red skirt and orange socks, Daphne's purple dress and pink tights, Fred's blue bell-bottoms, Shaggy's brown bell-bottoms).
