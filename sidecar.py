"""
Yahoo Finance sidecar for Delta Capital.

Strategy: persistent disk cache + outbound throttle. Each ticker is fetched
from Yahoo at most once per CACHE_TTL window, and outbound calls to Yahoo
are limited to one every THROTTLE_INTERVAL seconds globally. This means:

  * Cold start (no cache file) → background warmup populates ~900 tickers
    over ~25 min, but the API stays responsive the whole time
  * Subsequent restarts → instant (cache loaded from disk)
  * User requests → always served from cache instantly
  * Yahoo's WAF never sees burst traffic → we don't get blocked

Endpoints:
  GET /stock/{ticker}  -> unified JSON with fundamentals + returns
  GET /universe        -> S&P 500 + MidCap 400 ticker list
  GET /health          -> cache stats
"""
from __future__ import annotations

import io
import json
import os
import threading
import time
from typing import Any

from curl_cffi import requests as curl_requests
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import yfinance as yf

app = FastAPI(title="Delta Capital sidecar")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET"],
    allow_headers=["*"],
)

# ── Config ──────────────────────────────────────────────────────────────────
CACHE_FILE = os.path.join(os.path.dirname(__file__), "stock_cache.json")
CACHE_TTL_SECONDS = 6 * 60 * 60       # refresh anything older than 6h
THROTTLE_INTERVAL = 1.5                # ≥1.5s between outbound Yahoo calls
WARMUP_DELAY_SECONDS = 15              # let server settle before warmup starts

# ── State ───────────────────────────────────────────────────────────────────
# disk cache: { ticker: { data: {...}, ts: epoch_seconds } }
_cache: dict[str, dict] = {}
_cache_lock = threading.Lock()

_throttle_lock = threading.Lock()
_last_call_ts = 0.0

_universe_cache: list[str] | None = None

_session_lock = threading.Lock()
_yf_session = curl_requests.Session(impersonate="chrome")


# ── Disk cache ──────────────────────────────────────────────────────────────
def load_cache():
    global _cache
    if not os.path.exists(CACHE_FILE):
        print(f"[cache] no cache file — cold start")
        return
    try:
        with open(CACHE_FILE) as f:
            _cache = json.load(f)
        print(f"[cache] loaded {len(_cache)} tickers from disk")
    except Exception as e:
        print(f"[cache] load failed: {e}")
        _cache = {}


def save_cache():
    try:
        tmp = CACHE_FILE + ".tmp"
        with open(tmp, "w") as f:
            json.dump(_cache, f)
        os.replace(tmp, CACHE_FILE)
    except Exception as e:
        print(f"[cache] save failed: {e}")


# ── Throttle + fetch ────────────────────────────────────────────────────────
def _wait_throttle():
    global _last_call_ts
    with _throttle_lock:
        wait = THROTTLE_INTERVAL - (time.time() - _last_call_ts)
        if wait > 0:
            time.sleep(wait)
        _last_call_ts = time.time()


def trailing_return(closes: list[float], n: int) -> float | None:
    if not closes or len(closes) < n + 1:
        return None
    end, start = closes[-1], closes[-1 - n]
    if not end or not start:
        return None
    return (end / start - 1.0) * 100.0


def safe(v: Any) -> Any:
    if v is None:
        return None
    try:
        import math
        if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
            return None
    except Exception:
        pass
    if hasattr(v, "item"):
        try:
            return v.item()
        except Exception:
            pass
    return v


def _fetch_from_yahoo(ticker: str) -> dict | None:
    """Single throttled Yahoo round-trip per ticker. Returns None on failure."""
    _wait_throttle()
    try:
        with _session_lock:
            t = yf.Ticker(ticker, session=_yf_session)
            info = t.info or {}
            hist = t.history(period="1y", auto_adjust=True)
        closes = [float(x) for x in hist["Close"].tolist() if x == x]

        price        = safe(info.get("regularMarketPrice")) or safe(info.get("currentPrice"))
        market_cap   = safe(info.get("marketCap"))
        beta         = safe(info.get("beta"))
        sector       = info.get("sector") or "Unknown"
        industry     = info.get("industry") or ""
        name         = info.get("longName") or info.get("shortName") or ticker
        volume       = safe(info.get("regularMarketVolume")) or safe(info.get("volume"))

        roe          = safe(info.get("returnOnEquity"))
        fcf          = safe(info.get("freeCashflow"))
        ebitda       = safe(info.get("ebitda"))
        ev           = safe(info.get("enterpriseValue"))
        trailing_pe  = safe(info.get("trailingPE"))
        price_to_book = safe(info.get("priceToBook"))
        debt_to_eq   = safe(info.get("debtToEquity"))

        return {
            "ticker": ticker.upper(),
            "name": name,
            "sector": sector,
            "industry": industry,
            "price": price if price is not None else (closes[-1] if closes else None),
            "marketCap": market_cap,
            "beta": beta,
            "volume": volume,
            "roeTTM": roe * 100.0 if roe is not None else None,
            "freeCashFlowYieldTTM": (fcf / market_cap) if (fcf and market_cap) else None,
            "debtToEquityTTM": (debt_to_eq / 100.0) if debt_to_eq is not None else None,
            "earningsYieldTTM": (1.0 / trailing_pe) if (trailing_pe and trailing_pe > 0) else None,
            "pbRatioTTM": price_to_book,
            "peRatioTTM": trailing_pe,
            "evEbitdaTTM": (ev / ebitda) if (ev is not None and ebitda) else None,
            "ret1D": trailing_return(closes, 1),
            "ret1M": trailing_return(closes, 21),
            "ret3M": trailing_return(closes, 63),
            "ret1Y": ((closes[-1] / closes[0] - 1.0) * 100.0) if len(closes) >= 2 else None,
            "analystTarget": safe(info.get("targetMeanPrice")),
            "analystCount": safe(info.get("numberOfAnalystOpinions")),
            "recommendation": info.get("recommendationKey"),
        }
    except Exception as e:
        # Only print the first ~80 chars of the error to keep logs readable
        msg = str(e)[:80]
        print(f"[fetch] {ticker}: {msg}")
        return None


def _cache_put(ticker: str, data: dict):
    with _cache_lock:
        _cache[ticker.upper()] = {"data": data, "ts": time.time()}


def _cache_get(ticker: str) -> dict | None:
    with _cache_lock:
        return _cache.get(ticker.upper())


def _is_stale(entry: dict) -> bool:
    return time.time() - entry["ts"] > CACHE_TTL_SECONDS


# ── Background warmup / refresh worker ──────────────────────────────────────
_refresh_running = False
_refresh_lock = threading.Lock()
_writes_since_save = 0


def _background_refresh_loop():
    """Continuously: fill missing universe tickers, then refresh stale ones."""
    global _writes_since_save
    print("[refresh] background worker starting")
    while True:
        try:
            ticker = _pick_next_to_refresh()
            if not ticker:
                time.sleep(60)
                continue
            data = _fetch_from_yahoo(ticker)
            if data:
                _cache_put(ticker, data)
                _writes_since_save += 1
                # Save to disk every 10 writes (cheap, prevents data loss on crash)
                if _writes_since_save >= 10:
                    save_cache()
                    _writes_since_save = 0
                if len(_cache) % 25 == 0:
                    print(f"[refresh] cache size: {len(_cache)} tickers")
        except Exception as e:
            print(f"[refresh] loop error: {str(e)[:80]}")
            time.sleep(10)


def _pick_next_to_refresh() -> str | None:
    """(1) Universe tickers missing from cache, then (2) staleest cached ticker."""
    universe = get_universe()
    with _cache_lock:
        missing = [t for t in universe if t not in _cache]
        if missing:
            return missing[0]
        if not _cache:
            return None
        ticker, entry = min(_cache.items(), key=lambda kv: kv[1]["ts"])
        if _is_stale(entry):
            return ticker
    return None


def start_background_refresh():
    global _refresh_running
    with _refresh_lock:
        if _refresh_running:
            return
        _refresh_running = True
    threading.Thread(target=_background_refresh_loop, daemon=True).start()


# ── Universe ────────────────────────────────────────────────────────────────
_FALLBACK_UNIVERSE = [
    "AAPL","MSFT","GOOGL","GOOG","AMZN","NVDA","META","TSLA","BRK-B","AVGO",
    "LLY","JPM","V","WMT","XOM","UNH","MA","ORCL","HD","PG",
]


def _fetch_wikipedia_table(url: str, symbol_col: str = "Symbol") -> list[str] | None:
    try:
        import pandas as pd
        r = curl_requests.get(url, timeout=30, impersonate="chrome")
        if r.status_code != 200:
            return None
        dfs = pd.read_html(io.StringIO(r.text))
        for df in dfs:
            if symbol_col in df.columns and len(df) > 50:
                syms = df[symbol_col].astype(str).tolist()
                cleaned = []
                for s in syms:
                    s = s.strip()
                    if not s or s.lower() in ("nan", ""):
                        continue
                    cleaned.append(s.replace(".", "-"))
                return cleaned
        return None
    except Exception as e:
        print(f"[universe] wiki fetch failed: {e}")
        return None


def _fetch_universe() -> list[str] | None:
    large = _fetch_wikipedia_table(
        "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"
    ) or []
    mid = _fetch_wikipedia_table(
        "https://en.wikipedia.org/wiki/List_of_S%26P_400_companies"
    ) or []
    seen, out = set(), []
    for t in large + mid:
        if t not in seen:
            seen.add(t)
            out.append(t)
    return out if len(out) > 400 else None


def get_universe() -> list[str]:
    global _universe_cache
    if _universe_cache:
        return _universe_cache
    fetched = _fetch_universe()
    _universe_cache = fetched or _FALLBACK_UNIVERSE
    print(f"[universe] loaded {len(_universe_cache)} tickers")
    return _universe_cache


# ── Endpoints ───────────────────────────────────────────────────────────────
@app.get("/stock/{ticker}")
def stock(ticker: str, fresh: bool = False) -> dict:
    """Always return cached data instantly. Background worker refreshes stale entries."""
    ticker = ticker.upper()
    entry = _cache_get(ticker)

    # Have any cached data → return it (background loop handles refresh)
    if entry and not fresh:
        return {
            **entry["data"],
            "_cacheAgeS": int(time.time() - entry["ts"]),
            "_cacheStale": _is_stale(entry),
        }

    # Cache miss OR fresh=1 → synchronous fetch (slow path)
    data = _fetch_from_yahoo(ticker)
    if data:
        _cache_put(ticker, data)
        save_cache()
        return {**data, "_cacheAgeS": 0, "_cacheStale": False}

    # Last resort: stale cache if we have any
    if entry:
        return {
            **entry["data"],
            "_cacheAgeS": int(time.time() - entry["ts"]),
            "_cacheStale": True,
            "_warn": "Yahoo unreachable; serving stale cache",
        }

    raise HTTPException(
        status_code=503,
        detail=f"No data for {ticker} yet — cold start in progress, retry in a few seconds"
    )


@app.get("/universe")
def universe() -> dict:
    tickers = get_universe()
    return {"tickers": tickers, "count": len(tickers)}


@app.get("/health")
def health() -> dict:
    with _cache_lock:
        size = len(_cache)
        if _cache:
            ages = [time.time() - e["ts"] for e in _cache.values()]
            avg_age_min = sum(ages) / len(ages) / 60
            stale_count = sum(1 for a in ages if a > CACHE_TTL_SECONDS)
        else:
            avg_age_min = 0
            stale_count = 0
    return {
        "ok": True,
        "cache_size": size,
        "universe_size": len(get_universe()),
        "avg_age_minutes": round(avg_age_min, 1),
        "stale_count": stale_count,
        "throttle_interval_s": THROTTLE_INTERVAL,
    }


# ── Startup ─────────────────────────────────────────────────────────────────
@app.on_event("startup")
def on_startup():
    load_cache()
    get_universe()
    # Defer warmup so /health and cached requests are responsive immediately
    def delayed_start():
        time.sleep(WARMUP_DELAY_SECONDS)
        start_background_refresh()
    threading.Thread(target=delayed_start, daemon=True).start()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8001, log_level="warning")
