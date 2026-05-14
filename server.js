require('dotenv').config();
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { kv } = require('@vercel/kv');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// ─── Detect Vercel environment ───────────────────────────────────────────────
const IS_VERCEL = !!process.env.VERCEL;

// On Vercel, writable storage is only /tmp
const DATA_DIR    = IS_VERCEL ? '/tmp/data'    : path.join(__dirname, 'data');
const UPLOADS_DIR = IS_VERCEL ? '/tmp/uploads' : path.join(__dirname, 'public', 'uploads');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
const USERS_PATH    = path.join(DATA_DIR, 'users.json');

// ─── Ensure directories exist ────────────────────────────────────────────────
if (!fs.existsSync(DATA_DIR))    fs.mkdirSync(DATA_DIR,    { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ─── Default settings (used on Vercel first boot or missing file) ─────────────
const DEFAULT_SETTINGS = {
  redirectLink:    '#',
  heroImage:       '',
  siteName:        'Welcome',
  heroTitle:       'Join Us Today',
  heroSubtitle:    'Click below to get started',
  buttonText:      'Sign Up Now',
  loginLink:       '',
  loginButtonText: 'Login'
};

// Seed settings file if it doesn't exist
if (!fs.existsSync(SETTINGS_PATH)) {
  // On Vercel, try to copy from the bundled data/settings.json
  const bundledSettings = path.join(__dirname, 'data', 'settings.json');
  if (!IS_VERCEL && fs.existsSync(bundledSettings)) {
    fs.copyFileSync(bundledSettings, SETTINGS_PATH);
  } else {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(DEFAULT_SETTINGS, null, 2));
  }
}

// ─── Multer storage config ───────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename:    (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, 'hero_' + Date.now() + ext);
  }
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp/;
    const ok = allowed.test(path.extname(file.originalname).toLowerCase()) &&
               allowed.test(file.mimetype);
    if (ok) cb(null, true);
    else    cb(new Error('Only image files allowed!'));
  },
  limits: { fileSize: 10 * 1024 * 1024 } // 10 MB
});

// ─── Middleware ──────────────────────────────────────────────────────────────
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret:            process.env.SESSION_SECRET || 'secret_key',
  resave:            false,
  saveUninitialized: false,
  cookie:            { maxAge: 1000 * 60 * 60 * 2 } // 2 hours
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────
async function readSettings() {
  try {
    if (process.env.KV_REST_API_URL) {
      const data = await kv.get('settings');
      if (data) return typeof data === 'string' ? JSON.parse(data) : data;
    }
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
  } catch (err) {
    console.error('Error reading settings:', err);
    return { ...DEFAULT_SETTINGS };
  }
}

async function saveSettings(data) {
  try {
    if (process.env.KV_REST_API_URL) {
      await kv.set('settings', data);
    }
    if (!IS_VERCEL) fs.writeFileSync(SETTINGS_PATH, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Error saving settings:', err);
  }
}

async function readUsers() {
  try {
    if (process.env.KV_REST_API_URL) {
      const data = await kv.get('users');
      if (data) return typeof data === 'string' ? JSON.parse(data) : data;
    }
    return JSON.parse(fs.readFileSync(USERS_PATH, 'utf-8'));
  } catch {
    return [];
  }
}

async function saveUsers(users) {
  try {
    if (process.env.KV_REST_API_URL) {
      await kv.set('users', users);
    }
    if (!IS_VERCEL) fs.writeFileSync(USERS_PATH, JSON.stringify(users, null, 2));
  } catch (err) {
    console.error('Error saving users:', err);
  }
}

function getClientIP(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || req.ip;
}

function isAdmin(req) {
  return req.session && req.session.isAdmin === true;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// Public settings API
app.get('/api/settings', async (req, res) => {
  res.json(await readSettings());
});

// Check if current IP has registered before
app.get('/api/check-user', async (req, res) => {
  const ip   = getClientIP(req);
  const users = await readUsers();
  const user = users.find(u => u.ip === ip);
  res.json(user ? { registered: true, name: user.name } : { registered: false });
});

// Register a new user
app.post('/api/register', async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.json({ success: false, message: 'নাম দিন' });

  const ip     = getClientIP(req);
  const users  = await readUsers();
  const idx    = users.findIndex(u => u.ip === ip);
  const entry  = { ip, name: name.trim(), registeredAt: new Date().toISOString() };
  if (idx !== -1) users[idx] = entry;
  else            users.push(entry);
  await saveUsers(users);
  res.json({ success: true, name: entry.name });
});

// Admin pages & auth
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.post('/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    res.json({ success: true });
  } else {
    res.json({ success: false, message: 'Wrong password!' });
  }
});

app.post('/admin/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/admin/check', (req, res) => res.json({ isAdmin: isAdmin(req) }));

// Admin: Update settings
app.post('/admin/update-settings', async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ success: false, message: 'Unauthorized' });

  const settings = await readSettings();
  const { redirectLink, siteName, heroTitle, heroSubtitle, buttonText, loginLink, loginButtonText } = req.body;

  if (redirectLink    !== undefined) settings.redirectLink    = redirectLink;
  if (siteName        !== undefined) settings.siteName        = siteName;
  if (heroTitle       !== undefined) settings.heroTitle       = heroTitle;
  if (heroSubtitle    !== undefined) settings.heroSubtitle    = heroSubtitle;
  if (buttonText      !== undefined) settings.buttonText      = buttonText;
  if (loginLink       !== undefined) settings.loginLink       = loginLink;
  if (loginButtonText !== undefined) settings.loginButtonText = loginButtonText;

  await saveSettings(settings);
  res.json({ success: true, settings });
});

// Admin: Upload hero image
app.post('/admin/upload-image', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ success: false, message: 'Unauthorized' });
  upload.single('heroImage')(req, res, async (err) => {
    if (err)       return res.json({ success: false, message: err.message });
    if (!req.file) return res.json({ success: false, message: 'No file uploaded' });

    const settings = await readSettings();
    if (settings.heroImage) {
      const oldPath = IS_VERCEL
        ? path.join(UPLOADS_DIR, path.basename(settings.heroImage))
        : path.join(__dirname, 'public', settings.heroImage);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
    const imagePath = '/uploads/' + req.file.filename;
    settings.heroImage = imagePath;
    await saveSettings(settings);
    res.json({ success: true, imagePath });
  });
});

// Serve uploaded images from /tmp on Vercel
if (IS_VERCEL) {
  app.get('/uploads/:filename', (req, res) => {
    const filePath = path.join(UPLOADS_DIR, req.params.filename);
    if (fs.existsSync(filePath)) res.sendFile(filePath);
    else                         res.status(404).send('Not found');
  });
}

// Admin: Remove hero image
app.post('/admin/remove-image', async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ success: false, message: 'Unauthorized' });
  const settings = await readSettings();
  if (settings.heroImage) {
    const oldPath = IS_VERCEL
      ? path.join(UPLOADS_DIR, path.basename(settings.heroImage))
      : path.join(__dirname, 'public', settings.heroImage);
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    settings.heroImage = '';
    await saveSettings(settings);
  }
  res.json({ success: true });
});

// ─── Start (local only) ───────────────────────────────────────────────────────
if (!IS_VERCEL) {
  app.listen(PORT, () => {
    console.log(`\n✅ Server running at http://localhost:${PORT}`);
    console.log(`🔐 Admin panel: http://localhost:${PORT}/admin`);
    console.log(`🔑 Admin password: ${ADMIN_PASSWORD}\n`);
  });
}

// Export for Vercel serverless
module.exports = app;
