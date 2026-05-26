# Deploying Delta Capital

You'll deploy two services to make this app publicly accessible:

1. **Sidecar** (Python data layer) → **Render** free tier
2. **Frontend** (React app) → **Vercel** free tier

Total time: ~15 minutes. Cost: $0.

---

## Step 1 — Push the code to GitHub

```bash
cd ~/Desktop/delta-capital
git init
git add .
git commit -m "Initial commit"
gh repo create delta-capital --public --source=. --push
```

(Or do it via the github.com UI if you don't have `gh` installed.)

---

## Step 2 — Deploy the sidecar to Render

1. Go to https://render.com and sign in with GitHub (free).
2. Click **New + → Blueprint**.
3. Pick your `delta-capital` repo. Render will read `render.yaml` automatically.
4. Click **Apply**. Wait ~3 minutes for the build.
5. When done, copy the public URL — looks like `https://delta-capital-sidecar.onrender.com`.
6. Test it: visit `https://delta-capital-sidecar.onrender.com/health` — should return `{"ok":true}`.

**About the free tier**: the sidecar spins down after 15 minutes of inactivity, so the first visit after a quiet period has a ~30 second cold start. After that, it's snappy until idle again. Acceptable for a personal/small-group tool.

---

## Step 3 — Deploy the frontend to Vercel

1. Go to https://vercel.com and sign in with GitHub (free).
2. Click **Add New… → Project** and import your `delta-capital` repo.
3. Vercel auto-detects Vite. Don't touch the build settings.
4. **Add an environment variable**:
   - Key: `VITE_API_URL`
   - Value: the Render URL from Step 2, e.g. `https://delta-capital-sidecar.onrender.com`
5. Click **Deploy**. Wait ~1 minute.
6. Your app is live at `https://delta-capital-<random>.vercel.app`. Share that link.

---

## Step 4 — Verify

Open your Vercel URL. The app should:
1. Show "Loading ticker universe…" briefly
2. Pull 900 tickers from your sidecar
3. Populate the table over ~3 minutes
4. Refresh button hits the sidecar with `?fresh=1`

If you see "No data returned from Yahoo Finance" — that means Yahoo's WAF has blocked Render's IP. See **Troubleshooting** below.

---

## Troubleshooting

### "No data returned from Yahoo Finance"
Yahoo blocked the Render datacenter IP. The honest fix is to swap from yfinance to a keyed API like Finnhub:

1. Sign up free at https://finnhub.io/register
2. Copy the API key
3. In Render: add an env var `FINNHUB_KEY` = `<your key>`
4. Tell me — I'll rewrite the sidecar to use Finnhub. The rest of the app is unchanged.

### "Cold start is slow"
Render free spins down after 15 min idle. Options:
- **Live with it**: 30s wait once or twice a day if no one's been using it
- **Free uptime ping**: set up https://uptimerobot.com to ping `/health` every 5 minutes — keeps the sidecar warm (just don't ping too aggressively or you'll waste Render's free hours)
- **Upgrade**: Render's $7/mo Starter plan removes the spin-down

### "I want a custom domain"
Both Vercel and Render let you attach a custom domain for free. Buy a domain (~$10/yr) at Namecheap/Cloudflare, then add it in each service's dashboard.

### "Local dev still works, right?"
Yes — the frontend reads `VITE_API_URL` from env, but falls back to `/api` (which Vite proxies to `localhost:8001`) when the env var isn't set. So:
- Local: just run `python sidecar.py` and `npm run dev`, no env var needed
- Production: the env var on Vercel points to Render

---

## Quick-reference URLs after deploy

| Service | URL | Purpose |
|---|---|---|
| Frontend | `https://delta-capital-<id>.vercel.app` | Share this with users |
| Sidecar API | `https://delta-capital-sidecar.onrender.com` | Internal — not for users |
| Sidecar health | `…/health` | Confirm sidecar is up |
| Universe | `…/universe` | The ~900 ticker list |
| Quote | `…/stock/AAPL` | Fundamentals + returns for one ticker |
