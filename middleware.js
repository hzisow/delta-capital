// Vercel Edge Middleware — simple password gate for the whole site.
// Runs before any static file is served. After login, sets a 30-day cookie.
//
// To configure: in Vercel, add an env var SITE_PASSWORD with your chosen value.
//
// Note: this gates the Vercel frontend only. The sidecar API on Render is
// still publicly accessible by URL (just hard to find). Acceptable for
// "friends share a link" use; for stricter security, we'd add API auth too.

export const config = {
  // Run middleware on everything except static assets that don't need auth
  matcher: ['/((?!_next/static|favicon\\.|icons\\.|.*\\.svg|.*\\.png).*)'],
};

export default async function middleware(req) {
  const url = new URL(req.url);
  const password = process.env.SITE_PASSWORD;

  // If no password is set in env, fail open (allow access). Lets us iterate
  // locally without breaking the dev experience.
  if (!password) return;

  const cookieHeader = req.headers.get('cookie') || '';
  const authCookie = cookieHeader
    .split(';')
    .map(c => c.trim())
    .find(c => c.startsWith('delta_auth='))
    ?.split('=')[1];

  const expectedHash = await sha256(password);

  // Already authenticated → pass through
  if (authCookie === expectedHash) return;

  // Handle login form submission
  if (req.method === 'POST' && url.pathname === '/__login') {
    const formData = await req.formData();
    const submitted = (formData.get('password') || '').toString();
    if (submitted === password) {
      const target = url.searchParams.get('next') || '/';
      return new Response(null, {
        status: 302,
        headers: {
          'Set-Cookie': `delta_auth=${expectedHash}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
          Location: target,
        },
      });
    }
    return new Response(loginPage('Wrong password.'), {
      status: 401,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  // Not authed and not a login attempt → serve the login page
  return new Response(loginPage(), {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function loginPage(error = '') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Delta Capital</title>
  <link href="https://fonts.googleapis.com/css2?family=Barlow:wght@300;400;600;700&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; }
    body {
      background: #161616;
      color: #ffffff;
      font-family: 'Barlow', system-ui, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
    }
    .card {
      background: #1E1E1E;
      border: 1px solid #2E2E2E;
      padding: 48px 44px;
      width: 360px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 36px;
    }
    .brand svg { display: block; }
    .brand-text {
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.18em;
      text-transform: uppercase;
    }
    label {
      display: block;
      font-size: 10px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: #636363;
      margin-bottom: 8px;
      font-weight: 600;
    }
    input {
      width: 100%;
      padding: 10px 12px;
      background: #161616;
      border: 1px solid #3A3A3A;
      color: #ffffff;
      font-size: 14px;
      font-family: 'JetBrains Mono', monospace;
      outline: none;
      letter-spacing: 0.05em;
    }
    input:focus { border-color: #ffffff; }
    button {
      margin-top: 20px;
      width: 100%;
      padding: 11px;
      background: #ffffff;
      color: #000000;
      border: none;
      cursor: pointer;
      font-size: 11px;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      font-weight: 700;
      font-family: 'Barlow', sans-serif;
    }
    button:hover { background: #B0B0B0; }
    .err {
      color: #EB5757;
      font-size: 11px;
      margin-top: 16px;
      letter-spacing: 0.03em;
    }
    .hint {
      color: #636363;
      font-size: 10px;
      margin-top: 24px;
      letter-spacing: 0.08em;
      line-height: 1.6;
    }
  </style>
</head>
<body>
  <form class="card" method="POST" action="/__login">
    <div class="brand">
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
        <polygon points="10,2 19,18 1,18" stroke="#ffffff" stroke-width="1.5" fill="none" />
      </svg>
      <span class="brand-text">Delta Capital</span>
    </div>
    <label for="password">Access Password</label>
    <input id="password" type="password" name="password" autofocus required autocomplete="current-password" />
    <button type="submit">Enter</button>
    ${error ? `<div class="err">${error}</div>` : ''}
    <div class="hint">Private quant tool. Ask the owner for access.</div>
  </form>
</body>
</html>`;
}
