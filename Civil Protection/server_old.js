import express from 'express';
import path from 'path';
import axios from 'axios';
import https from 'https';
import helmet from 'helmet';
import session from 'express-session';
import csrf from 'csurf';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcrypt';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set('trust proxy', 1); // if behind reverse proxy

// --- Security headers
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "script-src": ["'self'", "https://unpkg.com", "'unsafe-inline'"],
      "style-src":  ["'self'", "https://unpkg.com", "'unsafe-inline'"],
      "img-src":    ["'self'", "data:", "https://*.tile.openstreetmap.org", "https://unpkg.com"],
      "connect-src": ["'self'"]
    }
  }
}));

// --- Body parsers
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// --- Sessions
app.use(session({
  name: 'sid',
  secret: process.env.SESSION_SECRET || 'dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'false'
  }
}));

// --- CSRF (we’ll use it only on login routes)
const csrfProtection = csrf();

// --- Rate limit login attempts
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

// --- Simple user store from env
const CIVIL_USER = (process.env.CIVIL_USERNAME || '').trim();
console.log(`CIVIL user: ${CIVIL_USER}`);
const CIVIL_HASH = (process.env.CIVIL_PASSWORD_HASH || '').trim();

// --- Upstream config
const DATA_URL = process.env.DATA_URL;
const httpsAgent = process.env.INSECURE_TLS === 'true'
  ? new https.Agent({ rejectUnauthorized: false })
  : undefined;

// --- Small helpers
function ensureAuth(req, res, next) {
  if (req.session?.user) return next();
  const nextUrl = encodeURIComponent(req.originalUrl || '/');
  return res.redirect(`/login?next=${nextUrl}`);
}

function loginPage({ csrfToken, error = '' }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Sign in – Civil Protection</title>
  <style>
    body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;background:#0b1020;color:#e8eef7;display:grid;place-items:center;height:100vh}
    .card{width:min(360px,92vw);background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:20px;box-shadow:0 10px 30px rgba(0,0,0,.35)}
    h1{margin:0 0 8px 0;font-size:18px}
    p{margin:0 0 16px 0;color:#94a3b8;font-size:12px}
    label{display:block;margin:10px 0 6px 0;font-size:13px}
    input{width:100%;padding:10px 12px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);background:#0f1530;color:#e8eef7}
    button{width:100%;margin-top:16px;padding:10px 12px;border-radius:8px;border:0;background:#4f46e5;color:white;font-weight:600;cursor:pointer}
    .error{background:#3a0e0e;color:#fca5a5;border:1px solid #dc2626;padding:8px 10px;border-radius:8px;margin-bottom:12px;font-size:13px}
  </style>
</head>
<body>
  <div class="card">
    <h1>Sign in</h1>
    <p>Authorized civil protection staff only.</p>
    ${error ? `<div class="error">${error}</div>` : ''}
    <form method="POST" action="/login">
      <input type="hidden" name="_csrf" value="${csrfToken}">
      <label for="u">Username</label>
      <input id="u" name="username" autocomplete="username" required />
      <label for="p">Password</label>
      <input id="p" name="password" type="password" autocomplete="current-password" required />
      <button type="submit">Sign in</button>
    </form>
  </div>
</body>
</html>`;
}

// --- Public health endpoint
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// --- Login routes (no auth)
app.get('/login', csrfProtection, (req, res) => {
  res.type('html').send(loginPage({ csrfToken: req.csrfToken() }));
});

app.post('/login', loginLimiter, csrfProtection, async (req, res) => {
  try {
    const { username = '', password = '' } = req.body || {};
    if (!CIVIL_USER || !CIVIL_HASH) {
      return res.status(500).type('html').send(loginPage({
        csrfToken: req.csrfToken(),
        error: 'Server not configured: missing CIVIL_USERNAME / CIVIL_PASSWORD_HASH.'
      }));
    }
    if (username.trim() !== CIVIL_USER) {
      console.log(`Invalid login attempt for username: ${username.trim()}, expected: ${CIVIL_USER}`);
      return res.status(401).type('html').send(loginPage({
        csrfToken: req.csrfToken(),
        error: 'Invalid username.'
      }));
    }
    const ok = await bcrypt.compare(password, CIVIL_HASH);
    if (!ok) {
      return res.status(401).type('html').send(loginPage({
        csrfToken: req.csrfToken(),
        error: 'Invalid password.'
      }));
    }
    req.session.user = { username: CIVIL_USER, role: 'civil-protection' };
    const redirectTo = typeof req.query.next === 'string' ? req.query.next : '/';
    console.log(`User ${CIVIL_USER} logged in successfully, redirecting to: ${redirectTo}`);
    return res.redirect(redirectTo);
  } catch (e) {
    return res.status(500).type('html').send(loginPage({
      csrfToken: req.csrfToken(),
      error: 'Unexpected error.'
    }));
  }
});

app.post('/logout', ensureAuth, (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// --- Protected API: proxy & normalize your AMEA data
app.get('/api/amea', ensureAuth, async (_req, res) => {
  console.log(`Fetching AMEA data from: ${DATA_URL}`);
  if (!DATA_URL) return res.status(500).json({ error: 'DATA_URL is not set' });
  try {
    const resp = await axios.get(DATA_URL, { httpsAgent, timeout: 15000 });
    // If upstream returns an envelope, unwrap it; else use the array directly.
    const rows = Array.isArray(resp.data) ? resp.data : (resp.data?.items || resp.data?.results || resp.data?.data || []);
    res.json(rows);
  } catch (err) {
    const code = err.code || err?.response?.status || 'UNKNOWN';
    const status = Number.isInteger(code) ? code : 502;
    res.status(status).json({
      error: 'Failed to fetch DATA_URL',
      code,
      message: err.message,
      target: DATA_URL
    });
  }
});

// --- Protected static app (index.html, JS, CSS)
app.use(ensureAuth, express.static(path.join(__dirname, 'public')));

// --- Root -> serve the app
app.get('/', ensureAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3003;
app.listen(PORT, () => {
  console.log(`AMEA map consumer running at http://localhost:${PORT}`);
});
