import { useState, useEffect, useRef, useMemo } from "react";

// ── Config ─────────────────────────────────────────────────────────────────
const CACHE_KEY = "delta-capital-cache-v4";
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes — Yahoo free is already 15-min delayed,
                                  // so caching beyond a few minutes adds no real value

// Universe is fetched live from the sidecar's /universe endpoint
// (S&P 500 large-cap + S&P 400 mid-cap = ~900 US stocks)

// ── API ────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Static data URL — refreshed hourly by GitHub Actions (see .github/workflows/refresh-data.yml).
// Override with VITE_DATA_URL to point at a different fork or branch.
const DATA_URL = import.meta.env.VITE_DATA_URL ||
  "https://raw.githubusercontent.com/hzisow/delta-capital/data/data.json";

const batchFetch = async (items, fn, concurrency = 8) => {
  const out = Array(items.length).fill(null);
  let i = 0;
  const go = async () => {
    while (i < items.length) {
      const j = i++;
      try { out[j] = await fn(items[j]); } catch {}
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, go));
  return out;
};

// ── Scoring ────────────────────────────────────────────────────────────────
const percentile = (v, arr, invert = false) => {
  const vals = arr.filter(x => x != null && isFinite(x));
  if (!vals.length || v == null || !isFinite(v)) return 50;
  const sorted = [...vals].sort((a, b) => a - b);
  const rank = Math.round((sorted.filter(x => x < v).length / (sorted.length - 1 || 1)) * 100);
  return invert ? 100 - rank : rank;
};

// Percentile rank within a specific subset of indices. Returns an array of
// scores aligned to the original `raw` array; positions outside `indices`
// get a neutral 50.
const percentileWithin = (raw, indices, invert = false) => {
  const out = new Array(raw.length).fill(50);
  const subset = indices.map(i => raw[i]).filter(v => v != null && isFinite(v));
  if (subset.length < 2) return out;  // not enough peers to rank meaningfully
  const sorted = [...subset].sort((a, b) => a - b);
  for (const i of indices) {
    const v = raw[i];
    if (v == null || !isFinite(v)) { out[i] = 50; continue; }
    const rank = Math.round((sorted.filter(x => x < v).length / (sorted.length - 1 || 1)) * 100);
    out[i] = invert ? 100 - rank : rank;
  }
  return out;
};

const SECTOR_MIN_PEERS = 5;  // below this, a sector falls back to global rank

const scoreAll = (stocks) => {
  if (!stocks.length) return stocks;

  // Step 1: compute raw factor values across the whole universe
  const momRaw  = stocks.map(s => s.ret1Y != null && s.ret1M != null ? s.ret1Y - s.ret1M : null);
  const qualRaw = stocks.map(s => {
    if (s.roeTTM == null) return null;
    const roe = Math.min(200, Math.max(-50, s.roeTTM));
    const fcf = s.freeCashFlowYieldTTM != null ? Math.min(50, s.freeCashFlowYieldTTM * 100) : 0;
    const dte = s.debtToEquityTTM != null ? -Math.min(10, Math.max(0, s.debtToEquityTTM)) * 3 : 0;
    return roe * 0.5 + fcf * 0.3 + dte * 0.2;
  });
  const valRaw = stocks.map(s => {
    const ey  = s.earningsYieldTTM != null ? Math.min(30, Math.max(-10, s.earningsYieldTTM * 100)) : null;
    const ipb = s.pbRatioTTM > 0  ? 100 / s.pbRatioTTM  : null;
    const iev = s.evEbitdaTTM > 0 ? 100 / s.evEbitdaTTM : null;
    if (ey == null && ipb == null) return null;
    return (ey ?? 0) * 0.4 + (ipb ?? 0) * 0.35 + (iev ?? 0) * 0.25;
  });
  const betaRaw = stocks.map(s => s.beta);

  // Step 2: group stock indices by sector
  const sectorIdx = {};
  stocks.forEach((s, i) => {
    const sec = s.sector || "Unknown";
    (sectorIdx[sec] = sectorIdx[sec] || []).push(i);
  });

  // Step 3: rank within each sector that has enough peers. Small sectors
  // fall back to global rank (otherwise everyone gets 50 and the factor
  // loses signal).
  const momScore  = new Array(stocks.length).fill(50);
  const qualScore = new Array(stocks.length).fill(50);
  const valScore  = new Array(stocks.length).fill(50);
  const volScore  = new Array(stocks.length).fill(50);
  const allIdx    = stocks.map((_, i) => i);

  // Pre-compute global rankings once (used for small-sector fallback)
  const globalMom  = percentileWithin(momRaw,  allIdx);
  const globalQual = percentileWithin(qualRaw, allIdx);
  const globalVal  = percentileWithin(valRaw,  allIdx);
  const globalVol  = percentileWithin(betaRaw, allIdx, true);

  for (const [sec, idxs] of Object.entries(sectorIdx)) {
    if (idxs.length >= SECTOR_MIN_PEERS) {
      // Sector-neutral: rank within this sector's peer group
      const m = percentileWithin(momRaw,  idxs);
      const q = percentileWithin(qualRaw, idxs);
      const v = percentileWithin(valRaw,  idxs);
      const l = percentileWithin(betaRaw, idxs, true);
      for (const i of idxs) {
        momScore[i] = m[i]; qualScore[i] = q[i];
        valScore[i] = v[i]; volScore[i] = l[i];
      }
    } else {
      // Tiny sector — fall back to global rank
      for (const i of idxs) {
        momScore[i] = globalMom[i];  qualScore[i] = globalQual[i];
        valScore[i] = globalVal[i];  volScore[i] = globalVol[i];
      }
    }
  }

  return stocks.map((s, i) => ({
    ...s,
    momentumScore: momScore[i],
    qualityScore:  qualScore[i],
    valueScore:    valScore[i],
    lowVolScore:   volScore[i],
    hasFullData:   momRaw[i] != null && qualRaw[i] != null,
  }));
};

const composite = (s, w) => {
  const t = w.mom + w.qual + w.val + w.vol || 1;
  return Math.round(
    (s.momentumScore * w.mom + s.qualityScore * w.qual + s.valueScore * w.val + s.lowVolScore * w.vol) / t
  );
};

// ── Formatters ─────────────────────────────────────────────────────────────
const fmtCap = n => {
  if (!n || !isFinite(n)) return "—";
  if (n >= 1e12) return `$${(n / 1e12).toFixed(1)}T`;
  if (n >= 1e9)  return `$${(n / 1e9).toFixed(0)}B`;
  return `$${(n / 1e6).toFixed(0)}M`;
};
const fmtPct = (v, dec = 1) => v != null ? `${v >= 0 ? "+" : ""}${v.toFixed(dec)}%` : "—";
// Suggested holding period derived from which factor dominates the stock's
// composite score (under the user's current weights). Each factor has a
// different empirical decay horizon — momentum reverses in months, quality
// compounds for years.
const HORIZONS = {
  mom:  { label: "3–6 months",  short: "3–6mo",  reason: "Momentum signals decay over 3–6 months as the trade gets crowded — trim before reversal." },
  qual: { label: "1–3 years",   short: "1–3yr",  reason: "Quality compounders reward patience. High-ROE, low-debt, cash-generative businesses are long-term holds." },
  val:  { label: "12–18 months", short: "12–18mo", reason: "Value takes time to be recognized. Mean reversion is slow — give the market a year to close the gap." },
  vol:  { label: "6–12 months", short: "6–12mo", reason: "The low-volatility anomaly is a slow-moving factor that rewards exposure across a market cycle." },
};

const suggestedHorizon = (s, w) => {
  const total = w.mom + w.qual + w.val + w.vol || 1;
  const contribs = {
    mom:  (s.momentumScore ?? 0) * w.mom  / total,
    qual: (s.qualityScore  ?? 0) * w.qual / total,
    val:  (s.valueScore    ?? 0) * w.val  / total,
    vol:  (s.lowVolScore   ?? 0) * w.vol  / total,
  };
  const dominant = Object.entries(contribs).sort((a, b) => b[1] - a[1])[0][0];
  return HORIZONS[dominant];
};

const fmtAgo = (ts) => {
  if (!ts) return "—";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
};

// ── Design tokens — dark grey + white ──────────────────────────────────────
const C = {
  bg:      "#161616",   // deep charcoal
  surf:    "#1E1E1E",   // slightly lighter surface
  surf2:   "#252525",   // card / panel surface
  border:  "#2E2E2E",   // subtle dividers
  border2: "#3A3A3A",   // slightly more visible lines
  text:    "#FFFFFF",   // pure white primary text
  sub:     "#B0B0B0",   // secondary text
  muted:   "#636363",   // placeholder / tertiary
  gain:    "#6FCF97",   // muted green for positive
  loss:    "#EB5757",   // muted red for negative
  mid:     "#AAAAAA",   // neutral / mid score
};

const mono = "'JetBrains Mono', 'Courier New', monospace";

// Score coloring — white for top, grey mid, dimmer for low
const scoreColor = v => v >= 70 ? C.text : v >= 40 ? C.sub : C.muted;
const pctColor   = v => (!v || v >= 0) ? C.gain : C.loss;

// Sector — all white/grey tones to match the monochrome theme
const sc = () => C.sub;

// ── Component ──────────────────────────────────────────────────────────────
export default function DeltaCapital() {
  const [phase, setPhase]         = useState("loading");
  const [msg, setMsg]             = useState("Fetching market universe…");
  const [progress, setProgress]   = useState(0);
  const [errMsg, setErrMsg]       = useState("");
  const [stocks, setStocks]       = useState([]);
  const [scored, setScored]       = useState([]);
  const callsRef = useRef(0);
  const [calls, setCalls]         = useState(0);

  const [weights, setWeights]     = useState({ mom: 35, qual: 30, val: 15, vol: 20 });
  const [topN, setTopN]           = useState(20);
  const [sector, setSector]       = useState("All");
  const [sortKey, setSortKey]     = useState("composite");
  const [search, setSearch]       = useState("");
  const [selected, setSelected]   = useState(null);
  const [aiText, setAiText]       = useState({});
  const [aiLoading, setAiLoading] = useState(null);
  const [showHelp, setShowHelp]   = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [view, setView]           = useState("screen"); // "screen" | "picks" | "backtest"
  const [history, setHistory]     = useState({});

  const tick = (n = 1) => { callsRef.current += n; setCalls(callsRef.current); };

  useEffect(() => { loadData(); }, []);

  async function loadData(forceRefresh = false) {
    setPhase("loading");
    callsRef.current = 0; setCalls(0);
    setStocks([]); setScored([]);

    if (!forceRefresh) {
      try {
        const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
        if (cached && Date.now() - cached.ts < CACHE_TTL && Array.isArray(cached.stocks) && cached.stocks.length) {
          setMsg("Loading cached data…");
          setStocks(cached.stocks);
          setScored(scoreAll(cached.stocks));
          setLastUpdated(cached.ts);
          setPhase("ready");
          return;
        }
      } catch {}
    }

    try {
      setPhase("enriching");
      setMsg("Loading market data…");
      setProgress(10);

      // If user hit Refresh, request the sidecar mark stale entries for priority
      // Single static JSON, refreshed hourly by GitHub Actions.
      // Cache-busting query string makes the Refresh button bypass CDN cache.
      const url = forceRefresh ? `${DATA_URL}?t=${Date.now()}` : DATA_URL;
      const res = await fetch(url, { cache: forceRefresh ? "no-store" : "default" });
      if (!res.ok) throw new Error(`Failed to load data.json (HTTP ${res.status})`);
      const payload = await res.json();
      tick(1);

      setHistory(payload.history || {});
      const rows = payload.stocks || [];

      setProgress(80);
      setMsg(`${rows.length} stocks loaded · refreshed ${payload.generated || "?"}`);

      const merged = rows
        .filter(s => s && s.price > 0 && s.marketCap > 0)
        .sort((a, b) => b.marketCap - a.marketCap);

      if (!merged.length) throw new Error("No data returned. Check that the GitHub Action has run at least once.");

      const now = Date.now();
      try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: now, stocks: merged })); } catch {}

      setStocks(merged);
      setScored(scoreAll(merged));
      setLastUpdated(now);
      setPhase("ready");
    } catch (e) {
      setErrMsg(e.message);
      setPhase("error");
    }
  }

  // ── Computed ───────────────────────────────────────────────────────────
  const SORT = {
    composite: s => s.composite, mom: s => s.momentumScore,
    qual: s => s.qualityScore,   val: s => s.valueScore,
    vol: s => s.lowVolScore,     mktcap: s => s.marketCap,
    ret1D: s => s.ret1D,         ret1Y: s => s.ret1Y,
    price: s => s.price,
  };

  const withComp = scored.map(s => ({ ...s, composite: composite(s, weights) }));
  const sectors  = ["All", ...new Set(withComp.map(s => s.sector).filter(x => x && x !== "Unknown"))].sort();

  let display = [...withComp];
  if (sector !== "All") display = display.filter(s => s.sector === sector);
  if (search.trim()) {
    const q = search.trim().toUpperCase();
    display = display.filter(s => s.ticker.includes(q) || s.name?.toUpperCase().includes(q));
  }
  display.sort((a, b) => ((SORT[sortKey]?.(b) ?? -Infinity) - (SORT[sortKey]?.(a) ?? -Infinity)));

  const portfolio = display.filter(s => s.hasFullData).slice(0, topN);
  const exposure  = portfolio.reduce((acc, s) => { acc[s.sector] = (acc[s.sector] || 0) + 1; return acc; }, {});

  // ── AI ─────────────────────────────────────────────────────────────────
  async function analyze(s) {
    if (aiText[s.ticker] || aiLoading) return;
    setAiLoading(s.ticker);
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": import.meta.env.VITE_ANTHROPIC_API_KEY || "",
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-5", max_tokens: 800,
          system: "Sharp buy-side equity analyst. Direct, data-driven, specific. 3 concise paragraphs. Plain text only.",
          messages: [{ role: "user", content:
            `${s.ticker} (${s.name}, ${s.sector}) — $${s.price?.toFixed(2)}, ${fmtCap(s.marketCap)}, Beta ${s.beta?.toFixed(2) ?? "N/A"}\n` +
            `Returns: 1D ${fmtPct(s.ret1D, 2)}, 1M ${fmtPct(s.ret1M)}, 1Y ${fmtPct(s.ret1Y)}\n` +
            `ROE ${s.roeTTM?.toFixed(1) ?? "N/A"}%, P/E ${s.peRatioTTM?.toFixed(1) ?? "N/A"}, P/B ${s.pbRatioTTM?.toFixed(2) ?? "N/A"}, EV/EBITDA ${s.evEbitdaTTM?.toFixed(1) ?? "N/A"}, D/E ${s.debtToEquityTTM?.toFixed(2) ?? "N/A"}\n` +
            `Factor scores — Mom: ${s.momentumScore}, Qual: ${s.qualityScore}, Val: ${s.valueScore}, LVol: ${s.lowVolScore}, Composite: ${s.composite}\n\n` +
            `What's driving these scores? Strongest part of the bull case? Primary risk to the thesis?`
          }],
        }),
      });
      const d = await r.json();
      setAiText(prev => ({ ...prev, [s.ticker]: d.content?.[0]?.text || "No response." }));
    } catch {
      setAiText(prev => ({ ...prev, [s.ticker]: "Analysis unavailable." }));
    }
    setAiLoading(null);
  }

  // ── Loading ────────────────────────────────────────────────────────────
  if (phase === "loading" && !scored.length) return (
    <div style={{ minHeight: "100vh", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;600&family=Barlow:wght@300;400;600&display=swap" rel="stylesheet" />
      <style>{`@keyframes shimmer{0%{transform:translateX(-100%)}100%{transform:translateX(400%)}}`}</style>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 11, letterSpacing: "0.3em", color: C.muted, textTransform: "uppercase", marginBottom: 16, fontFamily: "'Barlow', sans-serif" }}>
          DELTA CAPITAL
        </div>
        <div style={{ fontSize: 13, color: C.sub, marginBottom: 32, fontFamily: "'Barlow', sans-serif", fontWeight: 300 }}>{msg}</div>
        <div style={{ width: 240, height: 1, background: C.border2, margin: "0 auto", overflow: "hidden", position: "relative" }}>
          <div style={{ position: "absolute", width: "30%", height: "100%", background: C.text, animation: "shimmer 1.6s ease-in-out infinite" }} />
        </div>
      </div>
    </div>
  );

  if (phase === "error") return (
    <div style={{ minHeight: "100vh", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Barlow', sans-serif" }}>
      <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;600&family=Barlow:wght@300;400;600&display=swap" rel="stylesheet" />
      <div style={{ textAlign: "center" }}>
        <div style={{ color: C.loss, fontSize: 12, marginBottom: 10, letterSpacing: "0.1em" }}>CONNECTION ERROR</div>
        <div style={{ color: C.muted, fontSize: 12, marginBottom: 24, maxWidth: 360 }}>{errMsg}</div>
        <button onClick={loadData} style={{ padding: "10px 28px", background: C.text, color: C.bg, border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 12, letterSpacing: "0.1em" }}>
          RETRY
        </button>
      </div>
    </div>
  );

  // ── Table header cell ──────────────────────────────────────────────────
  const Th = ({ label, k, align = "left" }) => (
    <th onClick={() => setSortKey(k)} style={{
      padding: "8px 12px", textAlign: align, fontSize: 10,
      letterSpacing: "0.12em", textTransform: "uppercase",
      color: sortKey === k ? C.text : C.muted,
      cursor: "pointer", userSelect: "none", whiteSpace: "nowrap",
      borderBottom: `1px solid ${C.border2}`,
      background: C.surf, fontWeight: 400,
      fontFamily: "'Barlow', sans-serif",
      position: "sticky", top: 0, zIndex: 10,
      transition: "color 0.15s",
    }}>
      {label}{sortKey === k ? " ↓" : ""}
    </th>
  );

  // ── Main ───────────────────────────────────────────────────────────────
  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "'Barlow', sans-serif", display: "flex", flexDirection: "column" }}>
      <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;600&family=Barlow:wght@300;400;600;700&display=swap" rel="stylesheet" />

      {/* ── HEADER ── */}
      <header style={{
        height: 52, borderBottom: `1px solid ${C.border2}`,
        display: "flex", alignItems: "center", padding: "0 24px",
        gap: 28, background: C.surf, flexShrink: 0,
      }}>
        {/* Logo */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          {/* Simple delta symbol */}
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <polygon points="10,2 19,18 1,18" stroke={C.text} strokeWidth="1.5" fill="none" />
          </svg>
          <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.18em", textTransform: "uppercase", color: C.text }}>
            Delta Capital
          </span>
        </div>

        <div style={{ width: 1, height: 20, background: C.border2 }} />

        {/* Tab nav */}
        <div style={{ display: "flex", gap: 4 }}>
          {[["screen", "Screen"], ["picks", "Picks"], ["backtest", "Backtest"]].map(([k, label]) => (
            <button
              key={k}
              onClick={() => setView(k)}
              style={{
                padding: "5px 14px", fontSize: 11, letterSpacing: "0.14em",
                textTransform: "uppercase", cursor: "pointer",
                background: view === k ? C.text : "transparent",
                color: view === k ? C.bg : C.muted,
                border: `1px solid ${view === k ? C.text : C.border2}`,
                fontFamily: "'Barlow', sans-serif", fontWeight: 600,
                transition: "all 0.15s",
              }}
            >
              {label}
            </button>
          ))}
        </div>

        <div style={{ width: 1, height: 20, background: C.border2 }} />

        {/* Stats */}
        <div style={{ display: "flex", gap: 20, alignItems: "center" }}>
          <span style={{ fontSize: 11, color: C.muted }}>
            <span style={{ color: C.sub, fontFamily: mono }}>{scored.length.toLocaleString()}</span>
            {" "}stocks
          </span>
          <span style={{ fontSize: 11, color: C.muted }}>
            <span style={{ color: C.text, fontFamily: mono }}>{scored.filter(s => s.hasFullData).length}</span>
            {" "}enriched
          </span>
          <span style={{ fontSize: 11, color: C.muted }}>
            <span style={{ color: C.sub, fontFamily: mono }}>{calls}</span>
            {" "}API calls
          </span>
        </div>

        {/* Progress during enrichment */}
        {phase === "enriching" && (
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 80, height: 1, background: C.border2 }}>
              <div style={{ width: `${progress}%`, height: "100%", background: C.text, transition: "width 0.2s" }} />
            </div>
            <span style={{ fontSize: 10, color: C.muted, letterSpacing: "0.05em" }}>{msg}</span>
          </div>
        )}

        <div style={{ flex: 1 }} />

        {/* Freshness + refresh */}
        {lastUpdated && (
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 10, color: C.muted, letterSpacing: "0.05em" }}>
              Updated <span style={{ color: C.sub, fontFamily: mono }}>{fmtAgo(lastUpdated)}</span>
              <span style={{ marginLeft: 6, color: "#7A7A7A" }}>· Yahoo free ≈15min delay</span>
            </span>
            <button
              onClick={() => loadData(true)}
              disabled={phase === "loading" || phase === "enriching"}
              style={{
                padding: "5px 12px", fontSize: 10, letterSpacing: "0.12em",
                textTransform: "uppercase", cursor: "pointer",
                background: "transparent", border: `1px solid ${C.border2}`,
                color: C.sub, fontFamily: "'Barlow', sans-serif",
                transition: "all 0.15s",
              }}
              onMouseEnter={e => { e.currentTarget.style.color = C.text; e.currentTarget.style.borderColor = C.text; }}
              onMouseLeave={e => { e.currentTarget.style.color = C.sub; e.currentTarget.style.borderColor = C.border2; }}
              title="Force refresh — bypass all caches"
            >
              Refresh
            </button>
          </div>
        )}

        {/* Search */}
        <input
          value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search ticker or name…"
          style={{
            padding: "6px 12px", background: C.bg,
            border: `1px solid ${C.border2}`, color: C.text,
            fontSize: 12, outline: "none", width: 200,
            fontFamily: "'Barlow', sans-serif", letterSpacing: "0.03em",
          }}
        />

        {/* Help button */}
        <button
          onClick={() => setShowHelp(true)}
          style={{
            width: 26, height: 26, borderRadius: "50%",
            background: "transparent", border: `1px solid ${C.border2}`,
            color: C.sub, cursor: "pointer", fontSize: 12,
            fontFamily: "'Barlow', sans-serif", letterSpacing: "0.05em",
            display: "flex", alignItems: "center", justifyContent: "center",
            transition: "all 0.15s",
          }}
          onMouseEnter={e => { e.currentTarget.style.color = C.text; e.currentTarget.style.borderColor = C.text; }}
          onMouseLeave={e => { e.currentTarget.style.color = C.sub; e.currentTarget.style.borderColor = C.border2; }}
          title="What everything means"
        >
          ?
        </button>
      </header>

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>

        {/* ── SIDEBAR ── */}
        <aside style={{
          width: 200, borderRight: `1px solid ${C.border2}`,
          padding: "20px 16px", overflowY: "auto",
          background: C.surf, flexShrink: 0,
        }}>

          {/* Factor weights */}
          <div style={{ marginBottom: 28 }}>
            <p style={{ fontSize: 9, color: C.muted, textTransform: "uppercase", letterSpacing: "0.15em", margin: "0 0 14px", fontWeight: 600 }}>
              Factor Weights
            </p>
            {[["mom", "Momentum"], ["qual", "Quality"], ["val", "Value"], ["vol", "Low Vol"]].map(([k, label]) => {
              const tot = weights.mom + weights.qual + weights.val + weights.vol || 1;
              return (
                <div key={k} style={{ marginBottom: 14 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                    <span style={{ fontSize: 11, color: C.sub }}>{label}</span>
                    <span style={{ fontSize: 11, color: C.text, fontFamily: mono }}>
                      {Math.round(weights[k] / tot * 100)}%
                    </span>
                  </div>
                  <input type="range" min={0} max={100} step={5}
                    value={weights[k]}
                    onChange={e => setWeights(w => ({ ...w, [k]: +e.target.value }))}
                    style={{ width: "100%", accentColor: C.text, cursor: "pointer" }}
                  />
                </div>
              );
            })}
          </div>

          {/* Portfolio size */}
          <div style={{ marginBottom: 28 }}>
            <p style={{ fontSize: 9, color: C.muted, textTransform: "uppercase", letterSpacing: "0.15em", margin: "0 0 12px", fontWeight: 600 }}>
              Portfolio Size
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
              {[10, 15, 20, 25, 30].map(n => (
                <button key={n} onClick={() => setTopN(n)} style={{
                  padding: "4px 10px", fontSize: 11, cursor: "pointer",
                  background: topN === n ? C.text : "transparent",
                  color: topN === n ? C.bg : C.muted,
                  border: `1px solid ${topN === n ? C.text : C.border2}`,
                  fontFamily: "'Barlow', sans-serif", transition: "all 0.15s",
                }}>
                  {n}
                </button>
              ))}
            </div>
          </div>

          {/* Sector filter */}
          <div style={{ marginBottom: 28 }}>
            <p style={{ fontSize: 9, color: C.muted, textTransform: "uppercase", letterSpacing: "0.15em", margin: "0 0 10px", fontWeight: 600 }}>
              Sector
            </p>
            {sectors.map(s => (
              <div key={s} onClick={() => setSector(s)} style={{
                padding: "4px 8px", cursor: "pointer", fontSize: 11,
                marginBottom: 1, transition: "all 0.1s",
                color: sector === s ? C.text : C.muted,
                borderLeft: `2px solid ${sector === s ? C.text : "transparent"}`,
                paddingLeft: 10,
              }}>
                {s}
              </div>
            ))}
          </div>

          {/* Exposure */}
          {portfolio.length > 0 && (
            <div>
              <p style={{ fontSize: 9, color: C.muted, textTransform: "uppercase", letterSpacing: "0.15em", margin: "0 0 12px", fontWeight: 600 }}>
                Exposure
              </p>
              {Object.entries(exposure).sort((a, b) => b[1] - a[1]).map(([sec, cnt]) => (
                <div key={sec} style={{ marginBottom: 9 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                    <span style={{ fontSize: 9, color: C.sub }}>{sec.slice(0, 18)}</span>
                    <span style={{ fontSize: 9, color: C.muted, fontFamily: mono }}>
                      {Math.round(cnt / topN * 100)}%
                    </span>
                  </div>
                  <div style={{ height: 1, background: C.border2 }}>
                    <div style={{ width: `${cnt / topN * 100}%`, height: "100%", background: C.sub }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </aside>

        {/* ── TABLE + DETAIL (Screen view) ── */}
        {view === "screen" && (
        <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>

          {/* Table */}
          <div style={{ flex: 1, overflowY: "auto", overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 860 }}>
              <thead>
                <tr>
                  <Th label="#"       k="composite" />
                  <Th label="Ticker"  k="ticker" />
                  <Th label="Company" k="name" />
                  <Th label="Sector"  k="sector" />
                  <Th label="Cap"     k="mktcap"    align="right" />
                  <Th label="Mom"     k="mom"       align="right" />
                  <Th label="Qual"    k="qual"      align="right" />
                  <Th label="Val"     k="val"       align="right" />
                  <Th label="LVol"    k="vol"       align="right" />
                  <Th label="Score"   k="composite" align="right" />
                  <Th label="Price"   k="price"     align="right" />
                  <Th label="1D"      k="ret1D"     align="right" />
                  <Th label="1Y"      k="ret1Y"     align="right" />
                </tr>
              </thead>
              <tbody>
                {display.map((s, i) => {
                  const inTop = i < topN && sector === "All" && !search;
                  const isSel = selected?.ticker === s.ticker;
                  return (
                    <tr
                      key={s.ticker}
                      onClick={() => {
                        setSelected(isSel ? null : s);
                        if (s.hasFullData && !aiText[s.ticker]) analyze(s);
                      }}
                      style={{
                        borderBottom: `1px solid ${C.border}`,
                        background: isSel ? C.surf2 : "transparent",
                        opacity: s.hasFullData ? 1 : 0.35,
                        cursor: "pointer",
                      }}
                      onMouseEnter={e => { if (!isSel) e.currentTarget.style.background = C.surf2; }}
                      onMouseLeave={e => { e.currentTarget.style.background = isSel ? C.surf2 : "transparent"; }}
                    >
                      <td style={{ padding: "8px 12px", fontFamily: mono, fontSize: 11, color: inTop ? C.text : C.muted }}>
                        {i + 1}
                      </td>
                      <td style={{ padding: "8px 12px", fontFamily: mono, fontSize: 12, fontWeight: 600, color: C.text }}>
                        {s.ticker}
                      </td>
                      <td style={{ padding: "8px 12px", fontSize: 11, color: C.sub, maxWidth: 180, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
                        {s.name}
                      </td>
                      <td style={{ padding: "8px 12px", fontSize: 10, color: C.muted, whiteSpace: "nowrap" }}>
                        {s.sector}
                      </td>
                      <td style={{ padding: "8px 12px", fontFamily: mono, fontSize: 11, color: C.muted, textAlign: "right" }}>
                        {fmtCap(s.marketCap)}
                      </td>
                      {[s.momentumScore, s.qualityScore, s.valueScore, s.lowVolScore].map((v, j) => (
                        <td key={j} style={{ padding: "8px 12px", fontFamily: mono, fontSize: 12, fontWeight: 600, color: scoreColor(v), textAlign: "right" }}>
                          {v}
                        </td>
                      ))}
                      <td style={{ padding: "8px 12px", fontFamily: mono, fontSize: 14, fontWeight: 700, color: scoreColor(s.composite), textAlign: "right" }}>
                        {s.composite}
                      </td>
                      <td style={{ padding: "8px 12px", fontFamily: mono, fontSize: 11, color: C.sub, textAlign: "right" }}>
                        ${s.price?.toFixed(2) ?? "—"}
                      </td>
                      <td style={{ padding: "8px 12px", fontFamily: mono, fontSize: 11, color: pctColor(s.ret1D), textAlign: "right" }}>
                        {fmtPct(s.ret1D, 2)}
                      </td>
                      <td style={{ padding: "8px 12px", fontFamily: mono, fontSize: 11, color: pctColor(s.ret1Y), textAlign: "right" }}>
                        {fmtPct(s.ret1Y)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* ── DETAIL PANEL ── */}
          {selected && (
            <div style={{
              width: 340, borderLeft: `1px solid ${C.border2}`,
              padding: 20, overflowY: "auto",
              background: C.surf, flexShrink: 0, fontSize: 12,
            }}>
              {/* Stock header */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20, paddingBottom: 16, borderBottom: `1px solid ${C.border}` }}>
                <div>
                  <div style={{ fontFamily: mono, fontSize: 22, fontWeight: 600, color: C.text, letterSpacing: "0.05em" }}>
                    {selected.ticker}
                  </div>
                  <div style={{ fontSize: 11, color: C.sub, marginTop: 3, lineHeight: 1.4 }}>{selected.name}</div>
                  <div style={{ fontSize: 10, color: C.muted, marginTop: 4, letterSpacing: "0.05em" }}>{selected.sector}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontFamily: mono, fontSize: 18, fontWeight: 600, color: C.text }}>
                    ${selected.price?.toFixed(2)}
                  </div>
                  <div style={{ fontSize: 11, color: pctColor(selected.ret1D), marginTop: 2 }}>
                    {fmtPct(selected.ret1D, 2)}
                  </div>
                  <div style={{ fontSize: 10, color: C.muted, marginTop: 1 }}>{fmtCap(selected.marketCap)}</div>
                </div>
              </div>

              {/* Score grid */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 20 }}>
                {[["Momentum", selected.momentumScore], ["Quality", selected.qualityScore], ["Value", selected.valueScore], ["Low Vol", selected.lowVolScore]].map(([lbl, v]) => (
                  <div key={lbl} style={{ background: C.bg, padding: "12px", border: `1px solid ${C.border}` }}>
                    <div style={{ fontSize: 9, color: C.muted, textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 6 }}>
                      {lbl}
                    </div>
                    <div style={{ fontFamily: mono, fontSize: 22, fontWeight: 600, color: scoreColor(v) }}>{v}</div>
                    <div style={{ marginTop: 6, height: 1, background: C.border2 }}>
                      <div style={{ width: `${v}%`, height: "100%", background: scoreColor(v) }} />
                    </div>
                  </div>
                ))}
              </div>

              {/* Composite */}
              <div style={{ background: C.bg, border: `1px solid ${C.border2}`, padding: "10px 14px", marginBottom: 20, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: "0.12em" }}>Composite Score</span>
                <span style={{ fontFamily: mono, fontSize: 26, fontWeight: 700, color: scoreColor(selected.composite) }}>
                  {selected.composite}
                </span>
              </div>

              {/* Fundamentals */}
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 9, color: C.muted, textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 10, fontWeight: 600 }}>
                  Fundamentals
                </div>
                {[
                  ["P/E (TTM)",   selected.peRatioTTM?.toFixed(1)],
                  ["P/B",         selected.pbRatioTTM?.toFixed(2)],
                  ["EV/EBITDA",   selected.evEbitdaTTM?.toFixed(1)],
                  ["ROE",         selected.roeTTM != null ? `${selected.roeTTM.toFixed(1)}%` : null],
                  ["FCF Yield",   selected.freeCashFlowYieldTTM != null ? `${(selected.freeCashFlowYieldTTM * 100).toFixed(1)}%` : null],
                  ["Debt/Equity", selected.debtToEquityTTM?.toFixed(2)],
                  ["Beta",        selected.beta?.toFixed(2)],
                  ["Market Cap",  fmtCap(selected.marketCap)],
                ].map(([lbl, val]) => (
                  <div key={lbl} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: `1px solid ${C.border}` }}>
                    <span style={{ fontSize: 11, color: C.muted }}>{lbl}</span>
                    <span style={{ fontSize: 11, fontFamily: mono, color: C.text }}>{val ?? "—"}</span>
                  </div>
                ))}
              </div>

              {/* Returns */}
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 9, color: C.muted, textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 10, fontWeight: 600 }}>
                  Returns
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 6 }}>
                  {[["1D", selected.ret1D], ["1M", selected.ret1M], ["3M", selected.ret3M], ["1Y", selected.ret1Y]].map(([lbl, v]) => (
                    <div key={lbl} style={{ background: C.bg, border: `1px solid ${C.border}`, padding: "7px 6px", textAlign: "center" }}>
                      <div style={{ fontSize: 9, color: C.muted, marginBottom: 3, letterSpacing: "0.05em" }}>{lbl}</div>
                      <div style={{ fontSize: 11, fontFamily: mono, fontWeight: 600, color: pctColor(v ?? 0) }}>
                        {fmtPct(v)}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* AI Analysis */}
              <div>
                <div style={{ fontSize: 9, color: C.muted, textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 10, fontWeight: 600 }}>
                  AI Analysis
                </div>
                {aiLoading === selected.ticker ? (
                  <div style={{ fontSize: 11, color: C.muted, fontStyle: "italic" }}>Generating analysis…</div>
                ) : aiText[selected.ticker] ? (
                  <div style={{ fontSize: 11, color: C.sub, lineHeight: 1.8 }}>
                    {aiText[selected.ticker]}
                  </div>
                ) : (
                  <button onClick={() => analyze(selected)} style={{
                    width: "100%", padding: "10px", background: "transparent",
                    border: `1px solid ${C.border2}`, color: C.sub,
                    fontSize: 11, cursor: "pointer", fontFamily: "'Barlow', sans-serif",
                    letterSpacing: "0.08em", textTransform: "uppercase",
                    transition: "all 0.15s",
                  }}
                    onMouseEnter={e => { e.target.style.background = C.bg; e.target.style.color = C.text; e.target.style.borderColor = C.text; }}
                    onMouseLeave={e => { e.target.style.background = "transparent"; e.target.style.color = C.sub; e.target.style.borderColor = C.border2; }}
                  >
                    Generate Analysis
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
        )}

        {/* ── PICKS VIEW ── */}
        {view === "picks" && (
          <PicksView portfolio={portfolio} display={display} weights={weights} topN={topN} C={C} mono={mono} />
        )}

        {/* ── BACKTEST VIEW ── */}
        {view === "backtest" && (
          <BacktestView
            portfolio={portfolio} scored={scored} topN={topN}
            weights={weights} history={history}
            C={C} mono={mono}
          />
        )}
      </div>

      {/* ── HELP MODAL ── */}
      {showHelp && (
        <div
          onClick={() => setShowHelp(false)}
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)",
            display: "flex", alignItems: "center", justifyContent: "center",
            zIndex: 100, padding: 24,
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: C.surf, border: `1px solid ${C.border2}`,
              width: "100%", maxWidth: 760, maxHeight: "88vh",
              overflowY: "auto", padding: "28px 32px",
              fontFamily: "'Barlow', sans-serif",
            }}
          >
            {/* Modal header */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24, paddingBottom: 18, borderBottom: `1px solid ${C.border2}` }}>
              <div>
                <div style={{ fontSize: 11, letterSpacing: "0.25em", color: C.muted, textTransform: "uppercase", marginBottom: 6 }}>
                  Reference
                </div>
                <div style={{ fontSize: 22, fontWeight: 600, color: C.text, letterSpacing: "0.02em" }}>
                  What Everything Means
                </div>
              </div>
              <button
                onClick={() => setShowHelp(false)}
                style={{
                  background: "transparent", border: `1px solid ${C.border2}`,
                  color: C.sub, width: 28, height: 28, cursor: "pointer",
                  fontSize: 14, fontFamily: "inherit",
                }}
              >
                ×
              </button>
            </div>

            {/* Section: model */}
            <HelpSection title="The Model">
              <HelpItem term="Composite Score" def="A weighted average of the four factor scores below, rescaled 0–100. Higher is better. The four weights (sliders in the sidebar) determine how much each factor contributes." />
              <HelpItem term="Sector-Neutral Ranking" def="Each factor score is a percentile rank WITHIN the stock's GICS sector — not against the whole universe. AAPL's P/E gets compared to other tech stocks, not utilities. This is how real factor funds (AQR, BlackRock, etc.) score stocks. A score of 80 means top 20% in that sector on that factor." />
              <HelpItem term="Why sector-neutral matters" def="Tech naturally trades at higher P/Es than energy; utilities run higher debt than software. Without sector adjustment, a 'value' score would just identify cheap sectors, not cheap stocks within their peer group. Sector-neutral isolates the stock-specific signal." />
              <HelpItem term="Small-sector fallback" def="If a sector has fewer than 5 stocks in the universe (rare), those stocks get ranked globally instead — otherwise we'd be comparing one stock to nothing." />
              <HelpItem term="Portfolio" def="The top N stocks by composite score (N is set by the Portfolio Size buttons). Stocks missing key fundamentals are excluded — they show greyed-out in the table." />
            </HelpSection>

            {/* Section: factors */}
            <HelpSection title="The Four Factors">
              <HelpItem term="Momentum" def="12-month return minus 1-month return. Captures medium-term trend while excluding the most recent month, which historically reverses (the '12-1' academic factor). High = strong recent performance excluding short-term noise." />
              <HelpItem term="Quality" def="Composite of ROE (50%), Free Cash Flow yield (30%), and Debt/Equity (20%, inverted). High = profitable, cash-generative, financially sound businesses." />
              <HelpItem term="Value" def="Composite of Earnings Yield (40%), inverted P/B (35%), and inverted EV/EBITDA (25%). High = cheap relative to earnings, book value, and cash flow." />
              <HelpItem term="Low Volatility" def="Inverted Beta. High = low market sensitivity. Empirically, low-vol stocks deliver better risk-adjusted returns than CAPM would predict (the 'low-volatility anomaly')." />
            </HelpSection>

            {/* Section: fundamentals */}
            <HelpSection title="Fundamentals (Detail Panel)">
              <HelpItem term="P/E (TTM)" def="Price-to-earnings, trailing twelve months. How many dollars investors pay per dollar of annual earnings. Lower = cheaper." />
              <HelpItem term="P/B" def="Price-to-book. Market cap divided by shareholder equity. Below 1 = trading below accounting book value." />
              <HelpItem term="EV/EBITDA" def="Enterprise value (market cap + debt − cash) divided by EBITDA. Capital-structure-neutral valuation; preferred for comparing companies with different debt loads." />
              <HelpItem term="ROE" def="Return on Equity. Net income / shareholder equity. Profitability per dollar of book value. >15% is generally strong." />
              <HelpItem term="FCF Yield" def="Free cash flow / market cap. The cash a business generates each year as a percentage of its price. Higher = better." />
              <HelpItem term="Debt / Equity" def="Total debt / shareholder equity. Leverage ratio. >1 means more debt than equity capital; sector-dependent (utilities run high, tech runs low)." />
              <HelpItem term="Beta" def="Stock's sensitivity to overall market moves. Beta of 1 = moves with the market. >1 = more volatile. <1 = defensive." />
              <HelpItem term="Market Cap" def="Share price × shares outstanding. Total equity value of the company." />
            </HelpSection>

            {/* Section: returns */}
            <HelpSection title="Returns">
              <HelpItem term="1D / 1M / 3M / 1Y" def="Total price change over each window (1 day, 1 month, 3 months, 1 year). Green = positive, red = negative." />
            </HelpSection>

            {/* Section: backtest */}
            <HelpSection title="Backtest Tab">
              <HelpItem term="What it does" def={`Simulates "if I had bought today's picks N months ago, equal-weighted, how would I have done?" Compares to SPY (S&P 500 ETF) at 1M, 3M, and 1Y horizons.`} />
              <HelpItem term="Alpha" def="Portfolio return minus SPY return. Positive alpha = the picks beat the index. Negative = they underperformed." />
              <HelpItem term="Hit rate" def="What % of the picks individually beat SPY over the same period. High alpha with low hit rate = a few big winners dragging the average up. High alpha + high hit rate = broad outperformance, more reliable signal." />
              <HelpItem term="Look-ahead bias" def={`The simulation uses TODAY's fundamentals to score historical buys — we don't have point-in-time fundamentals (that's paid data). So this overstates the model's real-world performance. Use it as directional signal, not a profit forecast.`} />
              <HelpItem term="Survivorship bias" def={`The universe (S&P 500 + S&P 400) only includes companies that exist today. Failed companies aren't there. Real backtest results would be a few % lower.`} />
            </HelpSection>

            {/* Section: holding periods */}
            <HelpSection title="Suggested Holding Period (Picks tab)">
              <HelpItem term="How it's derived" def="Each stock's composite score is mostly driven by one of the four factors. We compute factor_score × factor_weight for each, take the dominant one, and assign that factor's empirical decay horizon." />
              <HelpItem term="Momentum-driven (3–6mo)" def="12-1 momentum signals decay in 3–6 months as the trade gets crowded and reverses (Jegadeesh & Titman, 1993). Trim before the reversal." />
              <HelpItem term="Value-driven (12–18mo)" def="Cheap stocks take time to be recognized. Mean reversion in P/E and P/B works on a 1-year+ horizon." />
              <HelpItem term="Quality-driven (1–3 years)" def="High-ROE, low-debt, cash-generative compounders reward patience. Buffett-style buy-and-hold." />
              <HelpItem term="Low-Vol driven (6–12mo)" def="The low-volatility anomaly is a slow-moving factor; defensive positioning rewards a full market cycle of exposure." />
              <HelpItem term="Heads up" def="Reassess if a stock's dominant factor flips, you hit your target price, or the thesis breaks. For comparison, AQR-style factor funds rebalance monthly — these are honest minimums, not maximums." />
            </HelpSection>

            {/* Section: controls */}
            <HelpSection title="Controls">
              <HelpItem term="Factor Weights" def="Sliders that set how much each factor contributes to the composite score. They're auto-normalized — only the ratios matter, not the absolute numbers." />
              <HelpItem term="Portfolio Size" def="How many top-ranked stocks to include in the model portfolio. The Exposure breakdown updates as you change this." />
              <HelpItem term="Sector" def="Filter the table and portfolio to a single GICS sector. 'All' shows everything." />
              <HelpItem term="Exposure" def="Sector breakdown of the current model portfolio. Helps spot concentration risk (e.g. 50% Technology)." />
              <HelpItem term="AI Analysis" def="Click any row to open the detail panel; Claude generates a 3-paragraph buy-side equity note covering what's driving the scores, the bull case, and the primary risk." />
            </HelpSection>

            {/* Footer note */}
            <div style={{ marginTop: 24, paddingTop: 18, borderTop: `1px solid ${C.border2}`, fontSize: 11, color: C.muted, lineHeight: 1.7 }}>
              Data via Yahoo Finance (15-min delayed during market hours). Universe = S&P 500 + S&P MidCap 400 (~900 stocks). Scores are recomputed locally — slide the weights to backtest different factor tilts. Not investment advice.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Help modal helpers ──────────────────────────────────────────────────────
function HelpSection({ title, children }) {
  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{ fontSize: 10, color: "#636363", textTransform: "uppercase", letterSpacing: "0.18em", marginBottom: 12, fontWeight: 600 }}>
        {title}
      </div>
      <div>{children}</div>
    </div>
  );
}

function HelpItem({ term, def }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "160px 1fr", gap: 16, padding: "8px 0", borderBottom: "1px solid #2E2E2E" }}>
      <div style={{ fontSize: 12, color: "#FFFFFF", fontWeight: 600, letterSpacing: "0.02em" }}>{term}</div>
      <div style={{ fontSize: 12, color: "#B0B0B0", lineHeight: 1.6 }}>{def}</div>
    </div>
  );
}

// ── Walk-forward backtest engine ────────────────────────────────────────────
// True point-in-time backtest of the Mom + LowVol factors using only monthly
// price data (no look-ahead). At each month t we:
//   1. Score every ticker using ONLY data available through t
//   2. Pick top N by (mom × wMom + vol × wVol)
//   3. Hold for one month, record return
//   4. Compare to SPY's same-month return
// Quality/Value factors aren't included because we don't have historical
// fundamentals (paid data we don't have access to).
function runWalkForward(history, params) {
  const {
    momLookback = 12,       // months for momentum window (e.g. 12-1 = 12)
    minMomentum = null,     // absolute momentum filter: skip stocks below this return
    topN = 20,              // portfolio size
    momWeight = 65,         // mom % weight in composite
    volWeight = 35,         // vol % weight in composite
    trendFilter = false,    // hold cash when SPY's own momLookback return is negative
  } = params || {};

  const spy = history?.SPY;
  if (!spy || spy.length < momLookback + 2) return null;

  const dates = spy.map(r => r[0]);
  const months = [];
  const minStart = momLookback + 1;

  for (let i = minStart; i < dates.length - 1; i++) {
    const tDate = dates[i];
    const tNext = dates[i + 1];

    // Trend filter on the broad market
    const spyMomStart = spy[i - momLookback][1];
    const spyMomEnd   = spy[i - 1][1];
    const spyMom = spyMomEnd / spyMomStart - 1;
    if (trendFilter && spyMom < 0) {
      // "Cash" position: zero return, but still record SPY return for comparison
      const spyRet = spy[i + 1][1] / spy[i][1] - 1;
      months.push({ date: tNext, portRet: 0, spyRet, pickCount: 0, cash: true });
      continue;
    }

    const candidates = [];
    for (const ticker in history) {
      if (ticker === "SPY") continue;
      const rows = history[ticker];
      const idx = rows.findIndex(r => r[0] === tDate);
      if (idx < momLookback) continue;
      const nextIdx = rows.findIndex(r => r[0] === tNext);
      if (nextIdx < 0) continue;

      const price        = rows[idx][1];
      const priceNext    = rows[nextIdx][1];
      const price1mAgo   = rows[idx - 1][1];
      const priceLookbackAgo = rows[idx - momLookback][1];
      if (!price || !priceNext || !price1mAgo || !priceLookbackAgo) continue;

      // (lookback-1) momentum: return from lookback months ago to 1m ago
      const mom = price1mAgo / priceLookbackAgo - 1;

      // Skip stocks with negative absolute momentum if filter is on
      if (minMomentum != null && mom < minMomentum) continue;

      // Trailing-12-month monthly-return volatility (low vol factor)
      const rets = [];
      const volWindow = Math.min(12, idx);
      for (let j = idx - volWindow + 1; j <= idx; j++) {
        if (rows[j - 1] && rows[j]) rets.push(rows[j][1] / rows[j - 1][1] - 1);
      }
      if (rets.length < 6) continue;
      const meanR = rets.reduce((a, b) => a + b, 0) / rets.length;
      const vol = Math.sqrt(rets.reduce((s, r) => s + (r - meanR) ** 2, 0) / (rets.length - 1));

      candidates.push({ ticker, mom, vol, price, priceNext });
    }

    if (candidates.length < topN) continue;

    // Percentile rank — higher mom = better, lower vol = better
    const byMom = [...candidates].sort((a, b) => a.mom - b.mom);
    const byVol = [...candidates].sort((a, b) => b.vol - a.vol);
    candidates.forEach(c => {
      c.momScore = byMom.indexOf(c) / (candidates.length - 1) * 100;
      c.volScore = byVol.indexOf(c) / (candidates.length - 1) * 100;
    });

    const totalW = momWeight + volWeight || 1;
    candidates.forEach(c => {
      c.composite = (c.momScore * momWeight + c.volScore * volWeight) / totalW;
    });

    const picks = candidates.sort((a, b) => b.composite - a.composite).slice(0, topN);
    const portRet = picks.reduce((s, p) => s + (p.priceNext / p.price - 1), 0) / picks.length;
    const spyRet = spy[i + 1][1] / spy[i][1] - 1;

    months.push({ date: tNext, portRet, spyRet, pickCount: picks.length });
  }

  return months;
}

function computeStats(months) {
  if (!months || months.length === 0) return null;
  const port = months.map(m => m.portRet);
  const spy  = months.map(m => m.spyRet);

  // Cumulative compounded returns
  const cumProd = (rets) => rets.reduce((p, r) => p * (1 + r), 1);
  const portCum = cumProd(port) - 1;
  const spyCum  = cumProd(spy)  - 1;

  const years = months.length / 12;
  const portAnnual = Math.pow(1 + portCum, 1 / years) - 1;
  const spyAnnual  = Math.pow(1 + spyCum,  1 / years) - 1;
  const alphaAnnual = portAnnual - spyAnnual;

  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const std  = (a) => {
    const m = mean(a);
    return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
  };
  // Annualized Sharpe (no risk-free deduction; close enough for relative comparison)
  const sharpePort = (mean(port) / std(port)) * Math.sqrt(12);
  const sharpeSpy  = (mean(spy)  / std(spy))  * Math.sqrt(12);

  // Max drawdown of the strategy
  let peak = 1, cum = 1, maxDD = 0;
  for (const r of port) {
    cum *= (1 + r);
    if (cum > peak) peak = cum;
    const dd = (cum - peak) / peak;
    if (dd < maxDD) maxDD = dd;
  }

  // Hit rate vs SPY (months strategy beat SPY)
  const wins = months.filter(m => m.portRet > m.spyRet).length;

  return {
    monthCount: months.length,
    years,
    portCum, spyCum, alphaCum: portCum - spyCum,
    portAnnual, spyAnnual, alphaAnnual,
    sharpePort, sharpeSpy,
    maxDD,
    hitRate: wins / months.length,
  };
}

// ── Backtest view (walk-forward) ───────────────────────────────────────────
// Strategy presets — each maps to a set of walk-forward params
const STRATEGY_PRESETS = {
  conservative: {
    label: "Conservative",
    blurb: "Low-vol heavy. Smoother ride, lower returns. Holds top 30 by 12-1 mom + vol mix.",
    params: { momLookback: 12, minMomentum: null, topN: 30, momWeight: 35, volWeight: 65, trendFilter: false },
  },
  balanced: {
    label: "Balanced",
    blurb: "Default — mom + low-vol mix, top 20 stocks, monthly rebalance.",
    params: { momLookback: 12, minMomentum: null, topN: 20, momWeight: 65, volWeight: 35, trendFilter: false },
  },
  aggressive: {
    label: "Aggressive",
    blurb: "Pure momentum, short lookback, concentrated top 10, absolute-momentum filter, market-regime gate.",
    params: { momLookback: 6, minMomentum: 0, topN: 10, momWeight: 100, volWeight: 0, trendFilter: true },
  },
};

function BacktestView({ portfolio, scored, topN, weights, history, C, mono }) {
  const [preset, setPreset] = useState("aggressive");
  const hasHistory = history && history.SPY && Object.keys(history).length > 50;

  if (!hasHistory) {
    const tickerCount = Object.keys(history || {}).length;
    return (
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 16, color: C.muted, fontSize: 13, padding: 40 }}>
        <div style={{ fontSize: 11, letterSpacing: "0.2em", textTransform: "uppercase", color: C.sub }}>
          Backtest data warming up
        </div>
        <div style={{ maxWidth: 480, textAlign: "center", lineHeight: 1.6 }}>
          The sidecar is fetching 5 years of monthly price history for {portfolio.length ? "all" : "the"} stocks.
          Currently have history for <span style={{ fontFamily: mono, color: C.text }}>{tickerCount}</span> tickers.
          <br /><br />
          At the current throttle (~0.5s per ticker), full warmup takes ~8 minutes. SPY needs to be cached before any results can compute.
          Refresh this tab in a few minutes.
        </div>
      </div>
    );
  }

  // Run the walk-forward backtest using the selected preset's params
  const presetConfig = STRATEGY_PRESETS[preset];
  const months = useMemo(
    () => runWalkForward(history, presetConfig.params),
    [history, preset]
  );
  const stats = useMemo(() => computeStats(months), [months]);

  if (!months || months.length === 0 || !stats) {
    return (
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: C.muted, fontSize: 13, padding: 40 }}>
        Not enough overlapping history yet — try again once more tickers finish caching.
      </div>
    );
  }

  // Build cumulative-return curves for the chart
  const buildCurve = (key) => {
    let cum = 1;
    return months.map(m => {
      cum *= 1 + m[key];
      return { date: m.date, value: cum };
    });
  };
  const portCurve = buildCurve("portRet");
  const spyCurve  = buildCurve("spyRet");

  const fmtPct = (v) => v == null ? "—" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;
  const retColor = (v) => v == null ? C.muted : v >= 0 ? C.gain : C.loss;

  // Chart dimensions
  const W = 900, H = 280, PAD = 40;
  const allVals = [...portCurve.map(p => p.value), ...spyCurve.map(p => p.value)];
  const yMin = Math.min(...allVals), yMax = Math.max(...allVals);
  const yScale = (v) => H - PAD - ((v - yMin) / (yMax - yMin || 1)) * (H - PAD * 2);
  const xScale = (i) => PAD + (i / (months.length - 1 || 1)) * (W - PAD * 2);

  const buildPath = (curve) =>
    curve.map((p, i) => `${i === 0 ? "M" : "L"}${xScale(i).toFixed(1)},${yScale(p.value).toFixed(1)}`).join(" ");

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "28px 40px", background: C.bg }}>
      <div style={{ maxWidth: 1100, margin: "0 auto" }}>

        {/* Header */}
        <div style={{ marginBottom: 24, paddingBottom: 18, borderBottom: `1px solid ${C.border2}` }}>
          <div style={{ fontSize: 10, letterSpacing: "0.28em", color: C.muted, textTransform: "uppercase", marginBottom: 8 }}>
            Walk-Forward Backtest · {stats.years.toFixed(1)} years · monthly rebalance
          </div>
          <div style={{ fontSize: 24, fontWeight: 600, color: C.text, letterSpacing: "0.01em", marginBottom: 8 }}>
            {presetConfig.label} Strategy vs S&P 500
          </div>
          <div style={{ fontSize: 12, color: C.sub, lineHeight: 1.6, maxWidth: 800, marginBottom: 14 }}>
            Point-in-time backtest, no look-ahead bias. Pick a preset to switch strategies — they re-run instantly.
          </div>

          {/* Preset selector */}
          <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
            {Object.entries(STRATEGY_PRESETS).map(([k, cfg]) => (
              <button
                key={k}
                onClick={() => setPreset(k)}
                style={{
                  padding: "8px 18px", fontSize: 11, letterSpacing: "0.12em",
                  textTransform: "uppercase", cursor: "pointer", fontWeight: 600,
                  background: preset === k ? C.text : "transparent",
                  color: preset === k ? C.bg : C.muted,
                  border: `1px solid ${preset === k ? C.text : C.border2}`,
                  fontFamily: "'Barlow', sans-serif", transition: "all 0.15s",
                }}
              >
                {cfg.label}
              </button>
            ))}
          </div>

          <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.6 }}>
            <strong style={{ color: C.sub }}>{presetConfig.label}:</strong> {presetConfig.blurb}
            <div style={{ marginTop: 6, fontFamily: mono, fontSize: 10, color: "#7A7A7A" }}>
              lookback={presetConfig.params.momLookback}mo · min-mom={presetConfig.params.minMomentum ?? "none"} ·
              top-{presetConfig.params.topN} · mom-weight={presetConfig.params.momWeight}% ·
              vol-weight={presetConfig.params.volWeight}% · trend-filter={presetConfig.params.trendFilter ? "ON" : "OFF"}
            </div>
          </div>
        </div>

        {/* Top-line stats */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12, marginBottom: 28 }}>
          {[
            ["Total return",   fmtPct(stats.portCum),  retColor(stats.portCum)],
            ["vs SPY",         fmtPct(stats.spyCum),   retColor(stats.spyCum)],
            ["Annualized α",   fmtPct(stats.alphaAnnual), retColor(stats.alphaAnnual)],
            ["Sharpe",         stats.sharpePort.toFixed(2), stats.sharpePort > stats.sharpeSpy ? C.gain : C.text],
            ["Max DD",         fmtPct(stats.maxDD),    C.loss],
          ].map(([lbl, val, color]) => (
            <div key={lbl} style={{ background: C.surf, border: `1px solid ${C.border}`, padding: "14px 16px" }}>
              <div style={{ fontSize: 9, color: C.muted, textTransform: "uppercase", letterSpacing: "0.14em", marginBottom: 6 }}>
                {lbl}
              </div>
              <div style={{ fontSize: 20, fontWeight: 600, color, fontFamily: mono }}>{val}</div>
            </div>
          ))}
        </div>

        {/* Cumulative return chart */}
        <div style={{ marginBottom: 28 }}>
          <div style={{ fontSize: 10, letterSpacing: "0.2em", color: C.muted, textTransform: "uppercase", marginBottom: 12, fontWeight: 600 }}>
            Cumulative Return ($1 invested at start)
          </div>
          <div style={{ background: C.surf, border: `1px solid ${C.border}`, padding: 16 }}>
            <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: 280 }}>
              {/* horizontal gridline at y=1 (start value) */}
              <line x1={PAD} x2={W - PAD} y1={yScale(1)} y2={yScale(1)} stroke={C.border2} strokeDasharray="2,3" />
              {/* SPY curve */}
              <path d={buildPath(spyCurve)} fill="none" stroke={C.muted} strokeWidth="1.5" />
              {/* Portfolio curve */}
              <path d={buildPath(portCurve)} fill="none" stroke={C.text} strokeWidth="2" />

              {/* Y axis labels */}
              {[yMin, 1, yMax].map((v, i) => (
                <text key={i} x={PAD - 8} y={yScale(v) + 4} fontSize="9" fill={C.muted} textAnchor="end" fontFamily={mono}>
                  ${v.toFixed(2)}
                </text>
              ))}
              {/* X axis labels: first, middle, last */}
              {[0, Math.floor(months.length / 2), months.length - 1].map(i => (
                <text key={i} x={xScale(i)} y={H - PAD + 16} fontSize="9" fill={C.muted} textAnchor="middle" fontFamily={mono}>
                  {months[i]?.date}
                </text>
              ))}
            </svg>
            <div style={{ display: "flex", gap: 20, marginTop: 12, fontSize: 11 }}>
              <span style={{ color: C.text }}>
                <span style={{ display: "inline-block", width: 18, height: 2, background: C.text, verticalAlign: "middle", marginRight: 6 }} />
                Strategy
              </span>
              <span style={{ color: C.muted }}>
                <span style={{ display: "inline-block", width: 18, height: 2, background: C.muted, verticalAlign: "middle", marginRight: 6 }} />
                SPY
              </span>
            </div>
          </div>
        </div>

        {/* Hit rate + comparison */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 28 }}>
          <div style={{ background: C.surf, border: `1px solid ${C.border}`, padding: "18px 20px" }}>
            <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 8 }}>
              Monthly Hit Rate vs SPY
            </div>
            <div style={{ fontSize: 28, fontWeight: 600, color: stats.hitRate >= 0.5 ? C.gain : C.loss, fontFamily: mono }}>
              {(stats.hitRate * 100).toFixed(1)}%
            </div>
            <div style={{ fontSize: 11, color: C.sub, marginTop: 6 }}>
              Strategy beat SPY in {Math.round(stats.hitRate * months.length)} of {months.length} months
            </div>
          </div>
          <div style={{ background: C.surf, border: `1px solid ${C.border}`, padding: "18px 20px" }}>
            <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 8 }}>
              Annualized Returns
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
              <span style={{ fontSize: 11, color: C.text }}>Strategy</span>
              <span style={{ fontSize: 14, color: retColor(stats.portAnnual), fontFamily: mono, fontWeight: 600 }}>
                {fmtPct(stats.portAnnual)}/yr
              </span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ fontSize: 11, color: C.muted }}>SPY</span>
              <span style={{ fontSize: 13, color: C.sub, fontFamily: mono }}>
                {fmtPct(stats.spyAnnual)}/yr
              </span>
            </div>
          </div>
        </div>

        {/* Caveats — much shorter now since we eliminated look-ahead bias */}
        <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.7, paddingTop: 16, borderTop: `1px solid ${C.border}` }}>
          <div style={{ color: C.sub, marginBottom: 8, fontWeight: 600 }}>Honest caveats:</div>
          <ul style={{ paddingLeft: 18, margin: 0 }}>
            <li><strong>Only Mom + LowVol factors</strong>: Quality/Value can't be backtested without paid historical fundamentals. Their sliders don't affect the backtest result — adjust Mom vs LowVol weights to see different mixes.</li>
            <li><strong>Survivorship bias</strong>: universe is today's S&P 500 + S&P 400. Companies that delisted/went bankrupt aren't here. Real-world results would be a few % lower.</li>
            <li><strong>No transaction costs</strong>: monthly rebalancing in reality has slippage + commissions. Subtract ~0.5-1%/yr.</li>
            <li><strong>Past performance ≠ future</strong>: factor premia decay, regimes change. Use as evidence the factors work historically, not as a return forecast.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

// ── Picks view ──────────────────────────────────────────────────────────────
// Synthesizes everything the model knows into a "what to actually buy" view:
// top conviction picks (composite score × analyst upside), suggested equal-
// weight allocation, sector-diversified portfolio, and an Avoid list.
function PicksView({ portfolio, display, weights, topN, C, mono }) {
  // Compute analyst upside %
  const enriched = display.filter(s => s.hasFullData);

  // Sector-diversified top picks: greedily pick top by composite, but cap any
  // single sector to <=30% of the basket.
  const buildDiversified = (n) => {
    const sorted = [...enriched].sort((a, b) => b.composite - a.composite);
    const picked = [];
    const sectorCount = {};
    const maxPerSector = Math.max(2, Math.ceil(n * 0.30));
    for (const s of sorted) {
      if (picked.length >= n) break;
      const c = sectorCount[s.sector] || 0;
      if (c >= maxPerSector) continue;
      picked.push(s);
      sectorCount[s.sector] = c + 1;
    }
    return picked;
  };

  const picks = buildDiversified(topN);

  // Conviction score: composite blended with analyst target upside (when avail)
  const conviction = (s) => {
    let score = s.composite;
    if (s.analystTarget && s.price) {
      const upside = (s.analystTarget / s.price - 1) * 100;
      // Bonus / penalty up to +/- 10 points based on analyst implied upside
      score += Math.max(-10, Math.min(10, upside / 3));
    }
    return Math.round(score);
  };
  const picksRanked = [...picks]
    .map(s => ({ ...s, conviction: conviction(s) }))
    .sort((a, b) => b.conviction - a.conviction);

  // What drove this score? Identify the top 1-2 factors per stock.
  const drivers = (s) => {
    const f = [
      ["Momentum", s.momentumScore],
      ["Quality",  s.qualityScore],
      ["Value",    s.valueScore],
      ["Low Vol",  s.lowVolScore],
    ].sort((a, b) => b[1] - a[1]);
    return f.slice(0, 2).filter(x => x[1] >= 60).map(x => `${x[0]} ${x[1]}`).join(" · ");
  };

  // Portfolio aggregates
  const avg = (key) => {
    const vals = picksRanked.map(s => s[key]).filter(v => v != null && isFinite(v));
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };
  const equalWeight = picksRanked.length ? 100 / picksRanked.length : 0;
  const sectorBreakdown = picksRanked.reduce((acc, s) => {
    acc[s.sector] = (acc[s.sector] || 0) + 1; return acc;
  }, {});

  // Avoid list: bottom 5 by composite, with full data
  const avoid = [...enriched]
    .sort((a, b) => a.composite - b.composite)
    .slice(0, 5);

  const upsidePct = (s) => s.analystTarget && s.price
    ? (s.analystTarget / s.price - 1) * 100 : null;

  if (!enriched.length) {
    return (
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: C.muted, fontSize: 13 }}>
        Loading data — the Picks tab will populate once stocks finish enriching.
      </div>
    );
  }

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "28px 40px", background: C.bg }}>
      <div style={{ maxWidth: 1100, margin: "0 auto" }}>

        {/* Header */}
        <div style={{ marginBottom: 28, paddingBottom: 18, borderBottom: `1px solid ${C.border2}` }}>
          <div style={{ fontSize: 10, letterSpacing: "0.28em", color: C.muted, textTransform: "uppercase", marginBottom: 8 }}>
            Model Output
          </div>
          <div style={{ fontSize: 24, fontWeight: 600, color: C.text, letterSpacing: "0.01em", marginBottom: 8 }}>
            Top {picksRanked.length} Picks
          </div>
          <div style={{ fontSize: 12, color: C.sub, lineHeight: 1.6, maxWidth: 720 }}>
            Sector-diversified portfolio drawn from the {enriched.length} fully-enriched stocks in your universe. Ranked by conviction = composite score blended with analyst target upside. Equal-weight allocation suggested — change Portfolio Size in the sidebar to resize.
          </div>
        </div>

        {/* Portfolio summary stats */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 12, marginBottom: 32 }}>
          {[
            ["Holdings", picksRanked.length, ""],
            ["Avg Score", Math.round(avg("composite") ?? 0), ""],
            ["Avg Beta", (avg("beta") ?? 0).toFixed(2), ""],
            ["Avg P/E", (avg("peRatioTTM") ?? 0).toFixed(1), ""],
            ["Avg ROE", `${(avg("roeTTM") ?? 0).toFixed(0)}%`, ""],
            ["Per Position", `${equalWeight.toFixed(1)}%`, ""],
          ].map(([lbl, val]) => (
            <div key={lbl} style={{ background: C.surf, border: `1px solid ${C.border}`, padding: "14px 16px" }}>
              <div style={{ fontSize: 9, color: C.muted, textTransform: "uppercase", letterSpacing: "0.14em", marginBottom: 6 }}>
                {lbl}
              </div>
              <div style={{ fontSize: 20, fontWeight: 600, color: C.text, fontFamily: mono }}>
                {val}
              </div>
            </div>
          ))}
        </div>

        {/* Picks table */}
        <div style={{ marginBottom: 36 }}>
          <div style={{ fontSize: 10, letterSpacing: "0.2em", color: C.muted, textTransform: "uppercase", marginBottom: 14, fontWeight: 600 }}>
            Conviction Buys
          </div>
          <div style={{ border: `1px solid ${C.border}` }}>
            {/* Header */}
            <div style={{
              display: "grid",
              gridTemplateColumns: "40px 90px 1fr 130px 80px 100px 80px 90px 90px",
              gap: 16, padding: "10px 16px", background: C.surf,
              fontSize: 9, color: C.muted, letterSpacing: "0.14em",
              textTransform: "uppercase", borderBottom: `1px solid ${C.border2}`,
            }}>
              <div>#</div>
              <div>Ticker</div>
              <div>Why</div>
              <div>Sector</div>
              <div style={{ textAlign: "right" }}>Score</div>
              <div style={{ textAlign: "right" }}>Price → Target</div>
              <div style={{ textAlign: "right" }}>Upside</div>
              <div style={{ textAlign: "right" }}>Weight</div>
              <div style={{ textAlign: "right" }}>Hold</div>
            </div>
            {/* Rows */}
            {picksRanked.map((s, i) => {
              const up = upsidePct(s);
              const upColor = up == null ? C.muted : up >= 0 ? C.gain : C.loss;
              return (
                <div key={s.ticker} style={{
                  display: "grid",
                  gridTemplateColumns: "40px 90px 1fr 130px 80px 100px 80px 90px 90px",
                  gap: 16, padding: "12px 16px",
                  borderBottom: `1px solid ${C.border}`,
                  alignItems: "center",
                }}>
                  <div style={{ fontFamily: mono, fontSize: 12, color: C.muted }}>{i + 1}</div>
                  <div>
                    <div style={{ fontFamily: mono, fontSize: 13, fontWeight: 600, color: C.text }}>
                      {s.ticker}
                    </div>
                    <div style={{ fontSize: 10, color: C.muted, marginTop: 2, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
                      {s.name?.slice(0, 18)}
                    </div>
                  </div>
                  <div style={{ fontSize: 11, color: C.sub, lineHeight: 1.4 }}>
                    {drivers(s) || (
                      <span style={{ color: C.muted }}>Balanced — no standout factor</span>
                    )}
                    {s.recommendation && (
                      <div style={{ fontSize: 9, color: C.muted, marginTop: 3, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                        Analyst: {s.recommendation} ({s.analystCount || "?"})
                      </div>
                    )}
                  </div>
                  <div style={{ fontSize: 10, color: C.muted, whiteSpace: "nowrap" }}>{s.sector}</div>
                  <div style={{ textAlign: "right", fontFamily: mono, fontSize: 16, fontWeight: 700, color: C.text }}>
                    {s.conviction}
                  </div>
                  <div style={{ textAlign: "right", fontFamily: mono, fontSize: 11, color: C.sub }}>
                    <div>${s.price?.toFixed(2)}</div>
                    {s.analystTarget && (
                      <div style={{ fontSize: 10, color: C.muted }}>→ ${s.analystTarget.toFixed(2)}</div>
                    )}
                  </div>
                  <div style={{ textAlign: "right", fontFamily: mono, fontSize: 12, color: upColor }}>
                    {up != null ? `${up >= 0 ? "+" : ""}${up.toFixed(1)}%` : "—"}
                  </div>
                  <div style={{ textAlign: "right", fontFamily: mono, fontSize: 12, color: C.text }}>
                    {equalWeight.toFixed(1)}%
                  </div>
                  <div
                    title={suggestedHorizon(s, weights).reason}
                    style={{ textAlign: "right", fontSize: 11, color: C.sub, cursor: "help" }}
                  >
                    {suggestedHorizon(s, weights).short}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Sector allocation */}
        <div style={{ marginBottom: 36 }}>
          <div style={{ fontSize: 10, letterSpacing: "0.2em", color: C.muted, textTransform: "uppercase", marginBottom: 14, fontWeight: 600 }}>
            Sector Allocation
          </div>
          <div style={{ background: C.surf, border: `1px solid ${C.border}`, padding: "16px 20px" }}>
            {Object.entries(sectorBreakdown).sort((a, b) => b[1] - a[1]).map(([sec, cnt]) => {
              const pct = (cnt / picksRanked.length) * 100;
              return (
                <div key={sec} style={{ marginBottom: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                    <span style={{ fontSize: 11, color: C.sub }}>{sec}</span>
                    <span style={{ fontSize: 11, color: C.text, fontFamily: mono }}>
                      {cnt} · {pct.toFixed(0)}%
                    </span>
                  </div>
                  <div style={{ height: 2, background: C.border2 }}>
                    <div style={{ width: `${pct}%`, height: "100%", background: C.text, transition: "width 0.3s" }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Avoid list */}
        <div style={{ marginBottom: 28 }}>
          <div style={{ fontSize: 10, letterSpacing: "0.2em", color: C.muted, textTransform: "uppercase", marginBottom: 14, fontWeight: 600 }}>
            Avoid (Bottom 5 by Score)
          </div>
          <div style={{ border: `1px solid ${C.border}` }}>
            {avoid.map((s) => {
              const up = upsidePct(s);
              return (
                <div key={s.ticker} style={{
                  display: "grid",
                  gridTemplateColumns: "90px 1fr 130px 80px 90px",
                  gap: 16, padding: "10px 16px",
                  borderBottom: `1px solid ${C.border}`,
                  alignItems: "center", opacity: 0.7,
                }}>
                  <div>
                    <div style={{ fontFamily: mono, fontSize: 13, color: C.sub }}>{s.ticker}</div>
                    <div style={{ fontSize: 10, color: C.muted, marginTop: 2 }}>{s.name?.slice(0, 22)}</div>
                  </div>
                  <div style={{ fontSize: 11, color: C.muted }}>
                    Weakest: {[
                      ["Mom", s.momentumScore], ["Qual", s.qualityScore],
                      ["Val", s.valueScore], ["LVol", s.lowVolScore]
                    ].sort((a, b) => a[1] - b[1]).slice(0, 2).map(x => `${x[0]} ${x[1]}`).join(" · ")}
                  </div>
                  <div style={{ fontSize: 10, color: C.muted }}>{s.sector}</div>
                  <div style={{ textAlign: "right", fontFamily: mono, fontSize: 14, color: C.loss }}>
                    {s.composite}
                  </div>
                  <div style={{ textAlign: "right", fontFamily: mono, fontSize: 11, color: C.muted }}>
                    {up != null ? `${up >= 0 ? "+" : ""}${up.toFixed(0)}%` : "—"}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Disclaimer */}
        <div style={{ fontSize: 10, color: C.muted, lineHeight: 1.7, paddingTop: 16, borderTop: `1px solid ${C.border}` }}>
          Equal-weight allocation. Conviction score = composite × (1 + analyst implied upside / 30). Sector cap: 30% per sector. Factor scores are sector-neutral (ranked vs peers in the same GICS sector). Model output based on your current factor weights — adjust the sliders to re-rank. Educational tool, not investment advice.
        </div>
      </div>
    </div>
  );
}
