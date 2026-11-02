const API = 'https://generativelanguage.googleapis.com/v1beta';
export const IMAGE_MODEL = process.env.IMAGE_MODEL || 'gemini-3.1-flash-image';
export const TEXT_MODEL = process.env.TEXT_MODEL || 'gemini-3.5-flash';

export const image = (data, mimeType = 'image/jpeg') => ({ inline_data: { mime_type: mimeType, data } });

// Labels each image so prompts can refer to "Image 1", "Image 2", ...
export const labeled = (...images) => images.flatMap((img, i) => [{ text: `Image ${i + 1}:` }, img]);

export async function generate(model, parts, generationConfig = {}) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is empty. Add it to the .env file.');
  const res = await fetch(`${API}/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ contents: [{ parts }], generationConfig }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || `HTTP ${res.status}`);
  const out = json.candidates?.[0]?.content?.parts ?? [];
  return {
    text: out.filter((p) => p.text && !p.thought).map((p) => p.text).join('\n'),
    images: out.filter((p) => p.inlineData).map((p) => p.inlineData),
    reason: json.candidates?.[0]?.finishReason ?? json.promptFeedback?.blockReason,
  };
}

export async function generateJson(parts) {
  const { text } = await generate(TEXT_MODEL, parts, { responseMimeType: 'application/json', temperature: 0 });
  return JSON.parse(text);
}
