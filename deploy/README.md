# komaflow — руководство оператора

Сервер: один процесс Node, отдаёт API и веб. Данные — каталог `KOMAFLOW_DATA_DIR` (SQLite + файлы).
Основная машина — Orange Pi Zero 3 (Armbian/Debian ARM64), запасная — Windows x64 (см. [windows/README.md](windows/README.md)).

## 1. Установка на Linux (Orange Pi)

```bash
# Node 24 LTS (официальная сборка; встроенные node:sqlite и crypto.argon2) и pnpm
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs nginx certbot git
sudo corepack enable

# пользователь и каталоги
sudo useradd --system --home /var/lib/komaflow --shell /usr/sbin/nologin komaflow
sudo mkdir -p /opt/komaflow /var/lib/komaflow /etc/komaflow
sudo chown komaflow:komaflow /var/lib/komaflow

# код и сборка (собирать можно на ПК и копировать — на Pi компилятор не нужен)
sudo git clone <repo> /opt/komaflow && cd /opt/komaflow
sudo pnpm install --frozen-lockfile
sudo pnpm build

# конфиг
sudo cp deploy/komaflow.env.example /etc/komaflow/komaflow.env   # отредактировать
sudo cp deploy/systemd/komaflow*.service deploy/systemd/komaflow-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now komaflow komaflow-backup.timer
curl -s http://127.0.0.1:8787/healthz     # {"ok":true,...}
```

Миграции БД применяются при старте; перед новой миграцией делается копия `backups/db-pre-NNNN.sqlite`.

### Первый пользователь

```bash
cd /opt/komaflow
sudo -u komaflow env $(cat /etc/komaflow/komaflow.env | xargs) node apps/server/dist/admin.js create-user cleaner --name "Клинер"
```
Пароль спрашивается дважды. Регистрации нет: всех участников создаёт оператор (`create-user`), пароль меняют сами в вебе.

## 2. nginx и HTTPS

```bash
echo 'limit_req_zone $binary_remote_addr zone=komaflow_login:10m rate=10r/m;' | sudo tee /etc/nginx/conf.d/komaflow-limit.conf
sudo cp deploy/nginx/komaflow-proxy.conf /etc/nginx/komaflow-proxy.conf
sudo cp deploy/nginx/komaflow.conf /etc/nginx/sites-available/ && sudo ln -s ../sites-available/komaflow.conf /etc/nginx/sites-enabled/
# сертификат для поддомена (до выпуска закомментировать server 443 или использовать --nginx)
sudo certbot certonly --webroot -w /var/www/certbot -d komaflow.tlinmo.site
sudo nginx -t && sudo systemctl reload nginx
```

Проброс портов на роутере: 80 и 443 на Orange Pi. Порт 8787 наружу не открывать (сервер слушает только `127.0.0.1`).

## 3. Обновление

```bash
sudo systemctl stop komaflow
cd /opt/komaflow && sudo git pull
sudo pnpm install --frozen-lockfile && sudo pnpm build
sudo systemctl start komaflow && journalctl -u komaflow -n 30
```

## 4. Обслуживание (`komaflow-admin`)

`node apps/server/dist/admin.js <команда>` с тем же env, что у службы:

| Команда | Что делает |
|---|---|
| `create-user <login> [--name …]`, `set-password <login>` | пользователи (пароль — интерактивно или через stdin) |
| `disable-user <login>` / `enable-user <login>` | блокировка (сессии отзываются) |
| `list-users`, `list-sessions [login]`, `revoke-session <id>` | устройства |
| `backup [--out file]` | онлайн-копия SQLite в `backups/db-YYYYMMDD.sqlite`, хранится 7 копий |
| `dump-text [--out file]` | все тексты (оригинал, перевод, состояние, комментарии) в JSON |
| `gc-blobs [--dry-run]` | удалить файлы, на которые не ссылается ни одна страница |

Ночной бэкап делает `komaflow-backup.timer` (04:30): копия БД + `text-YYYYMMDD.json`.

> **Важно:** копия на той же SD-карте не спасёт при выходе карты из строя. Периодически забирайте
> `backups/db-*.sqlite` и `backups/text-*.json` на другой носитель (`scp`, флешка). Каталог `blobs/` нужен,
> чтобы восстановить картинки; без него восстанавливаются все тексты и разметка (картинки клинер перепубликует).

Восстановление: остановить службу, положить копию как `$KOMAFLOW_DATA_DIR/db.sqlite` (удалить `db.sqlite-wal`/`-shm`), запустить.

## 5. Бережём SD-карту

- SQLite в WAL, `synchronous=NORMAL`, checkpoint раз в час; логи только в journald (ограничьте `SystemMaxUse`).
- `KOMAFLOW_TMP_DIR` и `KOMAFLOW_EXPORT_DIR` можно вынести на USB-диск; экспорты удаляются через `KOMAFLOW_EXPORT_TTL_DAYS`.

## 6. Чеклист безопасности (docs/03 §3) — проверено в коде и тестах

- [x] Публичны только `POST /api/v1/auth/login` и `GET /healthz`; остальное — 401 без сессии (тест `auth.test.ts`).
- [x] Пароли argon2id (PHC), одинаковый ответ на неверный логин и пароль, 5 неудач за 10 мин на (IP, логин) → 429 + nginx `limit_req`.
- [x] Токен 32 случайных байта, в БД только SHA-256; сессия на устройство, отзыв; срок 90 дней со скользящим продлением.
- [x] Cookie `HttpOnly`, `Secure` (вне dev-режима), `SameSite=Lax`; для записи через cookie обязателен `X-Komaflow-Client: web`; CORS выключен.
- [x] Загрузка файлов и sync — только сессии `desktop` (403 для веба).
- [x] zod-валидация каждого тела; файлы проверяются по сигнатуре, размеры по заголовку, лимиты стороны и площади.
- [x] Заголовки `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, строгий CSP для веба; HSTS в nginx.
- [x] Логи без паролей, токенов и текстов (логируются метод, путь, код, время).
- [x] `/openapi.json` только при `KOMAFLOW_DEV=1`. Сервер слушает `127.0.0.1`.
- [ ] Подобрать argon2 на Pi (S3) и прописать в env.

## 7. Нагрузка

`node tools/spikes/s3-arm/load.mjs` — сборка, сид, сервер и 3 параллельных клиента (GET глава/blob/страница + PATCH + sync), p95 и пик RSS. Результаты на Pi — в `docs/spikes/S3-report.md`.
