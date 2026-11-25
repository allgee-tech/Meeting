# Meeting

A Node.js video meeting and collaboration app built with browser WebRTC.

## Run locally

Use Node.js 20 or newer:

```sh
npm install
npm start
```

Open <http://localhost:3000>. In development, verification and password-reset links are printed in the server terminal when SMTP is not configured. Guests can join an existing room from an invite link or room code without creating an account.

## Included

- Multi-user audio and video calls over peer-to-peer WebRTC, with Socket.IO signaling when installed.
- Screen sharing, camera-track restoration, room chat, whiteboard drawing, and encrypted WebRTC data-channel file transfer.
- Room codes and shareable invite links.
- Email/password sign-in, email verification, password reset, salted scrypt password hashes, signed HttpOnly session cookies, SameSite protection, and CSRF tokens.
- Account-free meeting joins with temporary, room-scoped guest sessions.
- SMTP delivery for verification and password-recovery emails with expiring, hashed tokens and public-route rate limits.
- A responsive workspace, meeting lobby, participant panel, privacy details, and role-protected admin dashboard.
- Account and meeting-room history in a local JSON store. Shared files are retained in the browser's IndexedDB library.

The local JSON store and in-memory room signaling are intended for one server instance. Set `MEETING_DATA_DIR` to a persistent private volume when deploying; use a shared database and signaling service before scaling horizontally. WebRTC media and data channels use DTLS encryption. Serve the app over HTTPS in production, keep `SESSION_SECRET` private and stable, and configure a TURN relay for users behind restrictive networks. The included public STUN server does not replace TURN.

Copy `.env.example` to `.env` for local configuration. For deployment, set SMTP credentials, the HTTPS app URL, and a random session secret in the hosting platform's environment settings. Production startup rejects missing email settings or a short session secret.

## Deploy on Railway

1. Create a Railway project from this repository. Railway will use [railway.toml](./railway.toml) and the `npm start` script.
2. Add a Railway Volume mounted at `/data`, then set `MEETING_DATA_DIR=/data` in the service variables. Without a volume, the local JSON store can be lost when the service is redeployed or moved to a new instance.
3. Add these production variables:

   - `NODE_ENV=production`
   - `SESSION_SECRET` — a random value of at least 32 characters
   - `APP_BASE_URL` — the public HTTPS URL assigned by Railway or your custom domain
   - `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, and `SMTP_FROM`
   - `SMTP_USER` and `SMTP_PASS` when required by your SMTP provider

Railway supplies `PORT`; do not hard-code it in the service settings. `ADMIN_EMAIL`, `TRUST_PROXY`, and TURN variables are optional. The configured health check is `/api/health`.

The included JSON store and in-memory signaling support one Railway instance. Use a database and shared signaling layer before scaling the service horizontally.

## Configuration

Generate a production session secret with:

```sh
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

- `PORT` — HTTP port; Railway supplies this in production and the local default is `3000`.
- `SESSION_SECRET` — stable random secret for signed sessions.
- `ADMIN_EMAIL` — optional comma-separated email allowlist for additional admin-dashboard access. `deiyeshua05@gmail.com` is always an admin. Accounts must be verified.
- `APP_BASE_URL` — public Meeting origin used in verification and password-reset links, such as `https://meet.example.com`. Required for production email delivery.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` — SMTP connection and sender settings. Port `465` uses TLS automatically.
- `MEETING_DATA_DIR` — private persistent directory for the account, session, and room store; defaults to `.data` in the project folder.
- `TURN_URLS` — optional comma-separated TURN server URLs.
- `TURN_SHARED_SECRET` — server-side coturn REST secret. Static-provider credentials can use `TURN_USERNAME` and `TURN_CREDENTIAL` instead.
- `NODE_ENV=production` — enables secure cookies and production validation.
- `TRUST_PROXY=true` — use only when a trusted reverse proxy overwrites `X-Forwarded-For`.
