"""
Standalone data fetcher for the Delta Capital cron architecture.

Runs in GitHub Actions on a schedule. Pulls yfinance fundamentals + 5yr
monthly history for the S&P 500 + S&P 400 universe, writes a single
data.json that the frontend reads statically from the `data` branch.

Throttle is 0.5s between Yahoo calls to stay polite. Total runtime for
~900 tickers × 2 calls = ~15 min per invocation.

Output: data.json in the current working directory.
"""
from __future__ import annotations

import io
import json
import math
import os
import sys
import threading
import time
from typing import Any

from curl_cffi import requests as curl_requests
import yfinance as yf


# ── Config ──────────────────────────────────────────────────────────────────
OUTPUT_FILE = os.environ.get("OUTPUT_FILE", "data.json")
THROTTLE_INTERVAL = float(os.environ.get("THROTTLE", "0.5"))

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

# Fallback universe if Wikipedia scrape fails
_FALLBACK_UNIVERSE = [
    "AAPL","MSFT","GOOGL","GOOG","AMZN","NVDA","META","TSLA","BRK-B","AVGO",
    "LLY","JPM","V","WMT","XOM","UNH","MA","ORCL","HD","PG",
]


# ── Throttling ──────────────────────────────────────────────────────────────
_throttle_lock = threading.Lock()
_last_call_ts = 0.0


def wait_throttle():
    global _last_call_ts
    with _throttle_lock:
        wait = THROTTLE_INTERVAL - (time.time() - _last_call_ts)
        if wait > 0:
            time.sleep(wait)
        _last_call_ts = time.time()


# ── Universe (S&P 500 + S&P 400 from Wikipedia) ─────────────────────────────
def fetch_wikipedia_universe(url: str, symbol_col: str = "Symbol") -> list[str]:
    try:
        import pandas as pd
        r = curl_requests.get(url, timeout=30, impersonate="chrome")
        if r.status_code != 200:
            return []
        dfs = pd.read_html(io.StringIO(r.text))
        for df in dfs:
            if symbol_col in df.columns and len(df) > 50:
                syms = df[symbol_col].astype(str).tolist()
                return [s.strip().replace(".", "-") for s in syms if s.strip() and s.lower() != "nan"]
        return []
    except Exception as e:
        print(f"[universe] fetch failed for {url}: {e}", file=sys.stderr)
        return []


def get_universe() -> list[str]:
    large = fetch_wikipedia_universe("https://en.wikipedia.org/wiki/List_of_S%26P_500_companies")
    mid = fetch_wikipedia_universe("https://en.wikipedia.org/wiki/List_of_S%26P_400_companies")
    seen, out = set(), []
    for t in large + mid:
        if t not in seen:
            seen.add(t)
            out.append(t)
    if "SPY" not in out:
        out.append("SPY")
    if len(out) < 400:
        print(f"[universe] only got {len(out)} from Wikipedia; using fallback", file=sys.stderr)
        return _FALLBACK_UNIVERSE + ["SPY"]
    print(f"[universe] loaded {len(out)} tickers")
    return out


# ── yfinance fetch helpers ──────────────────────────────────────────────────
_session = curl_requests.Session(impersonate="chrome")


def safe(v: Any) -> Any:
    if v is None:
        return None
    if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
        return None
    if hasattr(v, "item"):
        try:
            return v.item()
        except Exception:
            pass
    return v


def trailing_return(closes: list[float], n: int) -> float | None:
    if not closes or len(closes) < n + 1:
        return None
    end, start = closes[-1], closes[-1 - n]
    if not end or not start:
        return None
    return (end / start - 1.0) * 100.0


def fetch_ticker(ticker: str) -> tuple[dict | None, list | None]:
    """Returns (fundamentals_dict, monthly_history_list) for the ticker.
    Each yfinance call gets its own throttle wait."""
    fundamentals = None
    monthly = None

    # Call 1: .info + 1Y daily history (for fundamentals + return windows)
    wait_throttle()
    try:
        t = yf.Ticker(ticker, session=_session)
        info = t.info or {}
        daily = t.history(period="1y", auto_adjust=True)
        closes_1y = [float(x) for x in daily["Close"].tolist() if x == x] if not daily.empty else []

        price        = safe(info.get("regularMarketPrice")) or safe(info.get("currentPrice"))
        market_cap   = safe(info.get("marketCap"))
        beta         = safe(info.get("beta"))
        roe          = safe(info.get("returnOnEquity"))
        fcf          = safe(info.get("freeCashflow"))
        ebitda       = safe(info.get("ebitda"))
        ev           = safe(info.get("enterpriseValue"))
        trailing_pe  = safe(info.get("trailingPE"))
        price_to_book = safe(info.get("priceToBook"))
        debt_to_eq   = safe(info.get("debtToEquity"))

        fundamentals = {
            "ticker": ticker.upper(),
            "name": info.get("longName") or info.get("shortName") or ticker,
            "sector": info.get("sector") or "Unknown",
            "industry": info.get("industry") or "",
            "price": price if price is not None else (closes_1y[-1] if closes_1y else None),
            "marketCap": market_cap,
            "beta": beta,
            "volume": safe(info.get("regularMarketVolume")) or safe(info.get("volume")),
            "roeTTM": roe * 100.0 if roe is not None else None,
            "freeCashFlowYieldTTM": (fcf / market_cap) if (fcf and market_cap) else None,
            "debtToEquityTTM": (debt_to_eq / 100.0) if debt_to_eq is not None else None,
            "earningsYieldTTM": (1.0 / trailing_pe) if (trailing_pe and trailing_pe > 0) else None,
            "pbRatioTTM": price_to_book,
            "peRatioTTM": trailing_pe,
            "evEbitdaTTM": (ev / ebitda) if (ev is not None and ebitda) else None,
            "ret1D": trailing_return(closes_1y, 1),
            "ret1M": trailing_return(closes_1y, 21),
            "ret3M": trailing_return(closes_1y, 63),
            "ret1Y": ((closes_1y[-1] / closes_1y[0] - 1.0) * 100.0) if len(closes_1y) >= 2 else None,
            "analystTarget": safe(info.get("targetMeanPrice")),
            "analystCount": safe(info.get("numberOfAnalystOpinions")),
            "recommendation": info.get("recommendationKey"),
        }
    except Exception as e:
        print(f"[fetch] {ticker} info: {str(e)[:80]}", file=sys.stderr)

    # Call 2: monthly 5Y history (for walk-forward backtest)
    wait_throttle()
    try:
        t = yf.Ticker(ticker, session=_session)
        monthly_df = t.history(period="5y", interval="1mo", auto_adjust=True)
        if not monthly_df.empty:
            monthly = [
                [d.strftime("%Y-%m"), round(float(c), 4)]
                for d, c in zip(monthly_df.index, monthly_df["Close"])
                if c == c and c > 0
            ]
    except Exception as e:
        print(f"[fetch] {ticker} monthly: {str(e)[:80]}", file=sys.stderr)

    return fundamentals, monthly


# ── Main ────────────────────────────────────────────────────────────────────
def main():
    start = time.time()
    universe = get_universe()
    stocks = []
    history = {}
    errors = 0

    print(f"[main] fetching {len(universe)} tickers, throttle={THROTTLE_INTERVAL}s")

    for i, ticker in enumerate(universe):
        f, m = fetch_ticker(ticker)
        if f and f.get("price") and f.get("marketCap"):
            stocks.append(f)
        else:
            errors += 1
        if m:
            history[ticker] = m

        if (i + 1) % 50 == 0:
            elapsed = (time.time() - start) / 60
            print(f"[main] {i + 1}/{len(universe)} done · {len(stocks)} stocks · "
                  f"{len(history)} history · {errors} errors · {elapsed:.1f} min")

    # Sort stocks by market cap descending
    stocks.sort(key=lambda s: -(s.get("marketCap") or 0))

    payload = {
        "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "universe_count": len(universe),
        "stock_count": len(stocks),
        "history_count": len(history),
        "stocks": stocks,
        "history": history,
    }

    with open(OUTPUT_FILE, "w") as f:
        json.dump(payload, f, separators=(",", ":"))

    size_kb = os.path.getsize(OUTPUT_FILE) / 1024
    elapsed = (time.time() - start) / 60
    print(f"[main] wrote {OUTPUT_FILE} · {size_kb:.0f} KB · "
          f"{len(stocks)} stocks · {len(history)} history · "
          f"{errors} errors · {elapsed:.1f} min total")

    # Exit non-zero if we got too few stocks (something's very wrong)
    if len(stocks) < len(universe) * 0.5:
        print(f"[main] FAIL: only {len(stocks)}/{len(universe)} stocks succeeded", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
