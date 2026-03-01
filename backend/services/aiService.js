const https = require('https');
const Anthropic = require('@anthropic-ai/sdk');
const store = require('../store');

const PROMPTS = {
  improve:  'You are an expert email writer. Improve this email to be more professional, clear, and effective while keeping the core message intact. Return ONLY the improved email body text, no explanations.',
  concise:  'You are an expert email writer. Make this email more concise. Remove unnecessary words and filler while preserving all key information. Return ONLY the concise email body text, no explanations.',
  complete: 'You are an expert email writer. Continue naturally from where this email left off, maintaining the tone and style. Return ONLY the completed email body text, no explanations.',
  grammar:  'You are a grammar and style expert. Fix any grammar, spelling, punctuation, and style issues in this email. Keep the writer\'s voice intact. Return ONLY the corrected email body text, no explanations.',
  formal:   'You are an expert email writer. Rewrite this email in a formal, professional business tone. Return ONLY the rewritten email body text, no explanations.',
  friendly: 'You are an expert email writer. Rewrite this email in a warm, friendly, and approachable tone. Return ONLY the rewritten email body text, no explanations.',
  subject:  'You are an expert email writer. Based on the email body provided, suggest 3 compelling subject lines. Format as a numbered list with just the subject lines, nothing else.',
  reply:    'You are an expert email writer. Draft a professional reply to this email. Return ONLY the reply body text, no explanations.',
  custom:   null
};

function buildUserMessage({ subject, body, mode, customPrompt, replyTo }) {
  let msg = '';
  if (replyTo) {
    msg += `Original email I'm replying to:\n---\nFrom: ${replyTo.from}\nSubject: ${replyTo.subject}\n\n${replyTo.body}\n---\n\n`;
  }
  if (subject) msg += `Subject: ${subject}\n\n`;
  msg += `Email body:\n${body || '(empty)'}`;
  return msg;
}

// ─── Claude (Anthropic) ───────────────────────────────────────────────────────

async function streamClaude(apiKey, systemPrompt, userMessage, res) {
  const client = new Anthropic({ apiKey });
  const stream = client.messages.stream({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }]
  });

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`);
    }
  }
}

// ─── Google Gemini ────────────────────────────────────────────────────────────

// Preferred model order — newer first
const GEMINI_MODEL_PREFERENCE = [
  'gemini-2.5-pro', 'gemini-2.5-flash',
  'gemini-flash-latest', 'gemini-2.0-flash',
  'gemini-1.5-flash', 'gemini-1.5-pro',
];

let cachedGeminiModel = null;

function geminiRequest(apiKey, options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      headers: { 'X-goog-api-key': apiKey, ...options.headers },
      ...options,
    }, (response) => {
      let data = '';
      response.on('data', chunk => { data += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: data }));
      response.on('error', reject);
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function listGeminiModels(apiKey) {
  return geminiRequest(apiKey, { path: '/v1beta/models', method: 'GET' })
    .then(({ status, body }) => {
      let json;
      try { json = JSON.parse(body); } catch { return { error: `Non-JSON response (HTTP ${status}): ${body.slice(0, 200)}`, models: [], raw: body.slice(0, 500) }; }
      if (status !== 200) {
        return { error: json.error?.message || `HTTP ${status}`, models: [], raw: body.slice(0, 500) };
      }
      return { models: json.models || [], raw: body.slice(0, 500) };
    })
    .catch(err => ({ error: err.message, models: [], raw: null }));
}

async function getGeminiModel(apiKey) {
  if (cachedGeminiModel) return cachedGeminiModel;

  const { models, error } = await listGeminiModels(apiKey);

  if (error && models.length === 0) {
    throw new Error(`Gemini API error: ${error}. Make sure your key was created at aistudio.google.com.`);
  }

  // Filter models that support generateContent (streamGenerateContent is not
  // listed separately but works on all generateContent-capable models)
  const streaming = models.filter(m =>
    m.supportedGenerationMethods?.includes('generateContent')
  );

  for (const preferred of GEMINI_MODEL_PREFERENCE) {
    if (streaming.find(m => m.name === `models/${preferred}`)) {
      cachedGeminiModel = preferred;
      return preferred;
    }
  }

  // Fall back to the first available streaming model
  if (streaming.length > 0) {
    cachedGeminiModel = streaming[0].name.replace('models/', '');
    return cachedGeminiModel;
  }

  throw new Error(
    'No Gemini models available for your API key. ' +
    'Create a free key at aistudio.google.com → Get API key → Create API key in new project.'
  );
}

async function streamGemini(apiKey, systemPrompt, userMessage, res) {
  const model = await getGeminiModel(apiKey);

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: `${systemPrompt}\n\n${userMessage}` }] }]
    });

    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${model}:streamGenerateContent?alt=sse`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-goog-api-key': apiKey
      }
    }, (response) => {
      if (response.statusCode !== 200) {
        let errData = '';
        response.on('data', chunk => { errData += chunk; });
        response.on('end', () => {
          // Reset cache so next attempt re-discovers models
          cachedGeminiModel = null;
          try {
            const err = JSON.parse(errData);
            reject(new Error(err.error?.message || `Gemini error ${response.statusCode}`));
          } catch {
            reject(new Error(`Gemini API error: ${response.statusCode}`));
          }
        });
        return;
      }

      let buffer = '';
      response.on('data', chunk => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (!data) continue;
          try {
            const json = JSON.parse(data);
            const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) res.write(`data: ${JSON.stringify({ text })}\n\n`);
          } catch {}
        }
      });
      response.on('end', resolve);
      response.on('error', reject);
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── OpenAI (ChatGPT) ─────────────────────────────────────────────────────────

function streamOpenAI(apiKey, systemPrompt, userMessage, res) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'gpt-4o',
      stream: true,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ]
    });

    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body)
      }
    }, (response) => {
      if (response.statusCode !== 200) {
        let errData = '';
        response.on('data', chunk => { errData += chunk; });
        response.on('end', () => {
          try {
            const err = JSON.parse(errData);
            reject(new Error(err.error?.message || `OpenAI error ${response.statusCode}`));
          } catch {
            reject(new Error(`OpenAI API error: ${response.statusCode}`));
          }
        });
        return;
      }

      let buffer = '';
      response.on('data', chunk => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete last line

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;
          try {
            const json = JSON.parse(data);
            const text = json.choices?.[0]?.delta?.content;
            if (text) res.write(`data: ${JSON.stringify({ text })}\n\n`);
          } catch {}
        }
      });
      response.on('end', resolve);
      response.on('error', reject);
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Main entry point ─────────────────────────────────────────────────────────

async function streamSuggestion(res, params) {
  const { mode, customPrompt } = params;
  const systemPrompt = mode === 'custom' ? customPrompt : PROMPTS[mode];

  if (!systemPrompt) {
    res.status(400).json({ error: `Unknown mode: ${mode}` });
    return;
  }

  const userMessage = buildUserMessage(params);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    const { provider, apiKey } = store.getAiSettings();

    if (provider === 'openai') {
      await streamOpenAI(apiKey, systemPrompt, userMessage, res);
    } else if (provider === 'gemini') {
      await streamGemini(apiKey, systemPrompt, userMessage, res);
    } else {
      // Default to Claude (use stored key or fall back to env)
      const key = apiKey || process.env.ANTHROPIC_API_KEY;
      await streamClaude(key, systemPrompt, userMessage, res);
    }

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
  } finally {
    res.end();
  }
}

module.exports = { streamSuggestion, listGeminiModels };
