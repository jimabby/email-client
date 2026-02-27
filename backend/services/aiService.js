const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

const PROMPTS = {
  improve: `You are an expert email writer. The user has written an email draft and wants you to improve it.
Make it more professional, clear, and effective while keeping the core message intact.
Return ONLY the improved email body text, no explanations or meta-commentary.`,

  concise: `You are an expert email writer. The user has written an email draft and wants you to make it more concise.
Remove unnecessary words, redundancy, and filler while preserving all key information.
Return ONLY the concise email body text, no explanations.`,

  complete: `You are an expert email writer. The user has started writing an email and wants you to complete it.
Continue naturally from where they left off, maintaining their tone and style.
Return ONLY the completed email body text, no explanations.`,

  grammar: `You are a grammar and style expert. Fix any grammar, spelling, punctuation, and style issues in this email.
Keep the writer's voice and intent intact.
Return ONLY the corrected email body text, no explanations.`,

  formal: `You are an expert email writer. Rewrite this email in a formal, professional business tone.
Return ONLY the rewritten email body text, no explanations.`,

  friendly: `You are an expert email writer. Rewrite this email in a warm, friendly, and approachable tone.
Return ONLY the rewritten email body text, no explanations.`,

  subject: `You are an expert email writer. Based on the email body provided, suggest 3 compelling subject lines.
Format your response as a numbered list with just the subject lines, nothing else.`,

  reply: `You are an expert email writer. Draft a professional reply to this email.
Return ONLY the reply body text, no explanations.`,

  custom: null // will use user's own prompt
};

async function streamSuggestion(res, { subject, body, mode, customPrompt, replyTo }) {
  const systemPrompt = mode === 'custom' ? customPrompt : PROMPTS[mode];

  if (!systemPrompt && mode !== 'custom') {
    res.status(400).json({ error: `Unknown mode: ${mode}` });
    return;
  }

  // Build the user message
  let userMessage = '';
  if (replyTo) {
    userMessage += `Original email I'm replying to:\n---\nFrom: ${replyTo.from}\nSubject: ${replyTo.subject}\n\n${replyTo.body}\n---\n\n`;
  }
  if (subject) userMessage += `Subject: ${subject}\n\n`;
  userMessage += `Email body:\n${body || '(empty)'}`;

  // Set up SSE headers for streaming
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    const stream = client.messages.stream({
      model: 'claude-opus-4-6',
      max_tokens: 2048,
      thinking: { type: 'adaptive' },
      system: mode === 'custom' ? customPrompt : systemPrompt,
      messages: [{ role: 'user', content: userMessage }]
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`);
      }
    }

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
  } finally {
    res.end();
  }
}

module.exports = { streamSuggestion };
