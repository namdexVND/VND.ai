// server.js — Proxy Gemini nhiều key, tương thích OpenAI /v1/chat/completions
//
// - Xoay vòng nhiều API key Gemini, tự chuyển key khi lỗi/hết quota
// - Hỗ trợ streaming (SSE), ảnh (image_url dạng data URL), system prompt
// - Trang quản lý key: /admin.html (đặt file admin.html trong thư mục public/)
// - Key lưu ở data/keys.json (ghi an toàn, không mất khi restart)
//
// .env:
//   ADMIN_TOKEN=...            (bắt buộc để dùng trang quản lý)
//   SERVER_ACCESS_KEY=...      (khuyên dùng: key để app VND gọi endpoint chat)
//   GEMINI_API_KEYS=key1,key2  (tuỳ chọn, nạp lần đầu)
//   GEMINI_MODEL=gemini-2.0-flash
//   GEMINI_IMAGE_MODEL=gemini-3.1-flash-image   (model tạo ảnh, xem POST /v1/images)
//   RATE_LIMIT_PER_MIN=40
//   PORT=3000

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------
// 0) CẤU HÌNH
// ---------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const COOLDOWN_429_MS = 60 * 1000;
const COOLDOWN_403_MS = 5 * 60 * 1000;
const COOLDOWN_5XX_MS = 5 * 1000;
const SERVER_ACCESS_KEY = process.env.SERVER_ACCESS_KEY || '';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const RATE_LIMIT = parseInt(process.env.RATE_LIMIT_PER_MIN || '40', 10);

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function bearer(req) {
  return (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
}

// ---------------------------------------------------------------
// 1) KHO LƯU KEY
// ---------------------------------------------------------------
const DATA_DIR = path.join(__dirname, 'data');
const KEYS_FILE = path.join(DATA_DIR, 'keys.json');

function makeKeyRecord(key) {
  return {
    id: 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    key,
    disabled: false,
    addedAt: new Date().toISOString(),
    uses: 0,
    fails: 0,
    cooldownUntil: 0,
    lastError: ''
  };
}

function loadKeys() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(KEYS_FILE)) {
    const seed = (process.env.GEMINI_API_KEYS || '')
      .split(',').map(k => k.trim()).filter(Boolean).map(makeKeyRecord);
    fs.writeFileSync(KEYS_FILE, JSON.stringify(seed, null, 2));
    return seed;
  }
  try {
    const list = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch (e) {
    // Không ghi đè file hỏng: sao lưu lại rồi mới khởi tạo rỗng
    const backup = KEYS_FILE + '.broken-' + Date.now();
    try { fs.copyFileSync(KEYS_FILE, backup); } catch (_) {}
    console.error('⚠️ keys.json hỏng, đã sao lưu tại', backup, '-', e.message);
    return [];
  }
}

let keyStore = loadKeys();
let rrPointer = 0;
let saveTimer = null;

function writeKeysNow() {
  const tmp = KEYS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(keyStore, null, 2));
  fs.renameSync(tmp, KEYS_FILE); // ghi nguyên tử, tránh hỏng file khi sập giữa chừng
}
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { writeKeysNow(); } catch (e) { console.error('Lỗi lưu keys.json:', e.message); }
  }, 300);
}
function saveKeysSync() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  writeKeysNow();
}
process.on('SIGTERM', () => { try { saveKeysSync(); } catch (_) {} process.exit(0); });
process.on('SIGINT', () => { try { saveKeysSync(); } catch (_) {} process.exit(0); });

function maskKey(k) {
  if (!k) return '';
  if (k.length <= 10) return k[0] + '***' + k[k.length - 1];
  return k.slice(0, 6) + '••••' + k.slice(-4);
}

function pickAvailableKeys() {
  const now = Date.now();
  const active = keyStore.filter(k => !k.disabled);
  const n = active.length;
  if (n === 0) return [];
  const ordered = [];
  for (let i = 0; i < n; i++) ordered.push(active[(rrPointer + i) % n]);
  rrPointer = (rrPointer + 1) % n;
  const alive = ordered.filter(k => k.cooldownUntil <= now);
  const resting = ordered.filter(k => k.cooldownUntil > now);
  return [...alive, ...resting];
}

// ---------------------------------------------------------------
// 2) CHUYỂN ĐỔI OpenAI <-> Gemini
// ---------------------------------------------------------------
function parseDataUrl(url) {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(url || '');
  return m ? { mimeType: m[1], data: m[2] } : null;
}

function contentToParts(content) {
  if (typeof content === 'string') return content ? [{ text: content }] : [];
  if (!Array.isArray(content)) return content ? [{ text: JSON.stringify(content) }] : [];
  const parts = [];
  for (const p of content) {
    if (!p) continue;
    if (p.type === 'text' && p.text) parts.push({ text: p.text });
    else if (p.type === 'image_url') {
      const url = typeof p.image_url === 'string' ? p.image_url : p.image_url && p.image_url.url;
      const d = parseDataUrl(url);
      if (d) parts.push({ inlineData: d });
      else if (url) parts.push({ text: `[Ảnh: ${url}]` });
    }
  }
  return parts;
}

function toGeminiPayload(body) {
  const { messages, temperature, max_tokens, top_p } = body;
  let systemText = '';
  const contents = [];
  for (const m of messages || []) {
    if (m.role === 'system') {
      const t = contentToParts(m.content).map(p => p.text || '').join('');
      systemText += (systemText ? '\n' : '') + t;
      continue;
    }
    const role = m.role === 'assistant' ? 'model' : 'user';
    const parts = contentToParts(m.content);
    if (!parts.length) continue;
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  }
  const payload = { contents };
  if (systemText) payload.systemInstruction = { parts: [{ text: systemText }] };
  const gc = {};
  if (typeof temperature === 'number') gc.temperature = temperature;
  if (typeof top_p === 'number') gc.topP = top_p;
  if (typeof max_tokens === 'number') gc.maxOutputTokens = max_tokens;
  if (Object.keys(gc).length) payload.generationConfig = gc;
  return payload;
}

function extractGeminiText(data) {
  const cand = data && data.candidates && data.candidates[0];
  const parts = cand && cand.content && cand.content.parts;
  return parts && parts.length ? parts.map(p => p.text || '').join('') : '';
}
// Lấy ảnh (inlineData) + lời nhắn kèm theo từ phản hồi của model ảnh
function extractGeminiImages(data) {
  const cand = data && data.candidates && data.candidates[0];
  const parts = (cand && cand.content && cand.content.parts) || [];
  const images = [];
  let text = '';
  for (const p of parts) {
    if (!p) continue;
    const inline = p.inlineData || p.inline_data;
    if (inline && inline.data) {
      images.push({ mimeType: inline.mimeType || inline.mime_type || 'image/png', data: inline.data });
    } else if (p.text && !p.thought) {
      text += p.text;
    }
  }
  return { images, text: text.trim() };
}
function blockNote(data) {
  const cand = data && data.candidates && data.candidates[0];
  const reason = (data && data.promptFeedback && data.promptFeedback.blockReason) || (cand && cand.finishReason);
  if (reason && reason !== 'STOP' && reason !== 'MAX_TOKENS') return `[Gemini không trả lời — lý do: ${reason}]`;
  return '';
}

// ---------------------------------------------------------------
// 3) GỌI GEMINI + FAILOVER
// ---------------------------------------------------------------
async function callGemini(model, payload, stream) {
  const candidates = pickAvailableKeys();
  if (!candidates.length) {
    const e = new Error('Chưa có API key nào khả dụng (chưa thêm key, hoặc tất cả đã bị tắt).');
    e.status = 503;
    throw e;
  }
  const action = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
  const url = `${GEMINI_BASE}/models/${encodeURIComponent(model)}:${action}`;
  let lastError = null;

  for (const k of candidates) {
    try {
      const upstream = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': k.key },
        body: JSON.stringify(payload)
      });
      if (upstream.ok) {
        k.uses++;
        k.lastError = '';
        scheduleSave();
        return { upstream, key: k };
      }

      const data = await upstream.json().catch(() => null);
      const msg = (data && data.error && data.error.message) || `Lỗi HTTP ${upstream.status}`;
      lastError = Object.assign(new Error(msg), { status: upstream.status });
      const s = upstream.status;

      if (s === 429) { k.cooldownUntil = Date.now() + COOLDOWN_429_MS; k.fails++; }
      else if (s === 401 || s === 403) { k.cooldownUntil = Date.now() + COOLDOWN_403_MS; k.fails++; }
      else if (s === 400 && /API key not valid|API_KEY_INVALID/i.test(msg)) { k.disabled = true; k.fails++; }
      else if (s >= 500) { k.cooldownUntil = Date.now() + COOLDOWN_5XX_MS; k.fails++; }
      else { scheduleSave(); break; } // lỗi do yêu cầu (sai model, payload...) — đổi key cũng vô ích
      k.lastError = msg.slice(0, 200);
      scheduleSave();
    } catch (err) {
      lastError = err;
      k.fails++;
      k.cooldownUntil = Date.now() + COOLDOWN_5XX_MS;
      k.lastError = String(err.message).slice(0, 200);
      scheduleSave();
    }
  }
  throw lastError || new Error('Không có API key nào khả dụng.');
}

// ---------------------------------------------------------------
// 4) MIDDLEWARE
// ---------------------------------------------------------------
function checkAccess(req, res, next) {
  if (!SERVER_ACCESS_KEY) return next();
  if (!safeEqual(bearer(req), SERVER_ACCESS_KEY)) {
    return res.status(401).json({ error: { message: 'Sai server access key.' } });
  }
  next();
}
function checkAdmin(req, res, next) {
  if (!ADMIN_TOKEN) {
    return res.status(500).json({ error: { message: 'Server chưa cấu hình ADMIN_TOKEN — không thể dùng trang quản lý key.' } });
  }
  const t = String(req.headers['x-admin-token'] || bearer(req)).trim();
  if (!safeEqual(t, ADMIN_TOKEN)) return res.status(401).json({ error: { message: 'Sai admin token.' } });
  next();
}

const hits = new Map(); // ip -> { count, resetAt }
function rateLimit(req, res, next) {
  if (!RATE_LIMIT) return next();
  const now = Date.now();
  let h = hits.get(req.ip);
  if (!h || h.resetAt <= now) { h = { count: 0, resetAt: now + 60000 }; hits.set(req.ip, h); }
  h.count++;
  if (h.count > RATE_LIMIT) {
    res.set('Retry-After', String(Math.ceil((h.resetAt - now) / 1000)));
    return res.status(429).json({ error: { message: 'Bạn gửi quá nhanh, vui lòng thử lại sau ít phút.' } });
  }
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, h] of hits) if (h.resetAt <= now) hits.delete(ip);
}, 60000).unref();

// ---------------------------------------------------------------
// 5) ENDPOINT CHAT
// ---------------------------------------------------------------
async function pipeStream(upstream, res, model) {
  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  if (res.flushHeaders) res.flushHeaders();

  const id = 'chatcmpl-' + Date.now();
  const created = Math.floor(Date.now() / 1000);
  const send = (delta, finish) => res.write('data: ' + JSON.stringify({
    id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta, finish_reason: finish || null }]
  }) + '\n\n');

  const reader = upstream.body.getReader();
  const dec = new TextDecoder();
  let buf = '', closed = false, sentAny = false, note = '';
  res.on('close', () => {
    if (!res.writableEnded) { closed = true; reader.cancel().catch(() => {}); }
  });

  try {
    send({ role: 'assistant', content: '' });
    while (!closed) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        let j;
        try { j = JSON.parse(line.slice(5).trim()); } catch (_) { continue; }
        const text = extractGeminiText(j);
        if (text) { sentAny = true; send({ content: text }); }
        else note = blockNote(j) || note;
      }
    }
    if (!closed) {
      if (!sentAny) send({ content: note || '[Không có phản hồi]' });
      send({}, 'stop');
      res.write('data: [DONE]\n\n');
    }
  } catch (err) {
    if (!closed) res.write('data: ' + JSON.stringify({ error: { message: err.message } }) + '\n\n');
  } finally {
    res.end();
  }
}

app.post('/v1/chat/completions', rateLimit, checkAccess, async (req, res) => {
  try {
    const body = req.body || {};
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return res.status(400).json({ error: { message: 'Thiếu "messages".' } });
    }
    const model = (body.model && String(body.model).startsWith('gemini')) ? body.model : DEFAULT_MODEL;
    const payload = toGeminiPayload(body);
    if (!payload.contents.length) {
      return res.status(400).json({ error: { message: 'Tin nhắn rỗng.' } });
    }
    const stream = body.stream === true;
    const { upstream } = await callGemini(model, payload, stream);

    if (stream) return pipeStream(upstream, res, model);

    const data = await upstream.json();
    const text = extractGeminiText(data) || blockNote(data) || '[Không có phản hồi]';
    const um = data.usageMetadata || {};
    res.json({
      id: 'chatcmpl-' + Date.now(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: um.promptTokenCount || 0,
        completion_tokens: um.candidatesTokenCount || 0,
        total_tokens: um.totalTokenCount || 0
      }
    });
  } catch (err) {
    console.error('chat error:', err.message);
    if (res.headersSent) return res.end();
    const clientErr = err.status && err.status >= 400 && err.status < 500 && err.status !== 429 && err.status !== 401 && err.status !== 403;
    res.status(clientErr ? 400 : (err.status === 503 ? 503 : 502))
      .json({ error: { message: clientErr ? err.message : 'Các API key Gemini đều đang lỗi/hết quota: ' + err.message } });
  }
});

// ---------------------------------------------------------------
// 5b) ENDPOINT TẠO ẢNH — POST /v1/images
//   body: { prompt, model?, images?: [dataUrl, ...] }   (images = ảnh gốc để chỉnh sửa)
//   trả:  { created, model, data: [{ b64_json, mime_type }], text }
// ---------------------------------------------------------------
app.post('/v1/images', rateLimit, checkAccess, async (req, res) => {
  const fail = (status, message) => {
    if (res.headersSent) { // đã gửi header (đang giữ kết nối) -> trả lỗi trong body
      if (!res.writableEnded) res.end(JSON.stringify({ error: { message } }));
    } else res.status(status).json({ error: { message } });
  };
  let beat = null;
  try {
    const body = req.body || {};
    const prompt = String(body.prompt || '').trim();
    if (!prompt) return fail(400, 'Thiếu mô tả ảnh ("prompt").');
    if (prompt.length > 4000) return fail(400, 'Mô tả ảnh quá dài (tối đa 4000 ký tự).');

    const model = (body.model && String(body.model).startsWith('gemini')) ? body.model : IMAGE_MODEL;
    const parts = [{ text: prompt }];
    const refs = Array.isArray(body.images) ? body.images.slice(0, 4) : [];
    for (const u of refs) {
      const d = parseDataUrl(u);
      if (d) parts.push({ inlineData: d });
    }
    const payload = {
      contents: [{ role: 'user', parts }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
    };

    // Giữ kết nối sống: tạo ảnh có thể mất 10-60s, proxy (Render, Cloudflare...) hay cắt kết nối im lặng.
    // Khoảng trắng ở đầu JSON vẫn hợp lệ nên client parse bình thường.
    res.status(200).set({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
    if (res.flushHeaders) res.flushHeaders();
    res.write(' ');
    beat = setInterval(() => { if (!res.writableEnded) res.write(' '); }, 8000);
    res.on('close', () => { if (beat) { clearInterval(beat); beat = null; } });

    const { upstream } = await callGemini(model, payload, false);
    const data = await upstream.json();
    const out = extractGeminiImages(data);
    if (!out.images.length) {
      return fail(422, out.text || blockNote(data) || 'Gemini không trả về ảnh. Hãy thử mô tả khác.');
    }
    if (!res.writableEnded) res.end(JSON.stringify({
      created: Math.floor(Date.now() / 1000),
      model,
      data: out.images.map(i => ({ b64_json: i.data, mime_type: i.mimeType })),
      text: out.text
    }));
  } catch (err) {
    console.error('image error:', err.message);
    const clientErr = err.status && err.status >= 400 && err.status < 500 && err.status !== 429 && err.status !== 401 && err.status !== 403;
    fail(clientErr ? 400 : (err.status === 503 ? 503 : 502),
      clientErr ? err.message : 'Các API key Gemini đều đang lỗi/hết quota (model ảnh thường cần gói trả phí): ' + err.message);
  } finally {
    if (beat) clearInterval(beat);
  }
});

app.get('/health', (req, res) => {
  const now = Date.now();
  res.json({
    ok: true,
    totalKeys: keyStore.length,
    activeKeys: keyStore.filter(k => !k.disabled).length,
    restingKeys: keyStore.filter(k => !k.disabled && k.cooldownUntil > now).length
  });
});

// ---------------------------------------------------------------
// 6) ENDPOINT QUẢN LÝ KEY (dùng bởi /admin.html)
// ---------------------------------------------------------------
app.get('/admin/keys', checkAdmin, (req, res) => {
  const now = Date.now();
  res.json({
    keys: keyStore.map(k => ({
      id: k.id,
      masked: maskKey(k.key),
      disabled: !!k.disabled,
      resting: !k.disabled && k.cooldownUntil > now,
      uses: k.uses,
      fails: k.fails,
      lastError: k.lastError || '',
      addedAt: k.addedAt
    }))
  });
});

app.post('/admin/keys', checkAdmin, (req, res) => {
  const body = req.body || {};
  const raw = body.keys != null ? body.keys : body.key;
  const list = String(raw || '').split(/[\n,\s]+/).map(s => s.trim()).filter(Boolean);
  if (!list.length) return res.status(400).json({ error: { message: 'Thiếu key cần thêm.' } });

  const existing = new Set(keyStore.map(k => k.key));
  let added = 0, duplicated = 0;
  for (const k of list) {
    if (existing.has(k)) { duplicated++; continue; }
    keyStore.push(makeKeyRecord(k));
    existing.add(k);
    added++;
  }
  saveKeysSync();
  res.json({ added, duplicated, total: keyStore.length });
});

app.patch('/admin/keys/:id', checkAdmin, (req, res) => {
  const k = keyStore.find(x => x.id === req.params.id);
  if (!k) return res.status(404).json({ error: { message: 'Không tìm thấy key.' } });
  if (typeof req.body.disabled === 'boolean') k.disabled = req.body.disabled;
  if (req.body.resetCooldown) { k.cooldownUntil = 0; k.fails = 0; k.lastError = ''; }
  saveKeysSync();
  res.json({ ok: true });
});

app.delete('/admin/keys/:id', checkAdmin, (req, res) => {
  const before = keyStore.length;
  keyStore = keyStore.filter(x => x.id !== req.params.id);
  saveKeysSync();
  res.json({ deleted: before - keyStore.length });
});

app.listen(PORT, () => {
  console.log(`✅ Gemini proxy đang chạy ở cổng ${PORT} — ${keyStore.length} key`);
  console.log(`   Chat:  POST /v1/chat/completions   Ảnh: POST /v1/images (${IMAGE_MODEL})   Quản lý: /admin.html`);
  if (!ADMIN_TOKEN) console.warn('⚠️  Chưa đặt ADMIN_TOKEN — trang quản lý key sẽ không dùng được.');
  if (!SERVER_ACCESS_KEY) console.warn('⚠️  Chưa đặt SERVER_ACCESS_KEY — ai biết URL cũng dùng được key của bạn.');
});
