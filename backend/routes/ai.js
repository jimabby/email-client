const express = require('express');
const router = express.Router();
const { streamSuggestion } = require('../services/aiService');

// POST /api/ai/suggest
// Body: { subject, body, mode, customPrompt?, replyTo? }
// Modes: improve, concise, complete, grammar, formal, friendly, subject, reply, custom
router.post('/suggest', async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(400).json({
      error: 'AI suggestions not configured. Set ANTHROPIC_API_KEY in your .env file.'
    });
  }

  const { subject, body, mode = 'improve', customPrompt, replyTo } = req.body;

  if (mode === 'custom' && !customPrompt) {
    return res.status(400).json({ error: 'customPrompt is required for custom mode' });
  }

  await streamSuggestion(res, { subject, body, mode, customPrompt, replyTo });
});

module.exports = router;
