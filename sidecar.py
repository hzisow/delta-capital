"""
Yahoo Finance sidecar for Delta Capital.

Runs alongside Vite on port 8001. Uses yfinance + curl_cffi (Chrome TLS
impersonation) to bypass Yahoo's WAF that blocks bare Node/Python fetches.

Endpoints:
  GET /stock/{ticker}  -> unified JSON with fundamentals + returns
  GET /health
"""
from __future__ import annotations

import csv
import io
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from typing import Any

from curl_cffi import requests as curl_requests
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import yfinance as yf

app = FastAPI(title="Delta Capital sidecar")

# CORS so the browser can hit us directly during dev
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET"],
    allow_headers=["*"],
)


def make_session() -> curl_requests.Session:
    """Chrome-impersonating session — defeats Yahoo's TLS fingerprint check."""
    return curl_requests.Session(impersonate="chrome")


# yfinance is thread-safe per-Ticker; we share one session across the process
_session = make_session()


def trailing_return(closes: list[float], n: int) -> float | None:
    if not closes or len(closes) < n + 1:
        return None
    end = closes[-1]
    start = closes[-1 - n]
    if not end or not start:
        return None
    return (end / start - 1.0) * 100.0


def safe(v: Any) -> Any:
    """Coerce numpy/pandas values to plain JSON-friendly types."""
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


@lru_cache(maxsize=256)
def _cached_fetch(ticker: str, ts_bucket: int) -> dict:
    """Fetch a ticker. ts_bucket lets callers invalidate per N-minute window."""
    t = yf.Ticker(ticker, session=_session)

    try:
        info = t.info or {}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"yfinance info failed: {e}")

    # Price history for return windows
    try:
        hist = t.history(period="1y", auto_adjust=True)
        closes = [float(x) for x in hist["Close"].tolist() if x == x]  # drop NaN
    except Exception:
        closes = []

    price        = safe(info.get("regularMarketPrice")) or safe(info.get("currentPrice"))
    market_cap   = safe(info.get("marketCap"))
    beta         = safe(info.get("beta"))
    sector       = info.get("sector") or "Unknown"
    industry     = info.get("industry") or ""
    name         = info.get("longName") or info.get("shortName") or ticker
    volume       = safe(info.get("regularMarketVolume")) or safe(info.get("volume"))

    # Fundamentals
    roe          = safe(info.get("returnOnEquity"))           # decimal (1.41 = 141%)
    fcf          = safe(info.get("freeCashflow"))
    ebitda       = safe(info.get("ebitda"))
    ev           = safe(info.get("enterpriseValue"))
    trailing_pe  = safe(info.get("trailingPE"))
    price_to_book = safe(info.get("priceToBook"))
    debt_to_eq   = safe(info.get("debtToEquity"))             # percent form (79.5 = 0.795x)

    # Compute 1D from chart (yfinance's info.regularMarketChangePercent is
    # unreliable — sometimes returns 52w change instead of day change)
    ret_1d = trailing_return(closes, 1)

    return {
        "ticker": ticker.upper(),
        "name": name,
        "sector": sector,
        "industry": industry,
        "price": price if price is not None else (closes[-1] if closes else None),
        "marketCap": market_cap,
        "beta": beta,
        "volume": volume,

        # Quality
        "roeTTM": roe * 100.0 if roe is not None else None,
        "freeCashFlowYieldTTM": (fcf / market_cap) if (fcf and market_cap) else None,
        "debtToEquityTTM": (debt_to_eq / 100.0) if debt_to_eq is not None else None,

        # Value
        "earningsYieldTTM": (1.0 / trailing_pe) if (trailing_pe and trailing_pe > 0) else None,
        "pbRatioTTM": price_to_book,
        "peRatioTTM": trailing_pe,
        "evEbitdaTTM": (ev / ebitda) if (ev is not None and ebitda) else None,

        # Returns
        "ret1D": ret_1d if ret_1d is not None else trailing_return(closes, 1),
        "ret1M": trailing_return(closes, 21),
        "ret3M": trailing_return(closes, 63),
        "ret1Y": ((closes[-1] / closes[0] - 1.0) * 100.0) if len(closes) >= 2 else None,

        # Bonus signals
        "analystTarget": safe(info.get("targetMeanPrice")),
        "analystCount": safe(info.get("numberOfAnalystOpinions")),
        "recommendation": info.get("recommendationKey"),
    }


@app.get("/stock/{ticker}")
def stock(ticker: str, fresh: bool = False) -> dict:
    import time
    # 60-second cache bucket. Pass ?fresh=1 to bypass entirely.
    bucket = int(time.time()) if fresh else int(time.time() // 60)
    return _cached_fetch(ticker.upper(), bucket)


@app.get("/health")
def health() -> dict:
    return {"ok": True}


# ── Universe ────────────────────────────────────────────────────────────────
# Russell 1000 = the 1000 largest US stocks by market cap, ~92% of US equity
# market cap. We pull the live list from the iShares IWB ETF holdings CSV
# (refreshed daily by iShares, no auth needed).

_universe_cache: list[str] | None = None

# Last-resort fallback if iShares is unreachable
_FALLBACK_UNIVERSE = [
    "AAPL","MSFT","GOOGL","GOOG","AMZN","NVDA","META","TSLA","BRK-B","AVGO",
    "LLY","JPM","V","WMT","XOM","UNH","MA","ORCL","HD","PG",
    "JNJ","COST","ABBV","BAC","NFLX","KO","CVX","MRK","CRM","ADBE",
    "PEP","TMO","AMD","LIN","CSCO","MCD","ACN","ABT","WFC","DIS",
    "INTU","IBM","QCOM","CAT","TXN","GE","VZ","NOW","DHR","AXP",
    "PFE","NEE","CMCSA","AMGN","UNP","SPGI","RTX","HON","LOW","PM",
    "GS","MS","BKNG","NKE","BLK","T","ELV","UBER","SCHW","ISRG",
    "PLD","SYK","TJX","BA","CB","ADP","MDT","DE","C","MMC",
]


def _fetch_wikipedia_table(url: str, symbol_col: str = "Symbol") -> list[str] | None:
    """Scrape a Wikipedia constituents table into a list of tickers."""
    try:
        import pandas as pd
        r = curl_requests.get(url, timeout=30, impersonate="chrome")
        if r.status_code != 200:
            return None
        dfs = pd.read_html(io.StringIO(r.text))
        # First wide table with our symbol column wins
        for df in dfs:
            if symbol_col in df.columns and len(df) > 50:
                syms = df[symbol_col].astype(str).tolist()
                cleaned = []
                for s in syms:
                    s = s.strip()
                    if not s or s.lower() in ("nan", ""):
                        continue
                    # Wikipedia uses "BRK.B"; Yahoo uses "BRK-B"
                    cleaned.append(s.replace(".", "-"))
                return cleaned
        return None
    except Exception as e:
        print(f"[universe] wiki fetch failed for {url}: {e}")
        return None


def _fetch_universe() -> list[str] | None:
    """Combine S&P 500 (large-cap) + S&P MidCap 400 = ~900 stocks, essentially
    the same investable universe as the Russell 1000."""
    large = _fetch_wikipedia_table(
        "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"
    ) or []
    mid = _fetch_wikipedia_table(
        "https://en.wikipedia.org/wiki/List_of_S%26P_400_companies"
    ) or []
    combined = large + mid
    # Dedupe while preserving order (large-cap first)
    seen, out = set(), []
    for t in combined:
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
    print(f"[universe] loaded {len(_universe_cache)} tickers "
          f"({'Wikipedia S&P 900' if fetched else 'fallback'})")
    return _universe_cache


@app.get("/universe")
def universe() -> dict:
    return {"tickers": get_universe(), "count": len(get_universe())}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8001, log_level="warning")
