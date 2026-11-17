# 02. HTTP API v1

Базовый путь `/api/v1`. JSON, UTF-8. Схемы запросов и ответов задаются zod в `packages/contract` (источник истины), OpenAPI генерируется из них.
Вне префикса: `GET /healthz` (без авторизации). Всё остальное требует сессии.

## 1. Общее

**Клиенты и авторизация.** Сессия принадлежит клиенту `web` (cookie `komaflow_session`, httpOnly, Secure, SameSite=Lax) или `desktop` (заголовок `Authorization: Bearer <token>`). Роли пользователей не различаются. Эндпоинты, помеченные **[desktop]**, доступны только сессиям `desktop`, иначе `403 FORBIDDEN`.

**CSRF.** Для запросов с cookie-сессией, меняющих состояние, обязателен заголовок `X-Komaflow-Client: web`. CORS на сервере не включается, поэтому чужие сайты такой запрос отправить не могут.

**Формат ошибки:**
```json
{ "error": { "code": "FIELD_CONFLICT", "message": "…", "details": { } } }
```

| HTTP | code | Когда |
|---|---|---|
| 401 | `UNAUTHENTICATED` | нет или просрочена сессия |
| 403 | `FORBIDDEN` | эндпоинт только для `desktop` |
| 404 | `NOT_FOUND` | нет объекта |
| 409 | `REVISION_CONFLICT` | `base_markup_rev` не совпал; в `details` серверные `markup_rev` страниц |
| 409 | `FIELD_CONFLICT` | конфликт полей при PATCH (см. 01 §3.2) |
| 409 | `BLOBS_MISSING` | sync ссылается на файлы, которых нет; `details.missing: string[]` |
| 413 | `PAYLOAD_TOO_LARGE` | превышен лимит файла |
| 415 | `UNSUPPORTED_MEDIA` | не PNG/JPEG/WebP |
| 422 | `VALIDATION_ERROR` | схема или инварианты; `details.issues` |
| 422 | `RAW_IMMUTABLE` / `SIZE_MISMATCH` | см. 01 §6 |
| 429 | `RATE_LIMITED` | слишком много попыток входа |

**ETag.** `GET /chapters/{id}` и `GET /pages/{id}` отдают `ETag` (из `rev` страниц) и понимают `If-None-Match` → `304`.

**Общие типы:**
```ts
type Box = { x: number; y: number; w: number; h: number };   // целые px
type ObjectType = 'bubble' | 'sfx' | 'onomatopoeia' | 'text';
type TranslationState = 'empty' | 'translated' | 'skipped' | 'unreadable';

type ObjectDTO = {
  id: string; page_id: string; order: number; type: ObjectType;
  box: Box; text_box: Box | null; geometry_ver: number;
  source_text: string; translation: string; state: TranslationState;
  comment: string; flagged: boolean;
  text_ver: number; field_vers: Record<string, number>;
  updated_at: string; updated_by: string | null;
};

type PageDTO = {
  id: string; chapter_id: string; idx: number; width: number; height: number;
  raw_hash: string; clean_hash: string | null; notes_hash: string | null; thumb_hash: string | null;
  markup_rev: number; rev: number;
  typed: boolean; typed_by: string | null; typed_at: string | null;
};

type PageSummary = Pick<PageDTO, 'id'|'idx'|'width'|'height'|'raw_hash'|'thumb_hash'|'markup_rev'|'rev'|'typed'> & {
  has_clean: boolean;
  counts: { total: number; empty: number; translated: number; skipped: number; unreadable: number };
  flagged: number; translation_done: boolean; ready_for_typing: boolean;
  markup_changed_for_me: boolean;
};
```

## 2. Авторизация и профиль

| Метод и путь | Назначение |
|---|---|
| `POST /auth/login` | `{login, password, device_name, client: 'web'|'desktop'}`. Для `web` ставит cookie и возвращает `{user}`; для `desktop` возвращает `{user, token}`. Срок сессии 90 дней со скользящим продлением. Лимит попыток (см. 03). |
| `POST /auth/logout` | отзывает текущую сессию |
| `GET /me` | `{user, session}` |
| `GET /me/sessions` | список сессий пользователя (устройства) |
| `DELETE /me/sessions/{id}` | отозвать сессию |
| `POST /me/password` | `{old_password, new_password}` |

Регистрации нет. Пользователей создаёт `komaflow-admin` (см. 03).

## 3. Проекты и главы

| Метод и путь | Назначение |
|---|---|
| `GET /projects` | список проектов |
| `POST /projects` | `{title, source_lang, target_lang, reading_direction?}`; `settings` получают значения по умолчанию из `docs/04-psd.md` |
| `PATCH /projects/{id}` | название, языки, направление, `settings` (валидируется `PsdSettings`) |
| `GET /projects/{id}/chapters` | главы со сводкой: число страниц, сколько с clean, переведено, затайплено |
| `POST /projects/{id}/chapters` **[desktop]** | `{number, title?}` → глава (повторный вызов с тем же `number` возвращает существующую) |
| `GET /chapters/{id}` | `{chapter, project, pages: PageSummary[]}` |

## 4. Blobs

| Метод и путь | Назначение |
|---|---|
| `POST /blobs/check` **[desktop]** | `{hashes: string[]}` → `{missing: string[]}` (до 500 хэшей) |
| `PUT /blobs/{sha256}` **[desktop]** | тело — байты файла, `Content-Type` одного из разрешённых. Поточная запись, проверка хэша, сигнатуры, размеров. `201` если создан, `200` если уже был. Идемпотентно |
| `GET /blobs/{sha256}` | файл. `Cache-Control: public, max-age=31536000, immutable`, `ETag` = хэш; доступ только с сессией |

## 5. Sync (публикация главы) **[desktop]**

`POST /chapters/{id}/sync`

```ts
type SyncRequest = {
  pages: Array<{
    id: string;                      // uuid v7, создан на десктопе
    idx: number;                     // порядковый номер страницы в главе, с 1
    width: number; height: number;
    raw_hash: string;
    clean_hash?: string | null; notes_hash?: string | null; thumb_hash?: string | null;
    base_markup_rev: number | null;  // null — новая страница
    objects: Array<{                 // ПОЛНЫЙ список, в порядке чтения
      id: string; type: ObjectType; box: Box; text_box?: Box | null;
      source_text?: string;          // учитывается только для новых объектов
    }>;
  }>;
};

type SyncResponse = {
  pages: Array<{ id: string; markup_rev: number; changed: boolean; summary: MarkupSummary }>;
};
```

Порядок работы клиента: `POST /blobs/check` → `PUT /blobs/*` для недостающих → `POST …/sync`.
Если файлов не хватает, сервер отвечает `409 BLOBS_MISSING` и ничего не меняет; клиент докачивает и повторяет запрос (так обрывы загрузки безопасны).
Весь запрос выполняется в одной транзакции. Правила — в `01-data-model.md` §3.1 и §3.4. Размеры `clean`/`notes` сверяются с `raw` по заголовкам blob'ов.

## 6. Страницы и объекты

| Метод и путь | Назначение |
|---|---|
| `GET /pages/{id}` | `{page, objects: ObjectDTO[], deleted_objects: ObjectDTO[], revisions: MarkupRevisionDTO[] (последние 10), project_settings}` |
| `PUT /pages/{id}/seen` | `{markup_rev}` — гасит бейдж «разметка изменилась» для текущего пользователя |
| `PUT /pages/{id}/typed` | `{typed: boolean}` — единственный ручной статус |
| `PATCH /objects/{id}` | см. ниже |

**`PATCH /objects/{id}`**
```ts
{ base_text_ver: number,
  changes: { source_text?: string; translation?: string;
             state?: TranslationState; comment?: string; flagged?: boolean } }
```
Ответ `200` — обновлённый `ObjectDTO`. Правила конфликтов — `01-data-model.md` §3.2, состояние перевода — §3.3. Лимиты: `translation` и `source_text` ≤ 5000 символов, `comment` ≤ 2000. Запросы `PATCH` на удалённый объект разрешены (его можно редактировать из раздела «удалено»).

## 7. Экспорт PSD

| Метод и путь | Назначение |
|---|---|
| `POST /chapters/{id}/exports` | `{only_ready?: boolean = true, page_ids?: string[], layers?: {raw?: boolean, clean?: boolean, notes?: boolean, text?: boolean}}` (все слои по умолчанию `true`; в MVP `text: false` → `422`) → `202 {export: ExportDTO}`. Одновременно выполняется одно задание, остальные ждут в очереди |
| `GET /exports/{id}` | статус, прогресс, `errors`, `manifest` по готовности |
| `GET /exports/{id}/download` | zip (потоково). `410` если файл уже удалён по сроку |
| `GET /chapters/{id}/exports` | последние экспорты главы |
| `GET /chapters/{id}/export-status` | актуальность последнего готового экспорта по страницам |

```ts
type ExportDTO = {
  id: string; chapter_id: string; status: 'queued'|'running'|'done'|'failed'|'expired';
  progress: { done: number; total: number };
  params: { only_ready: boolean; page_ids: string[] | null;
            layers: { raw: boolean; clean: boolean; notes: boolean; text: boolean } };
  created_by: string; created_at: string; finished_at: string | null; expires_at: string | null;
  size_bytes: number | null; errors: Array<{ page_id: string; code: string; message: string }>;
};

type ExportStatus = {
  latest_export_id: string | null; finished_at: string | null;
  pages: Array<{ page_id: string; idx: number;
                 state: 'fresh' | 'stale' | 'not_exported';
                 stale_reasons?: Array<'clean'|'notes'|'markup'|'translation'|'settings'> }>;
};
```

Правила отбора страниц и устройство zip — в `docs/04-psd.md`. `stale_reasons` — подсказка для UI; определяет актуальность `psd_input_hash`.

## 8. Служебное

- `GET /healthz` → `{ok: true, version, db: 'ok'}` без авторизации.
- `GET /openapi.json` и страница документации — только в режиме разработки или за авторизацией.
