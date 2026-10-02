require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const apiAuth = require('./middleware/apiAuth');
const { hostGuard, isLoopbackHost } = require('./middleware/hostGuard');
const { apiLimiter, webhookLimiter, aiLimiter, sendLimiter, isLoopback } = require('./middleware/rateLimit');
const store = require('./store');

const app = express();
const PORT = process.env.PORT || 3001;
const isProduction = process.env.NODE_ENV === 'production';

// Loopback by default: without a token the API is unauthenticated, and binding
// 0.0.0.0 in that state exposes every mailbox to anyone on the same network.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const BIND_HOST = process.env.BIND_HOST || (isProduction ? '0.0.0.0' : '127.0.0.1');

if (isProduction && (!process.env.API_TOKEN || process.env.API_TOKEN.length < 32)) {
  throw new Error('API_TOKEN must contain at least 32 characters when NODE_ENV=production');
}

if (!LOOPBACK_HOSTS.has(BIND_HOST) && !process.env.API_TOKEN) {
  throw new Error(
    `Refusing to listen on ${BIND_HOST} without API_TOKEN — that would expose every ` +
    'connected mailbox to the local network. Set API_TOKEN, or leave BIND_HOST unset ' +
    'to listen on 127.0.0.1 only.'
  );
}

app.set('trust proxy', 1);
app.disable('x-powered-by');

// A loopback-bound server (the desktop app, `npm run dev`) only ever has a
// legitimate caller that addresses it by a loopback name. Anything else is a
// DNS-rebinding attempt — see middleware/hostGuard.js.
if (LOOPBACK_HOSTS.has(BIND_HOST)) {
  app.use(hostGuard({ extraHosts: (process.env.ALLOWED_HOSTS || '').split(',').map(h => h.trim()).filter(Boolean) }));
}

// The server's own origin is always allowed. The desktop window loads
// http://127.0.0.1:<port>, and Vite marks the bundle's script and stylesheet
// `crossorigin`, so even same-origin asset loads carry an Origin header. With
// only localhost:3001 on the default list, 127.0.0.1 was rejected and the
// window came up blank.
const selfOrigins = [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`, `http://[::1]:${PORT}`];
const allowedOrigins = Array.from(new Set([
  ...selfOrigins,
  ...(process.env.ALLOWED_ORIGINS || 'http://localhost:5173')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean),
]));

app.use(cors({
  origin(origin, callback) {
    // Native apps do not send Origin. Browsers must be explicitly allowed.
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(Object.assign(new Error('Origin not allowed by CORS'), { status: 403 }));
  },
  credentials: true
}));

// A refused origin is a 403 with a JSON body, not Express's default 500 page.
// The request still never reaches a route — that is what stops a web page
// from firing a simple cross-site POST at this server.
app.use((err, req, res, next) => {
  if (err?.message === 'Origin not allowed by CORS') return res.status(403).json({ error: err.message });
  return next(err);
});

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Frame-Options', 'DENY');
  next();
});

// Message bodies are sanitized before they reach the DOM, but a CSP is the
// backstop for whatever gets past the sanitizer. Inline scripts run only with
// the per-response nonce, so injected markup cannot execute even if it were to
// survive DOMPurify. `img-src https:` is required because "Show images" loads
// remote images by design; `style-src 'unsafe-inline'` because mail is built
// out of inline style attributes.
function contentSecurityPolicy(nonce) {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    // The reader renders each message in a sandboxed srcdoc iframe.
    "frame-src 'self' blob: data:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

// A 30 MB body is only ever a compose with attachments. Webhook payloads are
// tiny, and they are the unauthenticated surface, so they get their own tight
// cap rather than inheriting the composer's.
app.use('/api/webhooks', webhookLimiter, express.json({ limit: '64kb' }));
app.use(express.json({ limit: '30mb' }));

// Applied before auth so an unauthenticated flood is also bounded.
app.use('/api', apiLimiter);
app.use('/api/ai', aiLimiter);
// Categorisation calls the AI provider for every uncached message.
app.use('/api/emails/categorize', aiLimiter);
app.use('/api/emails/:accountId/send', sendLimiter);

// Provider callbacks and signed webhook endpoints cannot send the Hermes token.
// Everything else under /api is private, including account metadata and AI APIs.
app.use('/api', (req, res, next) => {
  const publicPaths = [
    '/health',
    '/auth/gmail/callback',
    '/auth/outlook/callback'
  ];
  if (publicPaths.includes(req.path) || req.path.startsWith('/webhooks/')) return next();
  // A download ticket carries its own authority: single-use, two minutes, and
  // bound to one attachment. It exists so the mobile app can hand a URL to the
  // OS viewer without putting the master token in a browser's history.
  if (req.path.startsWith('/emails/attachment-ticket/')) return next();
  if (req.path.startsWith('/emails/export-ticket/') && req.method === 'GET') return next();
  return apiAuth(req, res, next);
});

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/emails', require('./routes/emails'));
app.use('/api/ai', require('./routes/ai'));
app.use('/api/webhooks', require('./routes/webhooks'));

// Health check
app.get('/api/health', (req, res) => {
  // `instance` lets the Electron shell confirm it is talking to the backend it
  // started, not whatever else happens to hold the port. It is a random
  // per-launch value with no authority of its own.
  res.json({ status: 'ok', timestamp: new Date().toISOString(), instance: process.env.HERMES_INSTANCE_ID || null });
});

// Unlike /health, this endpoint verifies the mobile app's credentials.
app.get('/api/auth-check', (req, res) => {
  res.json({ status: 'ok', authenticated: true });
});

// Serve the built frontend (used when running as a desktop app via Electron).
// The bundled SPA needs the API token to talk to a protected backend, so it is
// injected into the served HTML rather than shipped in the JS bundle.
const frontendDist = path.join(__dirname, '../frontend/dist');
if (fs.existsSync(frontendDist)) {
  const indexPath = path.join(frontendDist, 'index.html');

  app.use(express.static(frontendDist, { index: false }));

  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ error: 'Not found' });
    }
    let html = fs.readFileSync(indexPath, 'utf8');
    const nonce = crypto.randomBytes(16).toString('base64');
    res.set('Content-Security-Policy', contentSecurityPolicy(nonce));
    // The built page carries an inline theme-bootstrap script; both it and the
    // token bootstrap below need the nonce to survive the policy above.
    html = html.replace(/<script(?![^>]*src=)/g, `<script nonce="${nonce}"`);
    // This page is NOT behind apiAuth — it cannot be, since it is what
    // bootstraps the credential. So the token only ever goes to a caller on
    // this machine (the Electron window). Handing it to a remote visitor would
    // give anyone who can reach the port full access to every mailbox.
    // Both checks: the socket must be local AND the page must have been asked
    // for by a loopback name. A rebinding page satisfies the first, never the
    // second.
    if (process.env.API_TOKEN && isLoopback(req) && isLoopbackHost(req.headers.host)) {
      const bootstrap = `<script nonce="${nonce}">window.__HERMES_TOKEN__=${JSON.stringify(process.env.API_TOKEN)}</script>`;
      html = html.replace('</head>', `${bootstrap}</head>`);
    }
    res.type('html').send(html);
  });
}

const server = app.listen(PORT, BIND_HOST, () => {
  console.log(`✉️  Email Client Backend running on http://${BIND_HOST}:${PORT}`);
  console.log(`   Credentials:    🔒 sealed via ${store.secretsBackend()}`);
  console.log(`   API token:      ${process.env.API_TOKEN ? '✅ required' : '⚠️  none (loopback only)'}`);
  console.log(`   AI suggestions: ${process.env.ANTHROPIC_API_KEY ? '✅ enabled' : '❌ disabled (set ANTHROPIC_API_KEY)'}`);
  console.log(`   Gmail OAuth:    ${process.env.GMAIL_CLIENT_ID ? '✅ configured' : '⚠️  not configured'}`);
  console.log(`   Outlook OAuth:  ${process.env.OUTLOOK_CLIENT_ID ? '✅ configured' : '⚠️  not configured'}`);
  require('./services/reportService').startScheduler();
  require('./services/sendQueueService').startScheduler();
  require('./services/snoozeService').startScheduler();
  require('./services/searchIndexService').startScheduler();
  require('./services/followupService').startScheduler();
  // Watch every account from boot, not just when a client opens the SSE
  // stream — that is what makes notifications arrive with the window closed.
  require('./services/mailWatchService').watchAll();
});

module.exports = { app, server };
