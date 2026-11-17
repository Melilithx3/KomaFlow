"""Статистика по списку измерений (stdlib, используется и оркестратором, и воркером)."""
from __future__ import annotations

import math
import statistics

P95_MIN_SAMPLES = 20  # ниже этого P95 не вычисляется: процентиль по 5 точкам бессмыслен


def describe(values: list[float]) -> dict:
    v = [float(x) for x in values if x is not None]
    if not v:
        return {"n": 0}
    out = {
        "n": len(v),
        "mean": statistics.fmean(v),
        "median": statistics.median(v),
        "min": min(v),
        "max": max(v),
        "stdev": statistics.stdev(v) if len(v) > 1 else 0.0,
    }
    if len(v) >= P95_MIN_SAMPLES:
        s = sorted(v)
        k = (len(s) - 1) * 0.95
        lo, hi = math.floor(k), math.ceil(k)
        out["p95"] = s[lo] + (s[hi] - s[lo]) * (k - lo)
    else:
        out["p95"] = None
        out["p95_note"] = f"нужно >= {P95_MIN_SAMPLES} измерений, есть {len(v)}"
    return out
