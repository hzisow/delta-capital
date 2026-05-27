"""
Append weekly forward-test snapshots to picks_history.json.

Runs after fetch_data.py in the GitHub Actions cron. Reads data.json,
runs the same factor model the frontend does (sector-neutral percentile
ranks, composite score, top-N sector-diversified picks), and appends a
new entry to picks_history.json IF the last entry is at least 6 days old.

This builds up an honest, append-only forward-test track record. After
6-12 months of running, you have real out-of-sample data showing whether
the model picks winners.

Input:  data.json (in cwd, output of fetch_data.py)
Output: picks_history.json (appended to, in cwd)
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timedelta, timezone

# ── Config — must mirror frontend defaults in App.jsx ────────────────────────
TOP_N = 20
SECTOR_CAP = 0.30        # max share of any single sector in the basket
SECTOR_MIN_PEERS = 5     # below this, sector falls back to global rank
WEIGHTS = {"mom": 35, "qual": 30, "val": 15, "vol": 20}
MIN_DAYS_BETWEEN_SNAPSHOTS = 6   # save at most ~weekly


# ── Scoring (mirrors App.jsx scoreAll) ──────────────────────────────────────
def percentile_within(raw, indices, invert=False):
    """Percentile rank values at `indices` against each other.
    Returns list aligned to `raw`; non-indices positions get 50."""
    out = [50] * len(raw)
    subset = [raw[i] for i in indices if raw[i] is not None and _finite(raw[i])]
    if len(subset) < 2:
        return out
    sorted_v = sorted(subset)
    n = len(sorted_v)
    for i in indices:
        v = raw[i]
        if v is None or not _finite(v):
            out[i] = 50
            continue
        below = sum(1 for x in sorted_v if x < v)
        rank = round((below / max(n - 1, 1)) * 100)
        out[i] = 100 - rank if invert else rank
    return out


def _finite(v):
    try:
        return v == v and v != float("inf") and v != float("-inf")
    except Exception:
        return False


def _clamp(v, lo, hi):
    return max(lo, min(hi, v))


def score_all(stocks):
    """Return stocks with mom/qual/val/vol scores + composite (using WEIGHTS)."""
    if not stocks:
        return []

    # Raw factor values
    mom_raw = [
        (s["ret1Y"] - s["ret1M"]) if (s.get("ret1Y") is not None and s.get("ret1M") is not None) else None
        for s in stocks
    ]
    qual_raw = []
    for s in stocks:
        if s.get("roeTTM") is None:
            qual_raw.append(None); continue
        roe = _clamp(s["roeTTM"], -50, 200)
        fcf = _clamp((s.get("freeCashFlowYieldTTM") or 0) * 100, -1e9, 50) if s.get("freeCashFlowYieldTTM") is not None else 0
        dte_raw = s.get("debtToEquityTTM") or 0
        dte = -_clamp(dte_raw, 0, 10) * 3 if dte_raw is not None else 0
        qual_raw.append(roe * 0.5 + fcf * 0.3 + dte * 0.2)
    val_raw = []
    for s in stocks:
        ey = _clamp((s.get("earningsYieldTTM") or 0) * 100, -10, 30) if s.get("earningsYieldTTM") is not None else None
        pb = s.get("pbRatioTTM")
        ev = s.get("evEbitdaTTM")
        ipb = (100 / pb) if (pb is not None and pb > 0) else None
        iev = (100 / ev) if (ev is not None and ev > 0) else None
        if ey is None and ipb is None:
            val_raw.append(None)
        else:
            val_raw.append((ey or 0) * 0.4 + (ipb or 0) * 0.35 + (iev or 0) * 0.25)
    beta_raw = [s.get("beta") for s in stocks]

    # Group by sector
    sector_idx = {}
    for i, s in enumerate(stocks):
        sec = s.get("sector") or "Unknown"
        sector_idx.setdefault(sec, []).append(i)

    all_idx = list(range(len(stocks)))
    global_mom  = percentile_within(mom_raw,  all_idx)
    global_qual = percentile_within(qual_raw, all_idx)
    global_val  = percentile_within(val_raw,  all_idx)
    global_vol  = percentile_within(beta_raw, all_idx, invert=True)

    mom_score  = [50] * len(stocks)
    qual_score = [50] * len(stocks)
    val_score  = [50] * len(stocks)
    vol_score  = [50] * len(stocks)

    for sec, idxs in sector_idx.items():
        if len(idxs) >= SECTOR_MIN_PEERS:
            m = percentile_within(mom_raw,  idxs)
            q = percentile_within(qual_raw, idxs)
            v = percentile_within(val_raw,  idxs)
            l = percentile_within(beta_raw, idxs, invert=True)
            for i in idxs:
                mom_score[i] = m[i]; qual_score[i] = q[i]
                val_score[i] = v[i]; vol_score[i] = l[i]
        else:
            for i in idxs:
                mom_score[i] = global_mom[i];  qual_score[i] = global_qual[i]
                val_score[i] = global_val[i];  vol_score[i] = global_vol[i]

    total_w = WEIGHTS["mom"] + WEIGHTS["qual"] + WEIGHTS["val"] + WEIGHTS["vol"]
    out = []
    for i, s in enumerate(stocks):
        comp = round((
            mom_score[i]  * WEIGHTS["mom"]  +
            qual_score[i] * WEIGHTS["qual"] +
            val_score[i]  * WEIGHTS["val"]  +
            vol_score[i]  * WEIGHTS["vol"]
        ) / total_w)
        out.append({
            **s,
            "momentumScore": mom_score[i],
            "qualityScore":  qual_score[i],
            "valueScore":    val_score[i],
            "lowVolScore":   vol_score[i],
            "composite":     comp,
            "hasFullData":   mom_raw[i] is not None and qual_raw[i] is not None,
        })
    return out


def pick_diversified(scored, n=TOP_N, sector_cap=SECTOR_CAP):
    """Top N by composite, capped per sector. Mirrors PicksView.buildDiversified."""
    enriched = [s for s in scored if s["hasFullData"]]
    enriched.sort(key=lambda s: -s["composite"])
    max_per_sector = max(2, int(n * sector_cap) + 1)
    picked = []
    sector_count = {}
    for s in enriched:
        if len(picked) >= n:
            break
        sec = s.get("sector") or "Unknown"
        if sector_count.get(sec, 0) >= max_per_sector:
            continue
        picked.append(s)
        sector_count[sec] = sector_count.get(sec, 0) + 1
    return picked


# ── Main ────────────────────────────────────────────────────────────────────
def main():
    if not os.path.exists("data.json"):
        print("[save_picks] no data.json — skipping", file=sys.stderr)
        return 0
    with open("data.json") as f:
        data = json.load(f)
    stocks = data.get("stocks", [])
    if not stocks:
        print("[save_picks] data.json has no stocks — skipping", file=sys.stderr)
        return 0

    scored = score_all(stocks)
    picks = pick_diversified(scored)

    # Find SPY in raw data for benchmark price snapshot
    spy = next((s for s in stocks if s["ticker"] == "SPY"), None)

    now = datetime.now(timezone.utc)
    today_iso = now.strftime("%Y-%m-%d")

    # Load existing history
    history = []
    if os.path.exists("picks_history.json"):
        try:
            with open("picks_history.json") as f:
                history = json.load(f)
            if not isinstance(history, list):
                history = []
        except Exception as e:
            print(f"[save_picks] couldn't read existing history: {e}", file=sys.stderr)
            history = []

    # Only append if last snapshot is at least MIN_DAYS_BETWEEN_SNAPSHOTS old
    if history:
        last_date_str = history[-1].get("date", "")
        try:
            last_date = datetime.strptime(last_date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
            days_since = (now - last_date).days
            if days_since < MIN_DAYS_BETWEEN_SNAPSHOTS:
                print(f"[save_picks] last snapshot {days_since}d ago — too soon, skipping")
                return 0
        except Exception:
            pass

    # Build the snapshot — only keep what we need for forward-test analysis
    entry = {
        "date": today_iso,
        "weights": dict(WEIGHTS),
        "top_n": TOP_N,
        "spy_price_at_pick": spy.get("price") if spy else None,
        "picks": [
            {
                "ticker": p["ticker"],
                "name": p.get("name"),
                "sector": p.get("sector"),
                "price_at_pick": p.get("price"),
                "composite": p["composite"],
                "scores": {
                    "mom": p["momentumScore"],
                    "qual": p["qualityScore"],
                    "val": p["valueScore"],
                    "vol": p["lowVolScore"],
                },
                "analyst_target_at_pick": p.get("analystTarget"),
            }
            for p in picks
        ],
    }
    history.append(entry)

    with open("picks_history.json", "w") as f:
        json.dump(history, f, separators=(",", ":"))

    print(f"[save_picks] appended snapshot {today_iso} · "
          f"{len(entry['picks'])} picks · history now has {len(history)} snapshots")
    return 0


if __name__ == "__main__":
    sys.exit(main())
