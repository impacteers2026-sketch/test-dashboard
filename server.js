// ════════════════════════════════════════════════════════════
//  Marketing Intelligence Dashboard — Backend Server
//  Node.js + Express  |  Copy .env.example → .env and fill it
// ════════════════════════════════════════════════════════════
require('dotenv').config();
const express  = require('express');
const session  = require('express-session');
const axios    = require('axios');
const path     = require('path');

const app = express();

// ── TRUST PROXY — required for Render, Railway, Heroku, etc. ─────────────
// Render sits behind a reverse proxy. Without this flag Express sees every
// request as HTTP (req.secure = false), so secure cookies are never sent
// back to the browser, breaking sessions after the OAuth redirect.
app.set('trust proxy', 1);

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── SECURITY HEADERS ──────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// ── SESSION ───────────────────────────────────────────────
// Tokens are stored server-side in the session. The browser
// only ever sees a signed session cookie — never a raw token.
// ── SESSION ───────────────────────────────────────────────
app.use(session({
  // Use the secret from Render, or a fallback string for testing
  secret : process.env.SESSION_SECRET || 'development_fallback_secret_321', 
  resave : false,
  saveUninitialized: false,
  cookie : {
    // On Render NODE_ENV should be 'production' — always use secure cookies
    // trust proxy (above) ensures req.secure is true even behind Render's proxy
    secure  : process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
    maxAge  : 24 * 60 * 60 * 1000
  }
}));

// ── HEALTH CHECK ──────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true }));


// ═══════════════════════════════════════════════════════════
//  GOOGLE OAUTH  (Authorization Code Flow)
// ═══════════════════════════════════════════════════════════
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/webmasters.readonly',
  'https://www.googleapis.com/auth/business.manage',
  'openid', 'email', 'profile'
].join(' ');

// Step 1 — redirect user to Google
app.get('/auth/google', (req, res) => {
  const params = new URLSearchParams({
    client_id    : process.env.GOOGLE_CLIENT_ID,
    redirect_uri : `${process.env.APP_URL}/auth/google/callback`,
    scope        : GOOGLE_SCOPES,
    response_type: 'code',
    access_type  : 'offline',   // get refresh_token
    prompt       : 'consent'    // force refresh_token on every connect
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

// Step 2 — Google redirects back here with `code`
app.get('/auth/google/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect(`/?error=${encodeURIComponent(error)}`);

  try {
    const { data } = await axios.post('https://oauth2.googleapis.com/token', {
      code,
      client_id    : process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri : `${process.env.APP_URL}/auth/google/callback`,
      grant_type   : 'authorization_code'
    });

    req.session.google = {
      access_token : data.access_token,
      refresh_token: data.refresh_token,
      expiry       : Date.now() + data.expires_in * 1000,
      id_token     : data.id_token
    };
    req.session.save(() => res.redirect('/?connected=google'));
  } catch (e) {
    console.error('Google callback error:', e.response?.data || e.message);
    res.redirect(`/?error=${encodeURIComponent('Google sign-in failed — check server logs')}`);
  }
});

// ── TOKEN REFRESH HELPER ──────────────────────────────────
async function getGoogleToken(session) {
  if (!session.google) throw new Error('Not connected to Google — sign in first');

  // If token has more than 60 s left, return it directly
  if (Date.now() < session.google.expiry - 60_000) return session.google.access_token;

  if (!session.google.refresh_token)
    throw new Error('Google session expired and no refresh token. Please reconnect.');

  const { data } = await axios.post('https://oauth2.googleapis.com/token', {
    refresh_token: session.google.refresh_token,
    client_id    : process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    grant_type   : 'refresh_token'
  });

  session.google.access_token = data.access_token;
  session.google.expiry = Date.now() + data.expires_in * 1000;
  return data.access_token;
}

app.post('/auth/disconnect/google', (req, res) => {
  delete req.session.google;
  req.session.save(() => res.json({ ok: true }));
});


// ═══════════════════════════════════════════════════════════
//  META OAUTH  (Authorization Code Flow)
// ═══════════════════════════════════════════════════════════
const META_SCOPES = [
  'read_insights', 'pages_show_list', 'pages_read_engagement',
  'instagram_basic', 'instagram_manage_insights', 'ads_read'
].join(',');

app.get('/auth/meta', (req, res) => {
  const params = new URLSearchParams({
    client_id   : process.env.META_APP_ID,
    redirect_uri: `${process.env.APP_URL}/auth/meta/callback`,
    scope       : META_SCOPES,
    response_type: 'code'
  });
  res.redirect(`https://www.facebook.com/v21.0/dialog/oauth?${params}`);
});

app.get('/auth/meta/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect(`/?error=${encodeURIComponent(error)}`);

  try {
    const { data } = await axios.get('https://graph.facebook.com/v21.0/oauth/access_token', {
      params: {
        client_id    : process.env.META_APP_ID,
        client_secret: process.env.META_APP_SECRET,
        redirect_uri : `${process.env.APP_URL}/auth/meta/callback`,
        code
      }
    });

    // Exchange short-lived token for long-lived token (60 days)
    const { data: longLived } = await axios.get('https://graph.facebook.com/v21.0/oauth/access_token', {
      params: {
        grant_type       : 'fb_exchange_token',
        client_id        : process.env.META_APP_ID,
        client_secret    : process.env.META_APP_SECRET,
        fb_exchange_token: data.access_token
      }
    });

    req.session.meta = {
      access_token: longLived.access_token,
      expiry      : Date.now() + (longLived.expires_in || 5_184_000) * 1000
    };
    req.session.save(() => res.redirect('/?connected=meta'));
  } catch (e) {
    console.error('Meta callback error:', e.response?.data || e.message);
    res.redirect(`/?error=${encodeURIComponent('Meta sign-in failed — check server logs')}`);
  }
});

app.post('/auth/disconnect/meta', (req, res) => {
  delete req.session.meta;
  req.session.save(() => res.json({ ok: true }));
});


// ═══════════════════════════════════════════════════════════
//  AUTH STATUS  (frontend polls this on load)
// ═══════════════════════════════════════════════════════════
app.get('/auth/status', (req, res) => {
  res.json({
    google: !!req.session.google,
    meta  : !!req.session.meta,
    googleExpiry: req.session.google?.expiry || null,
    metaExpiry  : req.session.meta?.expiry   || null
  });
});


// ═══════════════════════════════════════════════════════════
//  PROPERTIES ENDPOINT
//  Returns all GA4/GSC/GBP/Meta properties for the session.
//  Frontend stores these in memory to drive the selector UI.
// ═══════════════════════════════════════════════════════════
app.get('/api/properties', async (req, res) => {
  const result = {
    google: { ga4: [], gsc: [], gbp: [] },
    meta  : { pages: [], ig: [] }
  };

  // ── GOOGLE ──
  if (req.session.google) {
    try {
      const token = await getGoogleToken(req.session);
      const headers = { Authorization: `Bearer ${token}` };

      const [ga4Res, gscRes, gbpAccRes] = await Promise.allSettled([
        axios.get('https://analyticsadmin.googleapis.com/v1beta/accountSummaries', { headers }),
        axios.get('https://searchconsole.googleapis.com/webmasters/v3/sites', { headers }),
        axios.get('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', { headers })
      ]);

      if (ga4Res.status === 'fulfilled') {
        (ga4Res.value.data.accountSummaries || []).forEach(acct => {
          (acct.propertySummaries || []).forEach(prop => {
            result.google.ga4.push({
              id  : prop.property.replace('properties/', ''),
              name: prop.displayName,
              acct: acct.displayName,
              selected: true
            });
          });
        });
      }

      if (gscRes.status === 'fulfilled') {
        (gscRes.value.data.siteEntry || []).forEach(site => {
          result.google.gsc.push({
            url : site.siteUrl,
            name: site.siteUrl.replace(/https?:\/\//, ''),
            selected: true
          });
        });
      }

      if (gbpAccRes.status === 'fulfilled') {
        for (const acct of (gbpAccRes.value.data.accounts || [])) {
          try {
            const locRes = await axios.get(
              `https://mybusinessinformation.googleapis.com/v1/${acct.name}/locations?readMask=name,title`,
              { headers }
            );
            (locRes.data.locations || []).forEach(loc => {
              result.google.gbp.push({
                id  : loc.name,
                name: loc.title || loc.name,
                acct: acct.accountName || acct.name,
                selected: true
              });
            });
          } catch (e) { console.warn('GBP locations error:', e.message); }
        }
      }
    } catch (e) {
      console.error('Google properties error:', e.response?.data || e.message);
    }
  }

  // ── META ──
  if (req.session.meta) {
    try {
      const { data } = await axios.get('https://graph.facebook.com/v21.0/me/accounts', {
        params: {
          fields      : 'id,name,access_token,instagram_business_account',
          access_token: req.session.meta.access_token
        }
      });

      for (const page of (data.data || [])) {
        result.meta.pages.push({
          id   : page.id,
          name : page.name,
          token: page.access_token,
          selected: true
        });
        if (page.instagram_business_account) {
          try {
            const igRes = await axios.get(
              `https://graph.facebook.com/v21.0/${page.instagram_business_account.id}`,
              { params: { fields: 'username,name', access_token: page.access_token } }
            );
            result.meta.ig.push({
              id       : igRes.data.id,
              name     : igRes.data.username || igRes.data.name,
              pageToken: page.access_token,
              selected : true
            });
          } catch (e) {}
        }
      }
    } catch (e) { console.error('Meta properties error:', e.message); }
  }

  res.json(result);
});


// ═══════════════════════════════════════════════════════════
//  GA4 PROXY
// ═══════════════════════════════════════════════════════════
app.get('/api/ga4/properties', async (req, res) => {
  try {
    const token = await getGoogleToken(req.session);
    const { data } = await axios.get(
      'https://analyticsadmin.googleapis.com/v1beta/accountSummaries',
      { headers: { Authorization: `Bearer ${token}` } }
    );
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/ga4/report/:propertyId', async (req, res) => {
  try {
    const token = await getGoogleToken(req.session);
    const { data } = await axios.post(
      `https://analyticsdata.googleapis.com/v1beta/properties/${req.params.propertyId}:runReport`,
      req.body,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    res.json(data);
  } catch (e) {
    console.error('GA4 report error:', e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data?.error?.message || e.message });
  }
});


// ═══════════════════════════════════════════════════════════
//  SEARCH CONSOLE PROXY
// ═══════════════════════════════════════════════════════════
app.get('/api/gsc/sites', async (req, res) => {
  try {
    const token = await getGoogleToken(req.session);
    const { data } = await axios.get(
      'https://searchconsole.googleapis.com/webmasters/v3/sites',
      { headers: { Authorization: `Bearer ${token}` } }
    );
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/gsc/query', async (req, res) => {
  try {
    const token = await getGoogleToken(req.session);
    const { siteUrl, ...body } = req.body;
    const { data } = await axios.post(
      `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
      body,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    res.json(data);
  } catch (e) {
    console.error('GSC query error:', e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data?.error?.message || e.message });
  }
});


// ═══════════════════════════════════════════════════════════
//  GBP PROXY  (new v1 APIs)
// ═══════════════════════════════════════════════════════════
app.get('/api/gbp/accounts', async (req, res) => {
  try {
    const token = await getGoogleToken(req.session);
    const { data } = await axios.get(
      'https://mybusinessaccountmanagement.googleapis.com/v1/accounts',
      { headers: { Authorization: `Bearer ${token}` } }
    );
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/gbp/locations', async (req, res) => {
  try {
    const token = await getGoogleToken(req.session);
    const { accountName } = req.query;
    const { data } = await axios.get(
      `https://mybusinessinformation.googleapis.com/v1/${accountName}/locations?readMask=name,title`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/gbp/performance', async (req, res) => {
  try {
    const token = await getGoogleToken(req.session);
    const { locationId, ...params } = req.query;
    const { data } = await axios.get(
      `https://businessprofileperformance.googleapis.com/v1/locations/${locationId}:fetchMultiDailyMetricsTimeSeries`,
      { params, headers: { Authorization: `Bearer ${token}` } }
    );
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/gbp/reviews/:reviewId/reply', async (req, res) => {
  try {
    const token = await getGoogleToken(req.session);
    const { locationPath } = req.body;
    const { data } = await axios.put(
      `https://mybusiness.googleapis.com/v4/${locationPath}/reviews/${req.params.reviewId}/reply`,
      { comment: req.body.comment },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ═══════════════════════════════════════════════════════════
//  META PROXY
// ═══════════════════════════════════════════════════════════
app.get('/api/meta/pages', async (req, res) => {
  try {
    if (!req.session.meta) throw new Error('Not connected to Meta');
    const { data } = await axios.get('https://graph.facebook.com/v21.0/me/accounts', {
      params: {
        fields      : 'id,name,access_token,instagram_business_account',
        access_token: req.session.meta.access_token
      }
    });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/meta/insights', async (req, res) => {
  try {
    if (!req.session.meta) throw new Error('Not connected to Meta');
    const { pageId, pageToken, ...params } = req.query;
    const { data } = await axios.get(`https://graph.facebook.com/v21.0/${pageId}/insights`, {
      params: { ...params, access_token: pageToken || req.session.meta.access_token }
    });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/meta/instagram', async (req, res) => {
  try {
    if (!req.session.meta) throw new Error('Not connected to Meta');
    const { igId, pageToken, ...params } = req.query;
    const { data } = await axios.get(`https://graph.facebook.com/v21.0/${igId}/insights`, {
      params: { ...params, access_token: pageToken || req.session.meta.access_token }
    });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/meta/ads', async (req, res) => {
  try {
    if (!req.session.meta) throw new Error('Not connected to Meta');
    const { adAccountId, ...params } = req.query;
    const { data } = await axios.get(`https://graph.facebook.com/v21.0/act_${adAccountId}/insights`, {
      params: { ...params, access_token: req.session.meta.access_token }
    });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ═══════════════════════════════════════════════════════════
//  AI PROXY  (OpenRouter — streaming SSE)
//  Key never leaves server. Client sends messages,
//  server pipes the OpenRouter stream back to the browser.
// ═══════════════════════════════════════════════════════════

// Simple in-memory rate limiter: max 20 AI requests per IP per minute
const aiRateMap = new Map();
function aiRateLimit(req, res, next) {
  const ip  = req.ip;
  const now = Date.now();
  const win = aiRateMap.get(ip) || { count: 0, reset: now + 60_000 };
  if (now > win.reset) { win.count = 0; win.reset = now + 60_000; }
  win.count++;
  aiRateMap.set(ip, win);
  if (win.count > 20) return res.status(429).json({ error: 'Rate limit exceeded — wait a minute' });
  next();
}

app.post('/api/ai/chat', aiRateLimit, async (req, res) => {
  if (!process.env.OPENROUTER_API_KEY) {
    return res.status(503).json({ error: 'AI not configured — add OPENROUTER_API_KEY to .env' });
  }

  // Set up SSE streaming headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    const response = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model   : process.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-4-5',
        messages: req.body.messages,
        system  : req.body.system,
        stream  : true,
        max_tokens: 1024
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'HTTP-Referer': process.env.APP_URL || 'http://localhost:3000',
          'X-Title'     : 'Marketing Intelligence Dashboard'
        },
        responseType: 'stream'
      }
    );

    // Pipe OpenRouter's SSE stream directly to the client
    response.data.on('data', chunk => res.write(chunk));
    response.data.on('end',  ()    => res.end());
    response.data.on('error', e    => { console.error('Stream error:', e); res.end(); });

  } catch (e) {
    const errMsg = e.response?.data?.error?.message || e.message;
    console.error('OpenRouter error:', errMsg);
    res.write(`data: ${JSON.stringify({ error: errMsg })}\n\n`);
    res.end();
  }
});


// ═══════════════════════════════════════════════════════════
//  CATCH-ALL — serve the dashboard for any unknown route
// ═══════════════════════════════════════════════════════════
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── GLOBAL ERROR HANDLER ──────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── START ─────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`\n✅  Marketing Dashboard running`);
  console.log(`   Local:  http://localhost:${PORT}`);
  console.log(`   Env:    ${process.env.NODE_ENV || 'development'}\n`);
});
