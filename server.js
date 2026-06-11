// LCL Ocean Services — Warehouse Inventory App backend
// Serves the mobile page and two API endpoints:
//   POST /api/count  -> Claude vision reads the photo, returns exact counts (no estimates)
//                       mode=count   : count every item in the photo
//                       mode=identify: identify the single item shown (qty entered by hand)
//   POST /api/post   -> uploads the photo to Slack AND posts the message (photo + text together)
//
// All secrets live in environment variables on Render. Nothing sensitive is ever sent to the browser.

import express from 'express';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  ANTHROPIC_API_KEY,
  SLACK_BOT_TOKEN,
  SLACK_CHANNEL_ID,
  MODEL = 'claude-sonnet-4-6',
  PORT = 3000,
} = process.env;

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    counting: Boolean(ANTHROPIC_API_KEY),
    slack: Boolean(SLACK_BOT_TOKEN && SLACK_CHANNEL_ID),
    model: MODEL,
  });
});

// ---- pull the first JSON object out of a model reply ----
function extractJson(text) {
  if (!text) return { items: [], notes: '' };
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) return { items: [], notes: '' };
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return { items: [], notes: 'Could not parse the count automatically — enter it manually.' };
  }
}

const COUNT_PROMPT = `You are a warehouse receiving assistant for LCL Ocean Services, looking at a photo of incoming freight laid out for a receiving count. The items can be ANYTHING — coffee, electronics, apparel, auto parts, tools, household goods, food, etc. Do not assume a category.

For every distinct product in the photo, identify:
- name: what the product is (brand + product name if visible; otherwise a clear plain description like "white cardboard box", "car tire", "bottled water case").
- detail: variant, flavor, model, size, or color as printed (use "" if none).
- perUnit: if the item is a multi-pack or case with a printed count (e.g. "24 ct", "12 pack", "case of 6"), the number of units per package. If it is a single item, use 1.
- qty: the EXACT number of that product/package visible.

Rules — this is critical:
- Count only items you can see clearly as individual, separate units in a single layer.
- Do NOT guess and do NOT estimate. Never round up "to be safe".
- If items are stacked, overlapping, or partially hidden so you cannot count them exactly, set "needs_review": true for that product and put your most defensible clear count in "qty".
- If a product is fully visible, set "needs_review": false.

Return ONLY valid JSON, no prose, in exactly this shape:
{"items":[{"name":"","detail":"","perUnit":1,"qty":0,"needs_review":false}],"notes":""}
Use "notes" for any short caveat the receiver should know (e.g. which product needs a recount).`;

const IDENTIFY_PROMPT = `You are a warehouse receiving assistant for LCL Ocean Services. The photo shows ONE item — a single product or a single box/case — that the receiver is holding up. The item can be anything.

Identify just this one item:
- name: brand + product name if visible, otherwise a clear plain description.
- detail: variant, flavor, model, size, or color as printed (use "" if none).
- perUnit: if it is a multi-pack/case with a printed count (e.g. "12 ct"), that number; otherwise 1.

Do NOT count quantity — the receiver will type how many there are by hand.

Return ONLY valid JSON, no prose, in exactly this shape:
{"items":[{"name":"","detail":"","perUnit":1,"qty":null,"needs_review":false}],"notes":""}`;

app.post('/api/count', upload.single('photo'), async (req, res) => {
  try {
    if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'Server is missing ANTHROPIC_API_KEY.' });
    if (!req.file) return res.status(400).json({ error: 'No photo was uploaded.' });

    const b64 = req.file.buffer.toString('base64');
    const media = req.file.mimetype || 'image/jpeg';
    const prompt = (req.body.mode === 'identify') ? IDENTIFY_PROMPT : COUNT_PROMPT;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1500,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: media, data: b64 } },
            { type: 'text', text: prompt },
          ],
        }],
      }),
    });

    const data = await r.json();
    if (!r.ok) return res.status(502).json({ error: 'Vision API error', detail: data });

    const text = (data.content || []).map((c) => c.text || '').join('');
    const parsed = extractJson(text);
    if (!Array.isArray(parsed.items)) parsed.items = [];
    res.json(parsed);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/post', upload.single('photo'), async (req, res) => {
  try {
    if (!SLACK_BOT_TOKEN || !SLACK_CHANNEL_ID) {
      return res.status(500).json({ error: 'Server is missing SLACK_BOT_TOKEN or SLACK_CHANNEL_ID.' });
    }
    if (!req.file) return res.status(400).json({ error: 'No photo to post.' });

    const message = req.body.message || '';
    const filename = req.file.originalname || 'receiving.jpg';
    const buf = req.file.buffer;

    // 1) ask Slack for an upload URL
    const getUrl = `https://slack.com/api/files.getUploadURLExternal?filename=${encodeURIComponent(filename)}&length=${buf.length}`;
    const g = await (await fetch(getUrl, { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } })).json();
    if (!g.ok) return res.status(502).json({ error: 'Slack getUploadURLExternal failed', detail: g });

    // 2) upload the raw photo bytes to that URL
    const form = new FormData();
    form.append('file', new Blob([buf], { type: req.file.mimetype || 'image/jpeg' }), filename);
    const up = await fetch(g.upload_url, { method: 'POST', body: form });
    if (!up.ok) {
      const detail = await up.text();
      return res.status(502).json({ error: 'Slack file upload failed', detail });
    }

    // 3) complete the upload AND post it to the channel with the message as the comment
    const c = await (await fetch('https://slack.com/api/files.completeUploadExternal', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
      body: JSON.stringify({
        files: [{ id: g.file_id, title: filename }],
        channel_id: SLACK_CHANNEL_ID,
        initial_comment: message,
      }),
    })).json();
    if (!c.ok) return res.status(502).json({ error: 'Slack completeUploadExternal failed', detail: c });

    const permalink = c.files && c.files[0] && c.files[0].permalink;
    res.json({ ok: true, permalink });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`LCL inventory app listening on ${PORT}`));
