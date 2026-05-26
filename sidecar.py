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
HISTORY_CACHE_FILE = os.path.join(os.path.dirname(__file__), "history_cache.json")
FUNDAMENTALS_CACHE_FILE = os.path.join(os.path.dirname(__file__), "fundamentals_cache.json")
CACHE_TTL_SECONDS = 6 * 60 * 60       # refresh anything older than 6h
THROTTLE_INTERVAL_MIN = 0.5            # aggressive — full universe in ~7 min
THROTTLE_INTERVAL_MAX = 3.0            # backed off when Yahoo 429s
WARMUP_DELAY_SECONDS = 15              # let server settle before warmup starts

# Adaptive throttle: starts at MIN, bumps up on consecutive 429s, decays back.
# This lets us push fast normally but back off automatically if Yahoo starts
# pushing back.
_throttle_interval = THROTTLE_INTERVAL_MIN
_consecutive_429s = 0

# ── State ───────────────────────────────────────────────────────────────────
# disk cache: { ticker: { data: {...}, ts: epoch_seconds } }
_cache: dict[str, dict] = {}
_cache_lock = threading.Lock()

# historical monthly closes for walk-forward backtesting
# shape: { ticker: [[yyyy-mm, adj_close], ...] }   ~60 rows per ticker
_history: dict[str, list] = {}
_history_lock = threading.Lock()

# annual fundamentals for point-in-time factor scoring
# shape: { ticker: [{fiscalEnd, filed, netIncome, equity, totalDebt, ebitda, fcf, sharesOut}, ...] }
# ~5 annual rows per ticker, sorted oldest → newest
_fundamentals: dict[str, list] = {}
_fundamentals_lock = threading.Lock()

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


def load_history():
    global _history
    if not os.path.exists(HISTORY_CACHE_FILE):
        print(f"[history] no history cache — backtest data will warm up")
        return
    try:
        with open(HISTORY_CACHE_FILE) as f:
            _history = json.load(f)
        print(f"[history] loaded monthly history for {len(_history)} tickers")
    except Exception as e:
        print(f"[history] load failed: {e}")
        _history = {}


def save_history():
    try:
        tmp = HISTORY_CACHE_FILE + ".tmp"
        with open(tmp, "w") as f:
            json.dump(_history, f)
        os.replace(tmp, HISTORY_CACHE_FILE)
    except Exception as e:
        print(f"[history] save failed: {e}")


def _fetch_history(ticker: str) -> list | None:
    """Pull 5 years of monthly closes. Returns [[yyyy-mm, close], ...]."""
    _wait_throttle()
    try:
        with _session_lock:
            t = yf.Ticker(ticker, session=_yf_session)
            hist = t.history(period="5y", interval="1mo", auto_adjust=True)
        if hist.empty:
            _record_response(was_429=False)
            return None
        out = []
        for date, close in zip(hist.index, hist["Close"]):
            if close == close and close > 0:   # filter NaN
                out.append([date.strftime("%Y-%m"), round(float(close), 4)])
        _record_response(was_429=False)
        return out
    except Exception as e:
        msg = str(e)[:200]
        is_429 = ("429" in msg or "Too Many" in msg or "Rate" in msg or "Invalid Crumb" in msg)
        _record_response(was_429=is_429)
        print(f"[history] {ticker}: {msg[:80]}")
        return None


# ── Throttle + fetch ────────────────────────────────────────────────────────
def _wait_throttle():
    global _last_call_ts
    with _throttle_lock:
        wait = _throttle_interval - (time.time() - _last_call_ts)
        if wait > 0:
            time.sleep(wait)
        _last_call_ts = time.time()


def _record_response(was_429: bool):
    """Adaptive throttle: speed up on success, back off on 429s."""
    global _throttle_interval, _consecutive_429s
    with _throttle_lock:
        if was_429:
            _consecutive_429s += 1
            if _consecutive_429s >= 3:
                _throttle_interval = min(THROTTLE_INTERVAL_MAX, _throttle_interval * 1.5)
                print(f"[throttle] backing off to {_throttle_interval:.2f}s "
                      f"after {_consecutive_429s} 429s")
        else:
            _consecutive_429s = 0
            # Slowly decay back toward MIN on sustained success
            if _throttle_interval > THROTTLE_INTERVAL_MIN:
                _throttle_interval = max(THROTTLE_INTERVAL_MIN, _throttle_interval * 0.95)


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

        result = {
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
        _record_response(was_429=False)
        return result
    except Exception as e:
        msg = str(e)[:200]
        is_429 = ("429" in msg or "Too Many" in msg or "Rate" in msg or "Invalid Crumb" in msg)
        _record_response(was_429=is_429)
        print(f"[fetch] {ticker}: {msg[:80]}")
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
    """Continuously: fill missing stock data, then missing history, then refresh stale."""
    global _writes_since_save
    print("[refresh] background worker starting")
    while True:
        try:
            picked = _pick_next_to_refresh()
            if not picked:
                time.sleep(60)
                continue
            ticker, kind = picked

            if kind == "stock":
                data = _fetch_from_yahoo(ticker)
                if data:
                    _cache_put(ticker, data)
                    _writes_since_save += 1
                    if _writes_since_save >= 10:
                        save_cache()
                        _writes_since_save = 0
            elif kind == "history":
                rows = _fetch_history(ticker)
                if rows:
                    with _history_lock:
                        _history[ticker] = rows
                    _writes_since_save += 1
                    if _writes_since_save >= 10:
                        save_history()
                        _writes_since_save = 0
                    if len(_history) % 25 == 0:
                        print(f"[refresh] history size: {len(_history)} tickers")
        except Exception as e:
            print(f"[refresh] loop error: {str(e)[:80]}")
            time.sleep(10)


def _pick_next_to_refresh() -> tuple[str, str] | None:
    """Returns (ticker, kind). If stocks are already 90%+ cached, prioritize
    filling history so we don't get stuck retrying a single failing ticker."""
    universe = get_universe()

    with _cache_lock:
        stock_missing = [t for t in universe if t not in _cache]
        cache_size = len(_cache)
    with _history_lock:
        hist_missing = [t for t in universe if t not in _history]

    cache_ratio = cache_size / len(universe) if universe else 0

    # If we're 90%+ cached for stocks, prefer history work (avoids spinning
    # on the 1-2 problematic tickers that always fail).
    if cache_ratio >= 0.9 and hist_missing:
        return (hist_missing[0], "history")
    if stock_missing:
        return (stock_missing[0], "stock")
    if hist_missing:
        return (hist_missing[0], "history")

    # Everything cached → refresh staleest
    with _cache_lock:
        if not _cache:
            return None
        ticker, entry = min(_cache.items(), key=lambda kv: kv[1]["ts"])
        if _is_stale(entry):
            return (ticker, "stock")
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
    base = fetched or _FALLBACK_UNIVERSE
    # Ensure SPY is always present — it's used as the backtest benchmark
    if "SPY" not in base:
        base = base + ["SPY"]
    _universe_cache = base
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


@app.get("/stocks/bulk")
def stocks_bulk(force_refresh_age_s: int | None = None) -> dict:
    """Return every cached stock in one shot.

    Args:
        force_refresh_age_s: If set, any cached entry older than this gets
            marked for priority refresh by the background worker before we
            return. The response is still served from cache instantly — the
            client polls again to see updated values.
    """
    now = time.time()
    if force_refresh_age_s is not None:
        # Mark old entries by setting their ts to 0 (staleest) so the
        # background worker picks them up first
        with _cache_lock:
            for ticker, entry in _cache.items():
                if now - entry["ts"] > force_refresh_age_s:
                    entry["ts"] = 0

    out = []
    with _cache_lock:
        for ticker, entry in _cache.items():
            out.append({
                **entry["data"],
                "_cacheAgeS": int(now - entry["ts"]) if entry["ts"] > 0 else -1,
                "_cacheStale": (now - entry["ts"]) > CACHE_TTL_SECONDS if entry["ts"] > 0 else True,
            })
    universe_list = get_universe()
    return {
        "stocks": out,
        "universe": universe_list,
        "cached_count": len(out),
        "universe_count": len(universe_list),
        "throttle_s": round(_throttle_interval, 2),
    }


@app.get("/historical/bulk")
def historical_bulk() -> dict:
    """Return monthly closing prices for every cached ticker — feeds the
    walk-forward backtest engine in the frontend."""
    with _history_lock:
        history_copy = {k: v for k, v in _history.items()}
    return {
        "history": history_copy,
        "count": len(history_copy),
        "universe_count": len(get_universe()),
    }


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
    with _history_lock:
        history_size = len(_history)
    return {
        "ok": True,
        "cache_size": size,
        "history_size": history_size,
        "universe_size": len(get_universe()),
        "avg_age_minutes": round(avg_age_min, 1),
        "stale_count": stale_count,
        "throttle_interval_s": round(_throttle_interval, 2),
        "throttle_min_s": THROTTLE_INTERVAL_MIN,
        "consecutive_429s": _consecutive_429s,
    }


# ── Startup ─────────────────────────────────────────────────────────────────
@app.on_event("startup")
def on_startup():
    load_cache()
    load_history()
    get_universe()
    # Defer warmup so /health and cached requests are responsive immediately
    def delayed_start():
        time.sleep(WARMUP_DELAY_SECONDS)
        start_background_refresh()
    threading.Thread(target=delayed_start, daemon=True).start()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8001, log_level="warning")
