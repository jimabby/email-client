const express = require('express');
const router = express.Router();
const {
  streamSuggestion, suggestText, streamChat, listGeminiModels, rankEmailsWithAI, summarizeThreadWithAI,
  generateSmartReplies, extractActionsWithAI, summarizeAttachmentWithAI, MODEL_CHOICES, DEFAULT_MODELS, modelFor,
} = require('../services/aiService');

// Model ids are passed straight to a provider API; keep them to the characters
// real ids use.
const MODEL_ID = /^[A-Za-z0-9._:\-/]{1,100}$/;
const store = require('../store');
const searchIndex = require('../services/searchIndexService');

// An AI key is available if the user saved one, OR no explicit provider is set
// (or it's Claude) and the ANTHROPIC_API_KEY env fallback exists. The env key
// only works for Claude, so it must NOT satisfy an OpenAI/Gemini selection.
function hasAiKey() {
  const { provider, apiKey } = store.getAiSettings();
  if (apiKey) return true;
  if ((!provider || provider === 'claude') && process.env.ANTHROPIC_API_KEY) return true;
  return false;
}

// GET /api/ai/settings — return current provider (no API key exposed).
// Reports the ANTHROPIC_API_KEY env fallback as a configured Claude provider
// so the UI doesn't show "no key" while AI requests actually work.
router.get('/settings', (req, res) => {
  const { provider, apiKey } = store.getAiSettings();
  const envFallback = (!provider || provider === 'claude') && !!process.env.ANTHROPIC_API_KEY;
  const effective = provider || (envFallback ? 'claude' : null);
  res.json({
    provider: effective,
    configured: !!apiKey || envFallback,
    model: effective ? modelFor(effective) : null,
  });
});

// GET /api/ai/models — the picker's choices for every provider.
router.get('/models', (req, res) => {
  res.json({ choices: MODEL_CHOICES, defaults: DEFAULT_MODELS });
});

// PUT /api/ai/model  Body: { model } — null/empty returns to the default.
router.put('/model', (req, res) => {
  const model = req.body?.model ? String(req.body.model).trim() : null;
  if (model && !MODEL_ID.test(model)) return res.status(400).json({ error: 'That is not a valid model id' });
  store.saveAiModel(model);
  const { provider } = store.getAiSettings();
  res.json({ success: true, model: modelFor(provider || 'claude') });
});

// POST /api/ai/settings — save provider + API key
router.post('/settings', (req, res) => {
  const { provider, apiKey, model } = req.body;
  if (!provider || !['claude', 'openai', 'gemini'].includes(provider)) {
    return res.status(400).json({ error: 'provider must be "claude", "openai", or "gemini"' });
  }
  if (!apiKey || !apiKey.trim()) {
    return res.status(400).json({ error: 'apiKey is required' });
  }
  if (model && !MODEL_ID.test(String(model))) return res.status(400).json({ error: 'That is not a valid model id' });
  store.saveAiSettings({ provider, apiKey: apiKey.trim(), model: model ? String(model).trim() : null });
  res.json({ success: true, provider, model: modelFor(provider) });
});

// DELETE /api/ai/settings — clear AI config
router.delete('/settings', (req, res) => {
  store.saveAiSettings({ provider: null, apiKey: null });
  res.json({ success: true });
});

// GET /api/ai/gemini-models — list models available for the stored Gemini key
router.get('/gemini-models', async (req, res) => {
  const { provider, apiKey } = store.getAiSettings();
  if (provider !== 'gemini' || !apiKey) {
    return res.status(400).json({ error: 'Gemini not configured' });
  }
  const result = await listGeminiModels(apiKey);
  res.json({
    error: result.error || null,
    rawResponse: result.raw || null,
    models: (result.models || []).map(m => ({ name: m.name, methods: m.supportedGenerationMethods }))
  });
});

// POST /api/ai/suggest
router.post('/suggest', async (req, res) => {
  if (!hasAiKey()) {
    return res.status(400).json({
      error: 'No AI configured. Open Settings → AI and enter your API key.'
    });
  }

  const { subject, body, mode = 'improve', customPrompt, replyTo } = req.body;

  if (mode === 'custom' && !customPrompt) {
    return res.status(400).json({ error: 'customPrompt is required for custom mode' });
  }

  await streamSuggestion(res, { subject, body, mode, customPrompt, replyTo });
});

// POST /api/ai/suggest-text — the same as /suggest, answered in one response
// for clients that cannot read a stream (the mobile app).
router.post('/suggest-text', async (req, res) => {
  if (!hasAiKey()) {
    return res.status(400).json({ error: 'No AI configured. Open Settings → AI and enter your API key.' });
  }
  const { subject, body, mode = 'improve', customPrompt, replyTo } = req.body || {};
  if (mode === 'custom' && !customPrompt) {
    return res.status(400).json({ error: 'customPrompt is required for custom mode' });
  }
  try {
    res.json({ text: await suggestText({ subject, body, mode, customPrompt, replyTo }) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ai/chat
router.post('/chat', async (req, res) => {
  if (!hasAiKey()) {
    return res.status(400).json({
      error: 'No AI configured. Open Settings → AI and enter your API key.'
    });
  }

  const { messages, emailContext = {} } = req.body;
  if (!messages?.length) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  // Retrieval step. This used to fan out a provider search plus four full body
  // fetches per account on every turn — seconds of latency, and IMAP substring
  // search almost never matched a natural-language question. The local index
  // answers from memory and already holds the message bodies.
  const query = String(messages[messages.length - 1]?.content || '').slice(0, 500);
  const retrieved = searchIndex.search(query, { limit: 12 }).map(doc => ({
    from: doc.from,
    subject: doc.subject,
    date: doc.date,
    body: (doc.body || doc.snippet || '').slice(0, 4000),
  }));

  await streamChat(res, { messages, emailContext: { ...emailContext, retrieved } });
});

router.post('/smart-replies', async (req, res) => {
  if (!hasAiKey()) return res.status(400).json({ error: 'No AI configured' });
  try { res.json({ replies: await generateSmartReplies(req.body) }); } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/extract-actions', async (req, res) => {
  if (!hasAiKey()) return res.status(400).json({ error: 'No AI configured' });
  try { res.json({ actions: await extractActionsWithAI(req.body) }); } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/summarize-attachment', async (req, res) => {
  if (!hasAiKey()) return res.status(400).json({ error: 'No AI configured' });
  try {
    let text = req.body.text || '';
    if (!text && req.body.content) {
      const bytes = Buffer.from(req.body.content, 'base64');
      if (req.body.contentType === 'application/pdf' || /\.pdf$/i.test(req.body.filename || '')) {
        const pdf = require('pdf-parse');
        text = (await pdf(bytes)).text;
      } else if (/^text\//i.test(req.body.contentType || '')) text = bytes.toString('utf8');
    }
    if (!text) return res.status(400).json({ error: 'This attachment type cannot be converted to text' });
    res.json({ summary: await summarizeAttachmentWithAI({ ...req.body, text }) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/ai/priority
router.post('/priority', async (req, res) => {
  if (!hasAiKey()) {
    return res.status(400).json({
      error: 'No AI configured. Open Settings → AI and enter your API key.'
    });
  }

  const { emails } = req.body;
  if (!Array.isArray(emails) || emails.length === 0) {
    return res.status(400).json({ error: 'emails array is required' });
  }
  if (emails.length > 120) {
    return res.status(400).json({ error: 'too many emails; limit to 120' });
  }

  const result = await rankEmailsWithAI(emails);
  if (!result) return res.status(500).json({ error: 'AI ranking failed' });
  res.json({ scores: result });
});

// POST /api/ai/thread-summary
router.post('/thread-summary', async (req, res) => {
  if (!hasAiKey()) {
    return res.status(400).json({
      error: 'No AI configured. Open Settings → AI and enter your API key.'
    });
  }

  const { subject, messages } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  const result = await summarizeThreadWithAI({ subject, messages });
  if (!result) return res.status(500).json({ error: 'AI summary failed' });
  res.json(result);
});

module.exports = router;
