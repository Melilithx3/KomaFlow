# Copied from reference/bench/bench/worker/adapters/_attn.py (verified on gfx1031).
"""Поблочное (по запросам) вычисление scaled_dot_product_attention.

Зачем: в PyTorch+ROCm для gfx1031 нет flash/memory-efficient ядер SDPA (проверено:
"No available kernel"), остаётся только MATH, который материализует полную матрицу
внимания. Для koharu-layout @1920 это 6 голов × 25601² × 4 Б ≈ 14.6 ГиБ > 12 ГБ VRAM.

Разбиение по оси запросов математически эквивалентно (softmax считается по ключам,
каждая строка независима), веса и архитектура не меняются. Применяется только внутри
контекста и только к вызовам без маски/causal с числом запросов > chunk.
"""
from __future__ import annotations

import contextlib

import torch
import torch.nn.functional as F


@contextlib.contextmanager
def query_chunked_sdpa(chunk: int):
    orig = F.scaled_dot_product_attention
    calls = {"chunked": 0}

    def sdpa(query, key, value, attn_mask=None, dropout_p=0.0, is_causal=False, scale=None, **kw):
        n = query.shape[-2]
        if attn_mask is not None or is_causal or n <= chunk or kw:
            return orig(query, key, value, attn_mask, dropout_p, is_causal=is_causal, scale=scale, **kw)
        calls["chunked"] += 1
        outs = [orig(query[..., i:i + chunk, :], key, value, None, dropout_p, is_causal=False, scale=scale)
                for i in range(0, n, chunk)]
        return torch.cat(outs, dim=-2)

    F.scaled_dot_product_attention = sdpa
    torch.nn.functional.scaled_dot_product_attention = sdpa
    try:
        yield calls
    finally:
        F.scaled_dot_product_attention = orig
        torch.nn.functional.scaled_dot_product_attention = orig
