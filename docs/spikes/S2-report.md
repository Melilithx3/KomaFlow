# S2 — модели на gfx1031: отчёт (заготовка)

Код: `sidecar/` (ADR 0009). Версии, revision моделей и обходы взяты из `reference/bench/`.
На машине разработки GPU нет: проверены только контракты на заглушках (`pytest`, 13 тестов).

## Нужно от человека (ПК клинера, RX gfx1031)
1. Установить `uv` (`pip install uv` или https://docs.astral.sh/uv/) и Python не трогать.
2. `cd sidecar && python -m venv .venv && .venv\Scripts\python -m pip install -e .`
3. `.venv\Scripts\komaflow-sidecar install --backends rocm,cpu --models layout,ocr` (≈ 8 ГБ, лог в `%LOCALAPPDATA%\komaflow\sidecar\logs`).
4. Положить 4–8 страниц в `test_data/` (не коммитится) и прогнать:
   - `komaflow-sidecar analyze --pages test_data --out out/s2-p8 --overlay --padding 8` (дважды: холодный и прогретый кэш MIOpen);
   - `--padding 0`, `4`, `16` — в разные папки `out/`;
   - `--backend cpu --stages layout` — запасной режим.
5. Прислать `analysis.json` (тайминги, `peak_vram_mb` по этапам) и 2–3 overlay-картинки; отметить, какой отступ даёт лучший OCR на 5–10 боксах.
6. Во время прогона держать открытым десктоп komaflow (WebView2) и посмотреть, хватает ли VRAM (Диспетчер задач → GPU).

| Метрика | Цель | Результат |
|---|---|---|
| layout, с/стр (прогрето) | — | |
| OCR, с/кроп и с/стр | ≤ 60 с суммарно на страницу | |
| пик VRAM layout / OCR | < 11 ГБ | |
| VRAM освобождается после этапа | да | |
| первый запуск vs второй | — | |
| CPU layout, с/стр | ~25 с | |

## class_map (предварительно, `sidecar/komaflow_sidecar/geometry.py`)
`bubble→bubble`, `text→text`, `onomatopoeia→onomatopoeia`, `panel→` отбрасывается, неизвестные — отбрасываются.
У модели нет класса `sfx`: такие боксы клинер перетипирует вручную (клавиша `2`). Подтвердить по `id2label` из `config.json`.
