require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const apiAuth = require('./middleware/apiAuth');
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

const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://localhost:3001')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    // Native apps do not send Origin. Browsers must be explicitly allowed.
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Origin not allowed by CORS'));
  },
  credentials: true
}));

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Frame-Options', 'DENY');
  next();
});

app.use(express.json({ limit: '30mb' }));

// Provider callbacks and signed webhook endpoints cannot send the Hermes token.
// Everything else under /api is private, including account metadata and AI APIs.
app.use('/api', (req, res, next) => {
  const publicPaths = [
    '/health',
    '/auth/gmail/callback',
    '/auth/outlook/callback'
  ];
  if (publicPaths.includes(req.path) || req.path.startsWith('/webhooks/')) return next();
  return apiAuth(req, res, next);
});

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/emails', require('./routes/emails'));
app.use('/api/ai', require('./routes/ai'));
app.use('/api/webhooks', require('./routes/webhooks'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
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
    if (process.env.API_TOKEN) {
      const bootstrap = `<script>window.__HERMES_TOKEN__=${JSON.stringify(process.env.API_TOKEN)}</script>`;
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
  // Watch every account from boot, not just when a client opens the SSE
  // stream — that is what makes notifications arrive with the window closed.
  require('./services/mailWatchService').watchAll();
});

module.exports = { app, server };
