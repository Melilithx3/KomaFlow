# 03. Сервер: безопасность, деплой, эксплуатация

## 1. Целевая среда и бюджет ресурсов

- Основная: Orange Pi Zero 3 — ARM64, 4 ГБ ОЗУ, SD-карта, Linux. Запасная: Windows x64.
- Один процесс Node. Ориентиры: RSS в покое < 150 МБ, под нагрузкой трёх клиентов < 400 МБ (`--max-old-space-size=512`).
- Сервер **не декодирует картинки при загрузке** (проверка по заголовку). Декодирование нужно только воркеру экспорта.
- Все нативные зависимости (SQLite-драйвер, argon2, кодек PNG/sharp) должны ставиться на linux-arm64 без компилятора на устройстве, либо быть заменены на чистые JS-варианты. Проверяется спайком S3.

## 2. Конфигурация (переменные окружения / env-файл)

| Переменная | По умолчанию | Смысл |
|---|---|---|
| `KOMAFLOW_DATA_DIR` | `./data` | каталог данных |
| `KOMAFLOW_HOST` / `KOMAFLOW_PORT` | `127.0.0.1` / `8787` | слушать только localhost за nginx |
| `KOMAFLOW_BASE_URL` | — | публичный URL, `https://komaflow.tlinmo.site` |
| `KOMAFLOW_TRUST_PROXY` | `true` | доверять `X-Forwarded-*` от nginx |
| `KOMAFLOW_SESSION_DAYS` | `90` | срок жизни токена (скользящий) |
| `KOMAFLOW_MAX_BLOB_MB` | `128` | лимит файла |
| `KOMAFLOW_MAX_PIXELS` | `200000000` | лимит площади изображения |
| `KOMAFLOW_EXPORT_TTL_DAYS` | `7` | срок хранения экспортов |
| `KOMAFLOW_LOG_LEVEL` | `info` | |
| `KOMAFLOW_TMP_DIR`, `KOMAFLOW_EXPORT_DIR` | внутри `DATA_DIR` | можно вынести с SD-карты |

## 3. Безопасность

- Публично только `POST /auth/login` и `GET /healthz`. Регистрации нет; пользователей создаёт `komaflow-admin`.
- Пароли — argon2id. Параметры подбираются так, чтобы логин на Orange Pi занимал 0,3–0,5 с и до ~64 МБ памяти.
- Токен сессии — 32 случайных байта (base64url). В БД хранится только SHA-256. Токен на каждое устройство, отзыв через `DELETE /me/sessions/{id}`.
- Web: cookie httpOnly + Secure + SameSite=Lax. Desktop: Bearer-токен лежит в Windows Credential Manager.
- Ограничение попыток входа: не более 5 неудач за 10 минут на пару (IP, login) с нарастающей задержкой; дополнительно `limit_req` в nginx. Ответ на неверный логин и неверный пароль одинаковый.
- Валидация входа zod'ом на каждом эндпоинте. Файлы проверяются по сигнатуре, размеры — по заголовку; лимиты пикселей против «бомб» обязательны.
- Заголовки: `X-Content-Type-Options: nosniff`, строгий `Content-Security-Policy` для веба, `Referrer-Policy: same-origin`.
- Логи не содержат паролей, токенов и текстов переводов.

## 4. Деплой

### nginx (уже настроен у пользователя, нужен конфиг сайта)
```nginx
# в http { }
limit_req_zone $binary_remote_addr zone=komaflow_login:10m rate=10r/m;

server {
  listen 443 ssl http2;
  server_name komaflow.tlinmo.site;
  # ssl_certificate ... (certbot)
  client_max_body_size 256m;

  location = /api/v1/auth/login {
    limit_req zone=komaflow_login burst=5 nodelay;
    proxy_pass http://127.0.0.1:8787;
    include /etc/nginx/komaflow-proxy.conf;
  }
  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_request_buffering off;      # потоковые загрузки
    proxy_read_timeout 300s;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
server { listen 80; server_name komaflow.tlinmo.site; return 301 https://$host$request_uri; }
```
Один Node-процесс отдаёт и API, и собранную статику веба (`@fastify/static`; хэшированные ассеты — с долгим кэшем, `index.html` — без кэша).

### systemd (Linux)
Юнит в `deploy/systemd/komaflow.service`: пользователь `komaflow` (не root), `Restart=always`, `EnvironmentFile=/etc/komaflow/komaflow.env`, `WorkingDirectory`, `ProtectSystem=strict`, `ReadWritePaths=/var/lib/komaflow`, `NoNewPrivileges=true`.

### Windows
Запуск как служба через NSSM (или задача планировщика «при запуске»); инструкция в `deploy/windows/README.md`. Пути и конфиг те же, что на Linux.

### Установка и обновление
`deploy/README.md`: установка Node, создание пользователя и каталогов, certbot для поддомена, включение юнита, создание первого пользователя, обновление (остановка → `git pull`/распаковка релиза → `pnpm install --frozen-lockfile` → миграции при старте → запуск).

## 5. Бережём SD-карту

- SQLite: `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout` ≥ 5000, `foreign_keys=ON`; периодический checkpoint.
- Логи — в journald с ограничением размера; в файлы не писать.
- Экспорты удаляются по сроку (`EXPORT_TTL_DAYS`), статус `expired`; временные файлы удаляются по завершении.
- Каталоги `tmp` и `exports` настраиваются отдельно, чтобы при желании вынести их на другой носитель.

## 6. Миграции и БД

- Файлы `apps/server/migrations/NNNN_name.sql` применяются при старте по порядку; таблица `schema_migrations`.
- Перед применением новой миграции на непустой БД автоматически делается копия `db-pre-NNNN.sqlite` в `data/backups/`.
- Тонкий слой доступа к БД (интерфейс репозиториев), чтобы драйвер можно было заменить.

## 7. Admin CLI (`komaflow-admin`)

`create-user <login> [--name]` (пароль запрашивается интерактивно), `set-password`, `disable-user`, `list-users`, `list-sessions`, `revoke-session`, `backup [--out]`, `dump-text [--out]`, `gc-blobs [--dry-run]`, `seed --fixtures` (только dev).

## 8. Бэкап (не первоочередной, но спроектировать сразу)

- `backup`: онлайн-копия SQLite через backup API → `data/backups/db-YYYYMMDD.sqlite`, хранить 7 копий.
- `dump-text`: JSON со всеми текстовыми данными (по главам и страницам: объекты, `source_text`, `translation`, `state`, `comment`).
- Пример `systemd timer` для ночного запуска в `deploy/`.
- Явная оговорка в README: копия на той же SD-карте не защищает от выхода карты из строя; рекомендовано периодически забирать `dump-text` и `db-*.sqlite` на другой носитель.

## 9. Наблюдаемость

JSON-логи с `request_id`, временем обработки, кодом ответа; отдельные записи о завершении экспорта (время на страницу, пик памяти). `GET /healthz` проверяет доступность БД.

## 10. Целевые показатели (на Orange Pi, под нагрузкой трёх клиентов)

- Эндпоинты, кроме blobs и экспорта: p95 < 200 мс.
- Загрузка blob 30 МБ по локальной сети: < 20 с.
- Экспорт главы из 20 страниц: допустимо до ~10 минут. Если замеры S1/S3 покажут больше — см. решение «PSD в браузере» в `docs/04-psd.md`.
