const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const nodemailer = require('nodemailer');

const scrypt = promisify(crypto.scrypt);
let SocketServer = null;
try { SocketServer = require('socket.io').Server; } catch { /* optional dependency: HTTP polling remains available */ }
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 3000);
const SESSION_TTL = 12 * 60 * 60 * 1000;
const GUEST_SESSION_TTL = 4 * 60 * 60 * 1000;
const ROOM_RETENTION = 30 * 24 * 60 * 60 * 1000;
const MAX_BODY = 1_000_000;
const MEETING_DATA_DIR = String(process.env.MEETING_DATA_DIR || '').trim();
const DATA_DIR = MEETING_DATA_DIR ? path.resolve(MEETING_DATA_DIR) : path.join(ROOT, '.data');
const STORE_FILE = path.join(DATA_DIR, 'meeting.json');
const ADMIN_EMAILS = new Set(['deiyeshua05@gmail.com', 'deiyeshua@gmail.com', ...String(process.env.ADMIN_EMAIL || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean)]);
const SMTP_HOST = String(process.env.SMTP_HOST || '').trim();
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_FROM = String(process.env.SMTP_FROM || '').trim();
const APP_BASE_URL = String(process.env.APP_BASE_URL || (process.env.NODE_ENV === 'production' ? '' : `http://localhost:${PORT}`)).trim().replace(/\/+$/, '');
const TRUST_PROXY = String(process.env.TRUST_PROXY || '').toLowerCase() === 'true';
const DEV_EMAIL_LOG = (!process.env.NODE_ENV || process.env.NODE_ENV === 'development') && ((!SMTP_HOST && !process.env.BREVO_API_KEY) || !SMTP_FROM);
if (!Number.isInteger(SMTP_PORT) || SMTP_PORT < 1 || SMTP_PORT > 65535) throw new Error('SMTP_PORT must be a valid TCP port.');
if (Boolean(process.env.SMTP_USER) !== Boolean(process.env.SMTP_PASS)) throw new Error('Set both SMTP_USER and SMTP_PASS, or leave both blank.');
const BREVO_API_KEY = String(process.env.BREVO_API_KEY || '').trim();
// HTTPS email via Brevo's API: works where outbound SMTP ports are blocked.
const brevoTransport = {
  async sendMail({ from, to, subject, text, html }) {
    const match = /^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/.exec(from);
    const sender = match ? { name: (match[1] || '').trim() || undefined, email: match[2].trim() } : { email: from.trim() };
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sender, to: [{ email: to }], subject, textContent: text, htmlContent: html }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Brevo API ${response.status}: ${(await response.text()).slice(0, 200)}`);
  },
};
const emailTransport = BREVO_API_KEY && SMTP_FROM ? brevoTransport : SMTP_HOST && SMTP_FROM ? nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || SMTP_PORT === 465,
  ...(process.env.SMTP_USER && process.env.SMTP_PASS ? { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } } : {}),
}) : null;
const authRateLimits = new Map();
let socketServer = null;

if (process.env.NODE_ENV === 'production' && String(process.env.SESSION_SECRET || '').length < 32) {
  throw new Error('Set SESSION_SECRET to a random value with at least 32 characters in production.');
}
if (process.env.NODE_ENV === 'production' && !MEETING_DATA_DIR) {
  throw new Error('Production requires MEETING_DATA_DIR to point to persistent storage. On Railway, mount a Volume at /data and set MEETING_DATA_DIR=/data.');
}
if (APP_BASE_URL) {
  const baseUrl = new URL(APP_BASE_URL);
  if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password) {
    throw new Error('APP_BASE_URL must be an http(s) origin without credentials.');
  }
  if (baseUrl.pathname !== '/' || baseUrl.search || baseUrl.hash) throw new Error('APP_BASE_URL must be the app origin without a path, query, or fragment.');
  if (process.env.NODE_ENV === 'production' && baseUrl.protocol !== 'https:') {
    throw new Error('APP_BASE_URL must use HTTPS in production.');
  }
}
if (process.env.NODE_ENV === 'production' && (!APP_BASE_URL || !emailTransport || !SMTP_FROM)) {
  throw new Error('Production requires APP_BASE_URL, SMTP_FROM, and either SMTP_HOST or BREVO_API_KEY for account verification and password recovery.');
}

function readStore() {
  try { return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') console.warn('Meeting data could not be loaded; starting with an empty store.', error.message);
    return {};
  }
}

const persisted = readStore();
const SESSION_SECRET = process.env.SESSION_SECRET || persisted.sessionSecret || crypto.randomBytes(32).toString('hex');
const users = new Map();
const sessions = new Map();
const rooms = new Map();
const removedDemoIds = new Set();
const DUMMY_AUTH_SALT = crypto.randomBytes(16).toString('hex');

for (const user of Array.isArray(persisted.users) ? persisted.users : []) {
  if (user?.isDemo || /^guest-[a-f0-9]+@demo\.meeting\.local$/i.test(user?.email || '')) {
    if (user?.id) removedDemoIds.add(user.id);
    continue;
  }
  if (user?.id && user?.email) { users.set(user.id, user); users.set(user.email, user); }
}
for (const [id, session] of Array.isArray(persisted.sessions) ? persisted.sessions : []) {
  const sessionUser = users.get(session?.userId);
  if (session?.expiresAt > Date.now() && !session.guest && sessionUser?.emailVerifiedAt) sessions.set(id, session);
}
for (const savedRoom of Array.isArray(persisted.rooms) ? persisted.rooms : []) {
  if (!/^[A-F0-9]{12}$/i.test(savedRoom?.id || '') || !savedRoom.ownerId) continue;
  rooms.set(savedRoom.id, {
    id: savedRoom.id,
    name: String(savedRoom.name || 'Meeting room').slice(0, 80),
    ownerId: savedRoom.ownerId,
    ownerName: String(savedRoom.ownerName || 'Meeting user').slice(0, 48),
    createdAt: savedRoom.createdAt || new Date().toISOString(),
    memberIds: new Set((Array.isArray(savedRoom.memberIds) ? savedRoom.memberIds : [savedRoom.ownerId]).filter((id) => !removedDemoIds.has(id))),
    peers: new Map(),
    signals: new Map(),
  });
}

function persistStore() {
  const uniqueUsers = [...new Map([...users.values()].filter((user) => !user.isGuest && !user.isDemo).map((user) => [user.id, user])).values()];
  const activeSessions = [...sessions.entries()].filter(([, session]) => !session.guest && session.expiresAt > Date.now());
  const savedRooms = [...rooms.values()].map((room) => ({
    id: room.id, name: room.name, ownerId: room.ownerId, ownerName: room.ownerName,
    createdAt: room.createdAt, memberIds: [...(room.memberIds || [room.ownerId])],
  }));
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temporaryFile = `${STORE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify({ version: 2, sessionSecret: SESSION_SECRET, users: uniqueUsers, sessions: activeSessions, rooms: savedRooms }), { mode: 0o600 });
  fs.renameSync(temporaryFile, STORE_FILE);
}

if (removedDemoIds.size) {
  persistStore();
  console.log(`Removed ${removedDemoIds.size} legacy demo account${removedDemoIds.size === 1 ? '' : 's'}.`);
}

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function send(res, status, payload, headers = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': typeof payload === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss:; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    ...headers,
  });
  res.end(body);
}

function cookieOptions(maxAge) {
  const parts = [`Path=/`, `HttpOnly`, `SameSite=Strict`, `Max-Age=${maxAge}`];
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  return parts.join('; ');
}

function cookieValue(req, name) {
  const cookies = (req.headers.cookie || '').split(';');
  for (const cookie of cookies) {
    const [key, ...rest] = cookie.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return '';
}

function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
}

function getSession(req) {
  const value = cookieValue(req, 'meeting_session');
  const [id, signature] = value.split('.');
  if (!id || !signature) return null;
  const expected = sign(id);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const session = sessions.get(id);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(id);
    return null;
  }
  return session;
}

function createSession(res, user) {
  const now = new Date().toISOString();
  user.createdAt ||= now;
  user.lastLoginAt = now;
  const id = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  sessions.set(id, { userId: user.id, csrf, expiresAt: Date.now() + SESSION_TTL });
  persistStore();
  send(res, 200, { user: publicUser(user), csrfToken: csrf }, {
    'Set-Cookie': `meeting_session=${encodeURIComponent(`${id}.${sign(id)}`)}; ${cookieOptions(SESSION_TTL / 1000)}`,
  });
}

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email || null, guest: user.isGuest === true, initials: initials(user.name), role: isAdmin(user) ? 'admin' : 'member' };
}

function isAdmin(user) {
  return ADMIN_EMAILS.has(String(user?.email || '').toLowerCase());
}

function initials(value) {
  return String(value || '?').trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() || '').join('') || '?';
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let data = '';
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Request body is too large.'), { status: 413 }));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); }
      catch { reject(Object.assign(new Error('Request body must be valid JSON.'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (origin) {
    const forwardedProtocol = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const protocol = forwardedProtocol || (req.socket.encrypted ? 'https' : 'http');
    const expected = `${protocol}://${req.headers.host}`;
    return origin === expected;
  }
  return true;
}

function requireCsrf(req, session) {
  if (!isSameOrigin(req)) return false;
  return req.headers['x-csrf-token'] === session.csrf;
}

function pruneRoom(room) {
  // Backgrounded tabs and mobile browsers can throttle the HTTP presence timer.
  // Keep peers with a live Socket.IO connection and allow a longer fallback grace period.
  const cutoff = Date.now() - 90_000;
  for (const [peerId, peer] of room.peers) {
    const hasLiveSocket = Boolean(peer.socketId && socketServer?.sockets.sockets.has(peer.socketId));
    if (peer.lastSeen < cutoff && !hasLiveSocket) {
      room.peers.delete(peerId);
      room.signals.delete(peerId);
    }
  }
}

function roomSummary(room) {
  return { id: room.id, name: room.name, createdAt: room.createdAt, owner: room.ownerName };
}

function getAuthed(req, res) {
  const session = getSession(req);
  if (!session) {
    send(res, 401, { error: 'Your session has ended. Please sign in again.' });
    return null;
  }
  const user = session.guest ? session.guestUser : users.get(session.userId);
  if (!user) {
    send(res, 401, { error: 'Your account is unavailable. Please sign in again.' });
    return null;
  }
  return { session, user };
}

function rateLimit(req, key, limit, windowMs) {
  const now = Date.now();
  const forwardedAddress = TRUST_PROXY ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
  const address = forwardedAddress || req.socket.remoteAddress || 'unknown';
  const bucketKey = `${address}:${key}`;
  let bucket = authRateLimits.get(bucketKey);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs };
    authRateLimits.set(bucketKey, bucket);
  }
  bucket.count += 1;
  if (authRateLimits.size > 5000) {
    for (const [existingKey, existing] of authRateLimits) if (existing.resetAt <= now) authRateLimits.delete(existingKey);
  }
  return bucket.count <= limit ? 0 : Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
}

function tokenDigest(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function issueToken(user, field, lifetimeMs) {
  const token = crypto.randomBytes(32).toString('base64url');
  user[field] = { digest: tokenDigest(token), expiresAt: Date.now() + lifetimeMs };
  return token;
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

async function sendAccountEmail({ to, subject, title, intro, actionLabel, actionUrl, footer }) {
  if (DEV_EMAIL_LOG) {
    console.info(`\n[local Meeting email preview]\nTo: ${to}\nSubject: ${subject}\n${actionLabel}: ${actionUrl}\n`);
    return 'console';
  }
  if (!emailDeliveryConfigured()) {
    throw new Error('Email is not configured. Set APP_BASE_URL, SMTP_FROM, and either SMTP_HOST or BREVO_API_KEY.');
  }
  const safeTitle = escapeHtml(title);
  const safeIntro = escapeHtml(intro);
  const safeAction = escapeHtml(actionLabel);
  const safeFooter = escapeHtml(footer);
  const safeUrl = escapeHtml(actionUrl);
  await emailTransport.sendMail({
    from: SMTP_FROM,
    to,
    subject,
    text: `${title}\n\n${intro}\n\n${actionLabel}: ${actionUrl}\n\n${footer}`,
    html: `<main style="font-family:Arial,sans-serif;max-width:540px;margin:40px auto;padding:32px;border:1px solid #dce8e9;border-radius:16px;color:#173c4d"><p style="color:#1882a2;font-weight:bold">MEETING</p><h1>${safeTitle}</h1><p>${safeIntro}</p><p style="margin:28px 0"><a href="${safeUrl}" style="background:#1686a5;color:#fff;padding:13px 20px;border-radius:9px;text-decoration:none">${safeAction}</a></p><p style="color:#627c86;font-size:13px">If the button does not work, copy this link into your browser:<br>${safeUrl}</p><p style="color:#627c86;font-size:13px">${safeFooter}</p></main>`,
  });
  return BREVO_API_KEY ? 'brevo' : 'smtp';
}

function emailDeliveryConfigured() {
  return DEV_EMAIL_LOG || Boolean(emailTransport && SMTP_FROM && APP_BASE_URL);
}

async function sendVerificationEmail(user, token) {
  const url = new URL('/', APP_BASE_URL || `http://localhost:${PORT}`);
  url.hash = new URLSearchParams({ verify: token }).toString();
  return sendAccountEmail({
    to: user.email,
    subject: 'Verify your Meeting email',
    title: 'Verify your email',
    intro: `Hi ${user.name}, confirm your email to finish setting up your Meeting account.`,
    actionLabel: 'Verify email address',
    actionUrl: url.href,
    footer: 'This verification link expires in 24 hours. If you did not create this account, you can ignore this email.',
  });
}

async function sendPasswordResetEmail(user, token) {
  const url = new URL('/', APP_BASE_URL || `http://localhost:${PORT}`);
  url.hash = new URLSearchParams({ reset: token }).toString();
  return sendAccountEmail({
    to: user.email,
    subject: 'Reset your Meeting password',
    title: 'Choose a new password',
    intro: `Hi ${user.name}, use the link below to reset your Meeting password.`,
    actionLabel: 'Reset password',
    actionUrl: url.href,
    footer: 'This reset link expires in 60 minutes. If you did not request a reset, you can ignore this email.',
  });
}

function createGuestSession(res, guestUser) {
  const id = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  sessions.set(id, { userId: guestUser.id, guest: true, guestUser, csrf, expiresAt: Date.now() + GUEST_SESSION_TTL });
  send(res, 200, { user: publicUser(guestUser), csrfToken: csrf }, {
    'Set-Cookie': `meeting_session=${encodeURIComponent(`${id}.${sign(id)}`)}; ${cookieOptions(GUEST_SESSION_TTL / 1000)}`,
  });
}

function revokeUserSessions(userId) {
  const revoked = new Set();
  for (const [id, session] of sessions) {
    if (session.userId === userId) { sessions.delete(id); revoked.add(id); }
  }
  if (socketServer && revoked.size) {
    for (const socket of socketServer.sockets.sockets.values()) {
      if (socket.data.user?.id === userId) socket.disconnect(true);
    }
  }
}

async function handleApi(req, res, url) {
  const route = url.pathname;
  const method = req.method || 'GET';

  if ((route.startsWith('/api/auth/') || route === '/api/guest/session') && method === 'POST' && !isSameOrigin(req)) {
    return send(res, 403, { error: 'Cross-origin sign-in requests are not allowed.' });
  }

  if (route === '/api/health' && method === 'GET') return send(res, 200, { ok: true });

  if (route === '/api/auth/register' && method === 'POST') {
    const retryAfter = rateLimit(req, 'register', 8, 60 * 60 * 1000);
    if (retryAfter) return send(res, 429, { error: 'Too many sign-up attempts. Please try again later.' }, { 'Retry-After': String(retryAfter) });
    const body = await readJson(req);
    const name = String(body.name || '').trim().slice(0, 48);
    const email = String(body.email || '').trim().toLowerCase().slice(0, 180);
    const password = String(body.password || '');
    if (name.length < 2) return send(res, 400, { error: 'Enter a name with at least 2 characters.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return send(res, 400, { error: 'Enter a valid email address.' });
    if (password.length < 10 || password.length > 256) return send(res, 400, { error: 'Use a password between 10 and 256 characters.' });
    if (users.has(email)) return send(res, 409, { error: 'An account with this email already exists.' });
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = await scrypt(password, salt, 64);
    const user = { id: crypto.randomUUID(), name, email, salt, hash: hash.toString('hex'), createdAt: new Date().toISOString(), emailVerifiedAt: null };
    users.set(email, user);
    users.set(user.id, user);
    const token = issueToken(user, 'emailVerification', 24 * 60 * 60 * 1000);
    persistStore();
    try {
      const delivery = await sendVerificationEmail(user, token);
      return send(res, 201, { needsVerification: true, email: user.email, delivery });
    } catch (error) {
      console.error('Verification email could not be sent:', error.message);
      return send(res, 503, { error: 'Your account was created, but the verification email could not be sent. Check email configuration, then request a new verification email.' });
    }
  }

  if (route === '/api/auth/login' && method === 'POST') {
    const retryAfter = rateLimit(req, 'login', 20, 15 * 60 * 1000);
    if (retryAfter) return send(res, 429, { error: 'Too many sign-in attempts. Please try again later.' }, { 'Retry-After': String(retryAfter) });
    const body = await readJson(req);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const user = users.get(email);
    const hash = await scrypt(password, user?.salt || DUMMY_AUTH_SALT, 64);
    const storedHash = Buffer.from(String(user?.hash || ''), 'hex');
    if (!user || storedHash.length !== hash.length || !crypto.timingSafeEqual(hash, storedHash)) return send(res, 401, { error: 'Email or password is incorrect.' });
    if (!user.emailVerifiedAt) return send(res, 403, { error: 'Verify your email before signing in. Click Resend verification email to request a new link.' });
    return createSession(res, user);
  }

  if (route === '/api/auth/verify-email' && method === 'POST') {
    const retryAfter = rateLimit(req, 'verify-email', 30, 60 * 60 * 1000);
    if (retryAfter) return send(res, 429, { error: 'Too many verification attempts. Please try again later.' }, { 'Retry-After': String(retryAfter) });
    const body = await readJson(req);
    const digest = tokenDigest(body.token);
    const user = [...new Map([...users.values()].map((account) => [account.id, account])).values()]
      .find((account) => account.emailVerification?.digest === digest);
    if (!user) return send(res, 400, { error: 'This verification link is invalid or has already been used. Request a new one and try again.' });
    if (user.emailVerification.expiresAt < Date.now()) {
      delete user.emailVerification;
      persistStore();
      return send(res, 400, { error: 'This verification link has expired. Request a new one and try again.' });
    }
    user.emailVerifiedAt = new Date().toISOString();
    delete user.emailVerification;
    persistStore();
    return send(res, 200, { ok: true });
  }

  if (route === '/api/auth/resend-verification' && method === 'POST') {
    const retryAfter = rateLimit(req, 'resend-verification', 4, 60 * 60 * 1000);
    if (retryAfter) return send(res, 429, { error: 'Too many email requests. Please try again later.' }, { 'Retry-After': String(retryAfter) });
    if (!emailDeliveryConfigured()) return send(res, 503, { error: 'Email delivery is not configured. Set APP_BASE_URL, SMTP_FROM, and either SMTP_HOST or BREVO_API_KEY.' });
    const body = await readJson(req);
    const email = String(body.email || '').trim().toLowerCase().slice(0, 180);
    const user = users.get(email);
    let delivery = DEV_EMAIL_LOG ? 'console' : 'smtp';
    if (user && !user.emailVerifiedAt) {
      const token = issueToken(user, 'emailVerification', 24 * 60 * 60 * 1000);
      persistStore();
      try { delivery = await sendVerificationEmail(user, token); }
      catch (error) {
        console.error('Verification email could not be sent:', error.message);
        return send(res, 503, { error: 'We could not deliver the verification email. Check the SMTP/Brevo settings and try again.' });
      }
    }
    return send(res, 200, { ok: true, delivery, message: 'If the account needs verification, a new link has been sent.' });
  }

  if (route === '/api/auth/forgot-password' && method === 'POST') {
    const retryAfter = rateLimit(req, 'forgot-password', 4, 60 * 60 * 1000);
    if (retryAfter) return send(res, 429, { error: 'Too many email requests. Please try again later.' }, { 'Retry-After': String(retryAfter) });
    if (!emailDeliveryConfigured()) return send(res, 503, { error: 'Email delivery is not configured. Set APP_BASE_URL, SMTP_FROM, and either SMTP_HOST or BREVO_API_KEY.' });
    const body = await readJson(req);
    const email = String(body.email || '').trim().toLowerCase().slice(0, 180);
    const user = users.get(email);
    let delivery = DEV_EMAIL_LOG ? 'console' : 'smtp';
    if (user?.emailVerifiedAt) {
      const token = issueToken(user, 'passwordReset', 60 * 60 * 1000);
      persistStore();
      try { delivery = await sendPasswordResetEmail(user, token); }
      catch (error) {
        delete user.passwordReset;
        persistStore();
        console.error('Password reset email could not be sent:', error.message);
      }
    }
    return send(res, 200, { ok: true, delivery, message: 'If a verified account exists for that email, a password reset link has been sent.' });
  }

  if (route === '/api/auth/reset-password' && method === 'POST') {
    const retryAfter = rateLimit(req, 'reset-password', 12, 60 * 60 * 1000);
    if (retryAfter) return send(res, 429, { error: 'Too many password reset attempts. Please try again later.' }, { 'Retry-After': String(retryAfter) });
    const body = await readJson(req);
    const password = String(body.password || '');
    if (password.length < 10 || password.length > 256) return send(res, 400, { error: 'Use a password between 10 and 256 characters.' });
    const digest = tokenDigest(body.token);
    const user = [...new Map([...users.values()].map((account) => [account.id, account])).values()]
      .find((account) => account.passwordReset?.digest === digest);
    if (!user || user.passwordReset.expiresAt < Date.now()) {
      if (user) { delete user.passwordReset; persistStore(); }
      return send(res, 400, { error: 'This password reset link is invalid or has expired. Request a new one and try again.' });
    }
    user.salt = crypto.randomBytes(16).toString('hex');
    user.hash = (await scrypt(password, user.salt, 64)).toString('hex');
    delete user.passwordReset;
    revokeUserSessions(user.id);
    persistStore();
    return send(res, 200, { ok: true, message: 'Your password has been changed. Sign in with your new password.' });
  }

  if (route === '/api/guest/session' && method === 'POST') {
    const retryAfter = rateLimit(req, 'guest-session', 30, 15 * 60 * 1000);
    if (retryAfter) return send(res, 429, { error: 'Too many guest join attempts. Please try again later.' }, { 'Retry-After': String(retryAfter) });
    const body = await readJson(req);
    const name = String(body.name || '').trim().slice(0, 48);
    const roomId = String(body.roomId || '').trim().toUpperCase();
    if (name.length < 2) return send(res, 400, { error: 'Enter a name with at least 2 characters.' });
    if (!/^[A-F0-9]{12}$/.test(roomId)) return send(res, 400, { error: 'Enter a valid 12-character meeting code.' });
    if (!rooms.has(roomId)) return send(res, 404, { error: 'This meeting could not be found. Check the room code and try again.' });
    return createGuestSession(res, { id: `guest-${crypto.randomUUID()}`, name, email: '', isGuest: true });
  }

  if (route === '/api/auth/logout' && method === 'POST') {
    const auth = getAuthed(req, res);
    if (!auth) return;
    if (!requireCsrf(req, auth.session)) return send(res, 403, { error: 'Request token is invalid. Refresh and try again.' });
    for (const [id, value] of sessions) if (value === auth.session) sessions.delete(id);
    persistStore();
    return send(res, 200, { ok: true }, { 'Set-Cookie': `meeting_session=; ${cookieOptions(0)}` });
  }

  const auth = getAuthed(req, res);
  if (!auth) return;
  const { session, user } = auth;

  if (route === '/api/session' && method === 'GET') {
    return send(res, 200, { user: publicUser(user), csrfToken: session.csrf });
  }
  if (route === '/api/admin/overview' && method === 'GET') {
    if (!isAdmin(user)) return send(res, 403, { error: 'Admin access is required to view this dashboard.' });
    const now = Date.now();
    const accounts = [...new Map([...users.values()].map((account) => [account.id, account])).values()];
    const liveSessions = [...sessions.values()].filter((item) => !item.guest && item.expiresAt > now);
    const sessionCounts = new Map();
    for (const item of liveSessions) sessionCounts.set(item.userId, (sessionCounts.get(item.userId) || 0) + 1);
    const roomRows = [...rooms.values()].map((room) => {
      pruneRoom(room);
      return {
        id: room.id,
        name: room.name,
        owner: room.ownerName,
        createdAt: room.createdAt,
        memberCount: room.memberIds?.size || 1,
        activeParticipants: room.peers.size,
      };
    }).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const accountRows = accounts.map((account) => ({
      id: account.id,
      name: account.name,
      email: account.email,
      emailVerified: Boolean(account.emailVerifiedAt),
      role: isAdmin(account) ? 'admin' : 'member',
      createdAt: account.createdAt || null,
      lastLoginAt: account.lastLoginAt || null,
      activeSessions: sessionCounts.get(account.id) || 0,
      roomCount: roomRows.filter((room) => {
        const source = rooms.get(room.id);
        return source?.ownerId === account.id || source?.memberIds?.has(account.id);
      }).length,
    })).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    return send(res, 200, {
      generatedAt: new Date(now).toISOString(),
      metrics: {
        totalUsers: accountRows.length,
        pendingVerifications: accountRows.filter((account) => !account.emailVerified).length,
        activeUsers: new Set(liveSessions.map((item) => item.userId)).size,
        totalRooms: roomRows.length,
        activeRooms: roomRows.filter((room) => room.activeParticipants > 0).length,
        liveParticipants: roomRows.reduce((total, room) => total + room.activeParticipants, 0),
      },
      users: accountRows,
      rooms: roomRows.slice(0, 25),
    });
  }
  if (route === '/api/ice-config' && method === 'GET') {
    const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
    const turnUrls = String(process.env.TURN_URLS || '').split(',').map((value) => value.trim()).filter(Boolean);
    if (turnUrls.length) {
      let username = process.env.TURN_USERNAME || '';
      let credential = process.env.TURN_CREDENTIAL || '';
      if (process.env.TURN_SHARED_SECRET) {
        username = `${Math.floor(Date.now() / 1000) + 3600}:${user.id}`;
        credential = crypto.createHmac('sha1', process.env.TURN_SHARED_SECRET).update(username).digest('base64');
      }
      iceServers.push({ urls: turnUrls, username, credential });
    }
    return send(res, 200, { iceServers });
  }
  if (method === 'POST' && !requireCsrf(req, session)) return send(res, 403, { error: 'Request token is invalid. Refresh and try again.' });

  if (route === '/api/rooms' && method === 'GET') {
    const visibleRooms = [...rooms.values()]
      .filter((room) => room.ownerId === user.id || room.memberIds?.has(user.id))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return send(res, 200, { rooms: visibleRooms.map((room) => ({ ...roomSummary(room), participantCount: room.peers.size })) });
  }

  if (route === '/api/rooms' && method === 'POST') {
    if (user.isGuest) return send(res, 403, { error: 'Guests can join meetings but cannot create rooms. Create an account to host a meeting.' });
    const body = await readJson(req);
    const name = String(body.name || 'Quick meeting').trim().slice(0, 80) || 'Quick meeting';
    const id = crypto.randomBytes(6).toString('hex').toUpperCase();
    const room = {
      id, name, ownerId: user.id, ownerName: user.name, createdAt: new Date().toISOString(),
      memberIds: new Set([user.id]), peers: new Map(), signals: new Map(),
    };
    rooms.set(id, room);
    persistStore();
    return send(res, 201, { room: roomSummary(room) });
  }

  const roomMatch = route.match(/^\/api\/rooms\/([A-F0-9]{12})(?:\/(join|leave|peers|presence|signals))?$/i);
  if (roomMatch) {
    const room = rooms.get(roomMatch[1].toUpperCase());
    if (!room) return send(res, 404, { error: 'This meeting could not be found.' });
    const action = roomMatch[2] || '';
    pruneRoom(room);

    if (!action && method === 'GET') return send(res, 200, { room: roomSummary(room) });

    if (action === 'join' && method === 'POST') {
      const body = await readJson(req);
      const peerId = String(body.peerId || '').slice(0, 64);
      if (!/^[\w-]{8,64}$/.test(peerId)) return send(res, 400, { error: 'A valid device id is required.' });
      const peer = { id: peerId, userId: user.id, name: user.name, initials: initials(user.name), lastSeen: Date.now() };
      room.peers.set(peerId, peer);
      if (!user.isGuest) room.memberIds.add(user.id);
      if (!room.signals.has(peerId)) room.signals.set(peerId, []);
      persistStore();
      const peers = [...room.peers.values()].filter((item) => item.id !== peerId).map(({ id, name, initials: mark }) => ({ id, name, initials: mark }));
      return send(res, 200, { room: roomSummary(room), peers, self: { id: peerId, name: peer.name, initials: peer.initials } });
    }

    if (action === 'leave' && method === 'POST') {
      const body = await readJson(req);
      const peerId = String(body.peerId || '');
      const peer = room.peers.get(peerId);
      if (!peer) return send(res, 200, { ok: true });
      if (peer.userId !== user.id) return send(res, 403, { error: 'You cannot remove another participant.' });
      room.peers.delete(peerId);
      room.signals.delete(peerId);
      return send(res, 200, { ok: true });
    }

    if (action === 'presence' && method === 'POST') {
      const body = await readJson(req);
      const peer = room.peers.get(String(body.peerId || ''));
      if (!peer || peer.userId !== user.id) return send(res, 403, { error: 'Join the meeting before updating presence.' });
      if (peer) peer.lastSeen = Date.now();
      return send(res, 200, { ok: Boolean(peer) });
    }

    if (action === 'peers' && method === 'GET') {
      const peerId = url.searchParams.get('peerId') || '';
      if (room.peers.get(peerId)?.userId !== user.id) return send(res, 403, { error: 'Join the meeting to view participants.' });
      return send(res, 200, { peers: [...room.peers.values()].map(({ id, name, initials: mark }) => ({ id, name, initials: mark })) });
    }

    if (action === 'signals' && method === 'GET') {
      const peerId = url.searchParams.get('peerId') || '';
      if (room.peers.get(peerId)?.userId !== user.id) return send(res, 403, { error: 'Join the meeting to receive call signals.' });
      const queue = room.signals.get(peerId) || [];
      room.signals.set(peerId, []);
      return send(res, 200, { signals: queue });
    }

    if (action === 'signals' && method === 'POST') {
      const body = await readJson(req);
      const from = String(body.from || '');
      const to = String(body.to || '');
      if (room.peers.get(from)?.userId !== user.id || !room.peers.has(to)) return send(res, 403, { error: 'Both participants must be in the meeting.' });
      const type = String(body.type || '');
      if (!['offer', 'answer', 'candidate'].includes(type)) return send(res, 400, { error: 'Unsupported call signal.' });
      const queue = room.signals.get(to) || [];
      if (queue.length > 100) queue.splice(0, queue.length - 100);
      queue.push({ from, type, payload: body.payload });
      room.signals.set(to, queue);
      return send(res, 202, { ok: true });
    }
  }

  return send(res, 404, { error: 'API route not found.' });
}

function serveStatic(req, res, url) {
  const route = url.pathname.replace(/\/+$/, '').toLowerCase();
  const isAdminPage = route === '/admin' || route === '/admin/setup';
  let relativePath = decodeURIComponent(url.pathname === '/' || isAdminPage ? '/index.html' : url.pathname);
  if (relativePath.includes('..')) return send(res, 400, 'Invalid path.');
  const filePath = path.join(PUBLIC_DIR, relativePath.replace(/^[/\\]+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden.');
  fs.readFile(filePath, (error, contents) => {
    if (error) return send(res, 404, 'Not found.');
    res.writeHead(200, {
      'Content-Type': mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss:; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    });
    res.end(contents);
  });
}

function attachSocketHandlers(io) {
  io.use((socket, next) => {
    const session = getSession(socket.request);
    const user = session && (session.guest ? session.guestUser : users.get(session.userId));
    if (!session || !user || socket.handshake.auth?.csrfToken !== session.csrf || !isSameOrigin(socket.request)) {
      return next(new Error('Authentication required.'));
    }
    socket.data.user = user;
    next();
  });

  io.on('connection', (socket) => {
    let membership = null;
    const reply = (ack, result) => { if (typeof ack === 'function') ack(result); };

    const leaveRoom = (removePeer = true) => {
      if (!membership) return;
      const { roomId, peerId } = membership;
      const room = rooms.get(roomId);
      const peer = room?.peers.get(peerId);
      socket.leave(`room:${roomId}`);
      if (peer?.socketId === socket.id) {
        if (removePeer) {
          room.peers.delete(peerId);
          room.signals.delete(peerId);
          socket.to(`room:${roomId}`).emit('room:peer-left', { id: peerId });
        } else {
          delete peer.socketId;
        }
      }
      membership = null;
    };

    socket.on('room:join', (data = {}, ack) => {
      const roomId = String(data.roomId || '').toUpperCase();
      const peerId = String(data.peerId || '');
      const room = rooms.get(roomId);
      const peer = room?.peers.get(peerId);
      if (!room || !peer || peer.userId !== socket.data.user.id || !/^[A-F0-9]{12}$/i.test(roomId) || !/^[\w-]{8,64}$/.test(peerId)) {
        return reply(ack, { ok: false, error: 'Join the meeting before connecting real-time signaling.' });
      }
      leaveRoom();
      membership = { roomId, peerId };
      peer.socketId = socket.id;
      peer.lastSeen = Date.now();
      socket.join(`room:${roomId}`);
      socket.to(`room:${roomId}`).emit('room:peer-joined', { id: peer.id, name: peer.name, initials: peer.initials });
      reply(ack, { ok: true });
    });

    socket.on('room:signal', (data = {}, ack) => {
      const room = membership && rooms.get(membership.roomId);
      const targetId = String(data.to || '');
      const target = room?.peers.get(targetId);
      const allowedType = ['offer', 'answer', 'candidate'].includes(data.type);
      if (!room || data.roomId !== membership.roomId || data.from !== membership.peerId || !target || targetId === membership.peerId || !allowedType) {
        return reply(ack, { ok: false, delivered: false, error: 'Invalid room signal.' });
      }
      const targetSocket = target.socketId && io.sockets.sockets.get(target.socketId);
      if (!targetSocket) return reply(ack, { ok: true, delivered: false });
      targetSocket.emit('room:signal', { from: membership.peerId, type: data.type, payload: data.payload });
      reply(ack, { ok: true, delivered: true });
    });

    socket.on('room:leave', (data = {}, ack) => {
      if (membership && data.roomId === membership.roomId && data.peerId === membership.peerId) leaveRoom();
      reply(ack, { ok: true });
    });

    socket.on('disconnect', () => leaveRoom(false));
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/socket.io/socket.io.js' && !SocketServer) {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end('/* Optional Socket.IO client is not installed. */');
    }
    if (SocketServer && url.pathname.startsWith('/socket.io/')) return;
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed.');
    return serveStatic(req, res, url);
  } catch (error) {
    if (!res.headersSent) send(res, error.status || 500, { error: error.status ? error.message : 'Something went wrong. Please try again.' });
    else res.destroy();
    if (!error.status) console.error(error);
  }
});

if (SocketServer) {
  socketServer = new SocketServer(server, { maxHttpBufferSize: MAX_BODY, serveClient: true });
  attachSocketHandlers(socketServer);
}

server.listen(PORT, () => {
  console.log(`Meeting is ready at http://localhost:${PORT}`);
  if (process.env.NODE_ENV !== 'production' && !process.env.SESSION_SECRET) {
    console.log('Set SESSION_SECRET to a stable secret before running multiple server instances.');
  }
});

setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [id, session] of sessions) {
    if (session.expiresAt < now) { sessions.delete(id); changed = true; }
  }
  for (const [id, room] of rooms) {
    pruneRoom(room);
    if (!room.peers.size && now - Date.parse(room.createdAt) > ROOM_RETENTION) { rooms.delete(id); changed = true; }
  }
  if (changed) persistStore();
}, 60_000).unref();
