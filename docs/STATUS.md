# STATUS

Обновляется после каждого среза. Последнее обновление: M0.

## Сделано
- **M0. Фундамент:** git, pnpm workspaces, TS strict, ESLint + Prettier, vitest (projects).
- `packages/contract`: zod-схемы всех DTO и запросов из `docs/02-api.md`, формат ошибок (`ApiError`), таблица маршрутов и генерация OpenAPI,
  UUID v7, SHA-256 на чистом TS, `canonicalJson`, `psd_input_hash` + частичные хэши для причин устаревания, авто-порядок чтения,
  геометрия, вычисляемые статусы, правила PATCH текста (конфликты по полям, `state`), diff разметки для sync, чтение заголовков PNG/JPEG/WebP,
  фикстуры (синтетическая глава из 3 PNG-страниц).

## В работе
- M1: сервер.

## Решения (ADR)
- [0001](decisions/0001-tooling.md) — TS 6.0, source-only пакеты, бандлинг приложений.
- [0002](decisions/0002-sqlite-argon2-builtin.md) — `node:sqlite` и встроенный `crypto.argon2` (предварительно, до S3).
- [0003](decisions/0003-canonical-json-and-stale-reasons.md) — числа в canonical JSON, частичные хэши в manifest.
- [0004](decisions/0004-api-additions.md) — мелкие дополнения API.

## Нужно от человека
- (пока ничего)

## Известные проблемы
- (нет)
