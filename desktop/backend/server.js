require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const apiAuth = require('./middleware/apiAuth');

const app = express();
const PORT = process.env.PORT || 3001;
const isProduction = process.env.NODE_ENV === 'production';

if (isProduction && (!process.env.API_TOKEN || process.env.API_TOKEN.length < 32)) {
  throw new Error('API_TOKEN must contain at least 32 characters when NODE_ENV=production');
}

app.set('trust proxy', 1);

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

app.use(express.json({ limit: '25mb' }));

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

// Serve the built frontend (used when running as a desktop app via Electron)
const frontendDist = path.join(__dirname, '../frontend/dist');
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  // SPA fallback — return index.html for any non-API route
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`✉️  Email Client Backend running on http://localhost:${PORT}`);
  console.log(`   AI suggestions: ${process.env.ANTHROPIC_API_KEY ? '✅ enabled' : '❌ disabled (set ANTHROPIC_API_KEY)'}`);
  console.log(`   Gmail OAuth:    ${process.env.GMAIL_CLIENT_ID ? '✅ configured' : '⚠️  not configured'}`);
  console.log(`   Outlook OAuth:  ${process.env.OUTLOOK_CLIENT_ID ? '✅ configured' : '⚠️  not configured'}`);
  require('./services/reportService').startScheduler();
  require('./services/sendQueueService').startScheduler();
  require('./services/snoozeService').startScheduler();
});
