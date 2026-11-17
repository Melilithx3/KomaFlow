# S3 — сервер на Orange Pi Zero 3: отчёт

## Решения до замеров (ADR 0002, 0006)
- SQLite: встроенный `node:sqlite`; пароли: встроенный `crypto.argon2` (Node ≥ 24.7). Нативных модулей для БД и паролей нет.
- Декодер картинок для PSD: `sharp` 0.34 (готовые бинарники `@img/sharp-linux-arm64`). Запасной путь — `pngjs` (только PNG).
- Остальные зависимости сервера (`fastify`, `fflate`, `ag-psd`) — чистый JS.

## Проверено на машине разработки (Windows x64)
- Установка без компилятора, все тесты зелёные, PSD 2000×3000 ≈ 0,3 с (S1-report).
- Нагрузочный прогон `S3_SECONDS=20 node tools/spikes/s3-arm/load.mjs` — см. раздел «Windows» ниже.

## Нужно от человека (на Orange Pi)
1. Установить Node 24 LTS (официальная сборка linux-arm64) и pnpm (`corepack enable`).
2. `git clone` репозитория, затем `bash tools/spikes/s3-arm/run.sh 2>&1 | tee s3-results.txt`.
3. Прислать `s3-results.txt` (или вписать цифры в таблицу).

| Метрика | Цель | Результат на Pi |
|---|---|---|
| установка без компилятора | да | |
| логин (argon2, `argon2-bench`) | 0,3–0,5 с, < 1 с | |
| RSS под нагрузкой 3 клиентов | < 400 МБ | |
| p95 API (кроме blobs/экспорта) | < 200 мс | |
| PSD 2000×3000 | ≤ 30 с, < 300 МБ | |
| загрузка blob 30 МБ через nginx по LAN | < 20 с | (вручную, см. ниже) |

Загрузка 30 МБ: `curl -T big.png -H "Authorization: Bearer <desktop-token>" -H "Content-Type: image/png" https://komaflow.tlinmo.site/api/v1/blobs/<sha256>` с замером `time`.
По argon2: выбрать строку вывода `argon2-bench.mjs` с 0,3–0,5 с и прописать `KOMAFLOW_ARGON2_MEMORY_KIB` / `KOMAFLOW_ARGON2_PASSES` в env-файл.

## Windows (машина разработки, 3 клиента × 15 с, локально)
p95: chapter 1 мс, blob 2 мс, page 1 мс, patch 1 мс, sync 1 мс (~10 000 итераций каждого). argon2id m=64 МиБ t=3 — 115 мс (на Pi ожидается в 3–5 раз медленнее; подобрать по `argon2-bench`).
