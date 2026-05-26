import { useState, useEffect, useRef } from "react";

// ── Config ─────────────────────────────────────────────────────────────────
const CACHE_KEY = "delta-capital-cache-v4";
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes — Yahoo free is already 15-min delayed,
                                  // so caching beyond a few minutes adds no real value

// Universe is fetched live from the sidecar's /universe endpoint
// (S&P 500 large-cap + S&P 400 mid-cap = ~900 US stocks)

// ── API ────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Sidecar URL: production sets VITE_API_URL to the deployed Render URL,
// local dev uses /api which proxies to localhost:8001 via vite.config.js
const API_BASE = import.meta.env.VITE_API_URL || "/api";

// One call per ticker to our Python sidecar (FastAPI + yfinance + curl_cffi).
// The sidecar returns a unified shape already aligned to what loadData wants.
const fetchStock = async (ticker, { fresh = false, attempt = 0 } = {}) => {
  try {
    const qs = fresh ? "?fresh=1" : "";
    const r = await fetch(`${API_BASE}/stock/${encodeURIComponent(ticker)}${qs}`);
    if (!r.ok && attempt < 2) {
      await sleep(400 * Math.pow(2, attempt));
      return fetchStock(ticker, { fresh, attempt: attempt + 1 });
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    if (attempt < 2) {
      await sleep(400 * Math.pow(2, attempt));
      return fetchStock(ticker, { fresh, attempt: attempt + 1 });
    }
    throw e;
  }
};

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

const scoreAll = (stocks) => {
  if (!stocks.length) return stocks;
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
  return stocks.map((s, i) => ({
    ...s,
    momentumScore: percentile(momRaw[i],  momRaw),
    qualityScore:  percentile(qualRaw[i], qualRaw),
    valueScore:    percentile(valRaw[i],  valRaw),
    lowVolScore:   percentile(betaRaw[i], betaRaw, true),
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
  const [view, setView]           = useState("screen"); // "screen" | "picks"

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
      setMsg("Loading ticker universe…");
      const uniRes = await fetch(`${API_BASE}/universe`);
      if (!uniRes.ok) throw new Error("Failed to load universe");
      const { tickers: universe } = await uniRes.json();

      setPhase("enriching");
      setMsg(`Loading fundamentals for ${universe.length} US stocks (this takes ~30s)…`);
      setProgress(0);

      let done = 0;
      const rows = await batchFetch(universe, async (ticker) => {
        try {
          const row = await fetchStock(ticker, { fresh: forceRefresh });
          tick(1);
          setProgress(Math.round(++done / universe.length * 100));
          return row;
        } catch {
          tick(1);
          setProgress(Math.round(++done / universe.length * 100));
          return null;
        }
      }, 8);

      const merged = rows
        .filter(s => s && s.price > 0 && s.marketCap > 0)
        .sort((a, b) => b.marketCap - a.marketCap);

      if (!merged.length) throw new Error("No data returned from Yahoo Finance. Check your connection or try again.");

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
          {[["screen", "Screen"], ["picks", "Picks"]].map(([k, label]) => (
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
              <HelpItem term="Percentile Rank" def="Each factor score is a percentile rank across all enriched stocks in the universe. A score of 80 means the stock is in the top 20% on that factor; 50 is the median." />
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
          Equal-weight allocation. Conviction score = composite × (1 + analyst implied upside / 30). Sector cap: 30% per sector. Model output based on your current factor weights — adjust the sliders to re-rank. Educational tool, not investment advice.
        </div>
      </div>
    </div>
  );
}
