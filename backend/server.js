require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const session = require('express-session');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: ['http://localhost:5173', 'http://localhost:3001'],
  credentials: true
}));

app.use(express.json({ limit: '25mb' }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'email-client-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/emails', require('./routes/emails'));
app.use('/api/ai', require('./routes/ai'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve the built frontend (used when running as a desktop app via Electron)
const frontendDist = path.join(__dirname, '../frontend/dist');
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  // SPA fallback — return index.html for any non-API route
  app.get('*', (req, res) => {
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`✉️  Email Client Backend running on http://localhost:${PORT}`);
  console.log(`   AI suggestions: ${process.env.ANTHROPIC_API_KEY ? '✅ enabled' : '❌ disabled (set ANTHROPIC_API_KEY)'}`);
  console.log(`   Gmail OAuth:    ${process.env.GMAIL_CLIENT_ID ? '✅ configured' : '⚠️  not configured'}`);
  console.log(`   Outlook OAuth:  ${process.env.OUTLOOK_CLIENT_ID ? '✅ configured' : '⚠️  not configured'}`);
  require('./services/reportService').startScheduler();
});
