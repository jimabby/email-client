const express = require('express');
const router = express.Router();
const { streamSuggestion, streamChat, listGeminiModels } = require('../services/aiService');
const store = require('../store');

// GET /api/ai/settings — return current provider (no API key exposed)
router.get('/settings', (req, res) => {
  const { provider, apiKey } = store.getAiSettings();
  res.json({ provider: provider || null, configured: !!apiKey });
});

// POST /api/ai/settings — save provider + API key
router.post('/settings', (req, res) => {
  const { provider, apiKey } = req.body;
  if (!provider || !['claude', 'openai', 'gemini'].includes(provider)) {
    return res.status(400).json({ error: 'provider must be "claude", "openai", or "gemini"' });
  }
  if (!apiKey || !apiKey.trim()) {
    return res.status(400).json({ error: 'apiKey is required' });
  }
  store.saveAiSettings({ provider, apiKey: apiKey.trim() });
  res.json({ success: true, provider });
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
  const { provider, apiKey } = store.getAiSettings();
  const hasKey = apiKey || process.env.ANTHROPIC_API_KEY;

  if (!hasKey) {
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

// POST /api/ai/chat
router.post('/chat', async (req, res) => {
  const { provider, apiKey } = store.getAiSettings();
  const hasKey = apiKey || process.env.ANTHROPIC_API_KEY;

  if (!hasKey) {
    return res.status(400).json({
      error: 'No AI configured. Open Settings → AI and enter your API key.'
    });
  }

  const { messages, emailContext } = req.body;
  if (!messages?.length) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  await streamChat(res, { messages, emailContext });
});

module.exports = router;
