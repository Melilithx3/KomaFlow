# 01. Модель данных

## 1. Принципы

- Идентификаторы — UUID v7 в виде текста; страницы и объекты создаёт десктоп, остальное — сервер.
- Время — ISO 8601 UTC (текст). Координаты — целые пиксели raw-страницы.
- Данные делятся по владельцам:
  - **markup** (десктоп): тип, `box`, `text_box`, порядок, набор объектов, raw/clean/notes/thumb;
  - **text data** (веб): `source_text`, `translation`, `state`, `comment`, `flagged`.
- Удаление объекта мягкое: текстовые данные сохраняются, объект можно восстановить.

## 2. Схема (SQLite, набросок DDL)

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY, login TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL, password_hash TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);

CREATE TABLE sessions (            -- по одной записи на устройство
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,                   -- sha256 токена
  client TEXT NOT NULL CHECK (client IN ('web','desktop')),
  device_name TEXT NOT NULL, created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT);

CREATE TABLE projects (
  id TEXT PRIMARY KEY, title TEXT NOT NULL,
  source_lang TEXT NOT NULL, target_lang TEXT NOT NULL,
  reading_direction TEXT NOT NULL DEFAULT 'rtl' CHECK (reading_direction IN ('rtl','ltr')),
  settings_json TEXT NOT NULL,                       -- PsdSettings, см. docs/04-psd.md
  created_at TEXT NOT NULL);

CREATE TABLE chapters (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  number TEXT NOT NULL, title TEXT, created_at TEXT NOT NULL,
  UNIQUE (project_id, number));                      -- number текстовый: "12", "12.5"

CREATE TABLE pages (
  id TEXT PRIMARY KEY, chapter_id TEXT NOT NULL REFERENCES chapters(id),
  idx INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
  raw_hash TEXT NOT NULL, clean_hash TEXT, notes_hash TEXT, thumb_hash TEXT,
  markup_rev INTEGER NOT NULL DEFAULT 0,             -- растёт при изменении данных десктопа
  rev INTEGER NOT NULL DEFAULT 0,                    -- растёт при ЛЮБОМ изменении (для ETag)
  typed_by TEXT REFERENCES users(id), typed_at TEXT,
  created_at TEXT NOT NULL, UNIQUE (chapter_id, idx));

CREATE TABLE objects (
  id TEXT PRIMARY KEY, page_id TEXT NOT NULL REFERENCES pages(id),
  type TEXT NOT NULL CHECK (type IN ('bubble','sfx','onomatopoeia','text')),
  x INTEGER NOT NULL, y INTEGER NOT NULL, w INTEGER NOT NULL, h INTEGER NOT NULL,
  tx INTEGER, ty INTEGER, tw INTEGER, th INTEGER,    -- text_box (под текстовые слои после MVP), все NULL или все заданы
  ord INTEGER NOT NULL,                              -- 1..n среди неудалённых
  deleted INTEGER NOT NULL DEFAULT 0,
  geometry_ver INTEGER NOT NULL DEFAULT 1,
  source_text TEXT NOT NULL DEFAULT '', translation TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'empty'
        CHECK (state IN ('empty','translated','skipped','unreadable')),
  comment TEXT NOT NULL DEFAULT '', flagged INTEGER NOT NULL DEFAULT 0,
  text_ver INTEGER NOT NULL DEFAULT 0,
  field_vers TEXT NOT NULL DEFAULT '{}',             -- JSON: поле -> text_ver последнего изменения
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT REFERENCES users(id));
CREATE INDEX objects_page ON objects(page_id, deleted, ord);

CREATE TABLE text_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, object_id TEXT NOT NULL, field TEXT NOT NULL,
  old_value TEXT, new_value TEXT, user_id TEXT, at TEXT NOT NULL, text_ver INTEGER NOT NULL);

CREATE TABLE markup_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, page_id TEXT NOT NULL, rev INTEGER NOT NULL,
  user_id TEXT, at TEXT NOT NULL, summary_json TEXT NOT NULL);

CREATE TABLE page_seen (             -- для бейджа «разметка изменилась»
  user_id TEXT NOT NULL, page_id TEXT NOT NULL, markup_rev INTEGER NOT NULL,
  PRIMARY KEY (user_id, page_id));

CREATE TABLE blobs (hash TEXT PRIMARY KEY, size INTEGER NOT NULL, mime TEXT NOT NULL,
                    width INTEGER, height INTEGER, created_at TEXT NOT NULL);

CREATE TABLE exports (
  id TEXT PRIMARY KEY, chapter_id TEXT NOT NULL, user_id TEXT NOT NULL,
  params_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','done','failed','expired')),
  done_pages INTEGER NOT NULL DEFAULT 0, total_pages INTEGER NOT NULL DEFAULT 0,
  file_path TEXT, size_bytes INTEGER, manifest_json TEXT, errors_json TEXT,
  created_at TEXT NOT NULL, finished_at TEXT, expires_at TEXT);
```

## 3. Версионирование и конфликты

### 3.1 Разметка (данные десктопа)
- `pages.markup_rev` увеличивается на 1 при каждом sync, который что-то изменил на странице: набор объектов, `type`, `box`, `text_box`, порядок, `raw/clean/notes/thumb` хэши.
- Десктоп отправляет `base_markup_rev` (для новой страницы `null`). Несовпадение с серверным → `409 REVISION_CONFLICT`; ничего не применяется.
- `objects.geometry_ver` увеличивается при изменении `type`, `box`, `text_box`, порядка, `deleted`.
- Каждое изменение пишет запись в `markup_revisions` с `summary`: `added[]`, `moved[]`, `retyped[]`, `reordered`, `deleted[]`, `restored[]`, `clean_changed`, `notes_changed`.

### 3.2 Текст (данные веба)
- `objects.text_ver` увеличивается на 1 при каждом успешном PATCH.
- `objects.field_vers[field]` = значение `text_ver` на момент последнего изменения этого поля.
- Клиент присылает `base_text_ver` — версию объекта, на которой основаны его правки.
- Сервер для каждого поля из `changes` проверяет `field_vers[field] > base_text_ver`. Если хотя бы одно поле конфликтует — `409 FIELD_CONFLICT` без частичного применения, в ответе серверные значения конфликтующих полей и актуальный объект. Правки **разных** полей одного объекта сливаются без конфликта.
- Если новое значение поля равно текущему, поле не считается изменённым (нет записи в историю, нет роста версии).
- Геометрия и текст никогда не конфликтуют между собой: они в разных столбцах и под разными версиями.

### 3.3 Правила состояния перевода
- `state` ∈ `empty | translated | skipped | unreadable`.
- Если в PATCH нет явного `state`: непустой `translation` ⇒ `translated`; `translation` стал пустым и состояние было `translated` ⇒ `empty`.
- Явный `state = translated` требует непустого `translation`, иначе `422`.
- `skipped` и `unreadable` можно выставить при любом тексте; в экспорте такие объекты не получают текстовых слоёв.

### 3.4 Что делает sync с объектами
- Массив `objects` в sync — полный список неудалённых объектов страницы **в порядке чтения**. Позиция в массиве становится `ord`.
- Серверные объекты, которых нет в массиве, помечаются `deleted = 1` (текст остаётся).
- Если `id` из массива помечен удалённым на сервере — объект восстанавливается.
- Для новых объектов принимается `source_text` (результат OCR). Для существующих `source_text` из sync **игнорируется** (им владеет веб).
- Sync не трогает `translation`, `state`, `comment`, `flagged`.

## 4. Вычисляемые статусы страницы

```
has_clean         = clean_hash IS NOT NULL
counts            = число неудалённых объектов по state
translation_done  = counts.empty == 0          (страница без объектов — done)
ready_for_typing  = has_clean AND translation_done
typed             = typed_at IS NOT NULL       (единственный ручной статус)
markup_changed_for_me = есть запись page_seen для (user, page) AND page.markup_rev > seen.markup_rev
```

## 5. Актуальность экспорта (`psd_input_hash`)

Для каждой страницы считается хэш входных данных PSD:

```
psd_input_hash = sha256(canonicalJson({
  width, height,
  layers: <флаги слоёв экспорта {raw, clean, notes, text}>,
  raw_hash:   layers.raw   ? raw_hash   : null,
  clean_hash: layers.clean ? clean_hash : null,
  notes_hash: layers.notes ? notes_hash : null,
  psd_settings: layers.text ? project.settings.psd                    // после MVP
                            : { raw_layer_visible, notes_opacity },   // MVP
  objects: layers.text ? [ {id, type, box, text_box, order, translation, state}
                           для неудалённых объектов по порядку ]
                       : []                                           // MVP: всегда пусто
}))
```

- `canonicalJson`: ключи по алфавиту, без пробелов, только целые числа и строки. Реализуется один раз в `packages/contract` и используется сервером и тестами.
- Поля, не влияющие на PSD (`comment`, `flagged`, `source_text`), в хэш **не входят**. В MVP текста в PSD нет (`layers.text = false`), поэтому правки перевода и разметки экспорт **не устаревают**; он устаревает при замене клина, пометок или raw/notes-настроек.
- Хэш каждой страницы сохраняется в `manifest.json` экспорта. Страница считается устаревшей, если текущий хэш отличается от сохранённого. Версию генератора храним отдельно в manifest, на актуальность она не влияет.

## 6. Хранилище файлов

```
data/
  db.sqlite
  blobs/ab/cd/<sha256>        # первые 2+2 символа хэша как каталоги
  tmp/                        # незавершённые загрузки
  exports/<export_id>.zip
  backups/
```

- Хэш — SHA-256 в нижнем регистре hex. Загрузка: поток → `tmp` с пересчётом хэша → сравнение с путём → атомарный `rename`.
- Разрешённые типы: `image/png`, `image/jpeg`, `image/webp`. Тип и размеры берутся из заголовка файла, а не из присланных клиентом значений.
- Лимиты: сторона ≤ 30 000 px, площадь ≤ 200 Мпикс, размер файла по конфигу (по умолчанию 128 МБ).
- Raw страницы **неизменяем**. Sync с другим `raw_hash` для существующей страницы → `422 RAW_IMMUTABLE`. Clean и notes можно заменять; их размеры обязаны совпадать с raw (`422 SIZE_MISMATCH`).
- Висящие blob'ы удаляются командой `komaflow-admin gc-blobs` (вручную).

## 7. Инварианты (покрыть тестами)

1. `ord` среди неудалённых объектов страницы — непрерывная последовательность 1..n.
2. Бокс целиком внутри страницы, `w ≥ 1`, `h ≥ 1`; `text_box` либо отсутствует, либо тоже внутри страницы.
3. Sync атомарен: при любой ошибке в БД ничего не изменилось.
4. Повторный sync с теми же данными ничего не меняет (`markup_rev` не растёт).
5. PATCH с неизменённым значением не создаёт версию и историю.
6. Sync не может изменить `translation`, `state`, `comment`, `flagged`; PATCH не может изменить геометрию.
