# Marketing Intelligence Dashboard

Full-stack marketing dashboard — GA4, Search Console, GBP, Meta, AI via OpenRouter.
Clients sign in with their own Google/Meta accounts. All secrets stay on your server.

---

## Project Structure

```
project/
├── server.js           ← Express backend (all OAuth, API proxy, AI)
├── package.json
├── .env                ← YOUR SECRETS (never committed — in .gitignore)
├── .env.example        ← Template — copy this to .env
├── .gitignore          ← Protects .env and node_modules
└── public/
    └── index.html      ← The dashboard frontend (rename from Marketing_Dashboard_v2.html)
```

---

## Quick Setup (5 steps)

### 1. Install dependencies
```bash
npm install
```

### 2. Set up secrets
```bash
cp .env.example .env
```
Open `.env` and fill in all values (see sections below).

### 3. Create a `public/` folder and move the dashboard
```bash
mkdir public
mv Marketing_Dashboard_v2.html public/index.html
```

### 4. Start the server
```bash
npm run dev        # development (auto-restarts on changes)
npm start          # production
```

### 5. Open the dashboard
```
http://localhost:3000
```

---

## Google Setup

1. Go to **console.cloud.google.com** → New Project
2. Enable these 4 APIs (APIs & Services → Library):
   - Google Analytics Data API
   - Google Search Console API
   - My Business Account Management API
   - Business Profile Performance API
3. APIs & Services → Credentials → Create **OAuth 2.0 Client ID** (Web application)
4. Set **Authorized redirect URIs** to: `http://localhost:3000/auth/google/callback`
   - In production: `https://yourdomain.com/auth/google/callback`
5. Copy the **Client ID** and **Client Secret** into `.env`

> ⚠️ JavaScript Origins don't need to be set — this dashboard uses server-side OAuth (redirect flow), not the GIS client library.

---

## Meta Setup

1. Go to **developers.facebook.com** → My Apps → Create App → Business
2. Add the **Facebook Login** product
3. Settings → Valid OAuth Redirect URIs: `http://localhost:3000/auth/meta/callback`
4. Basic Settings → App Domains: `localhost`
5. Copy **App ID** and **App Secret** into `.env`

> In production, update the redirect URI and domain to your actual domain.

---

## OpenRouter AI Setup

1. Go to **openrouter.ai** → Sign up → Keys → Create Key
2. Copy the key (starts with `sk-or-v1-...`) into `.env`
3. The default model is `anthropic/claude-sonnet-4`. Other options at openrouter.ai/models

---

## Production Deployment (Vercel)

1. Push your project to GitHub (`.env` is gitignored — safe)
2. Go to **vercel.com** → New Project → import your repo
3. In Vercel project settings → Environment Variables, add all keys from `.env`
4. Update `APP_URL` to your Vercel URL (e.g. `https://marketing-dashboard.vercel.app`)
5. Update Google redirect URI to `https://marketing-dashboard.vercel.app/auth/google/callback`
6. Update Meta redirect URI to `https://marketing-dashboard.vercel.app/auth/meta/callback`
7. Set `NODE_ENV=production`

> Note: Vercel runs Node.js serverless functions. The `express-session` will use in-memory storage which resets on cold starts. For production with persistent sessions, switch to a Redis-backed session store (connect-redis) or a database-backed one.

---

## How it works (for clients)

Clients visit your dashboard URL and see:
1. Click **Connect Sources** in the header
2. Click **Sign in with Google** → standard Google consent screen → redirected back
3. Click **Connect with Meta** → standard Meta login → redirected back
4. Click **Sync All Selected** → live data loads with animations

No Client IDs, no App IDs, no API keys. Just sign in.

---

## Security Notes

- OAuth tokens are stored in **server-side sessions** (httpOnly cookies). The browser never sees a raw token.
- The `.env` file is gitignored. Never commit it.
- The `SESSION_SECRET` must be a random 48+ character string. Generate one:
  ```bash
  node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
  ```
- The AI endpoint has a built-in rate limiter: 20 requests per IP per minute.
- Add `NODE_ENV=production` in production to enforce HTTPS-only session cookies.
