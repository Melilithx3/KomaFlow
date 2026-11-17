# Сборка komaflow

Инструкция для чистой машины с Windows 10/11 x64. Для сервера на Linux (Orange Pi) — раздел 4 и `deploy/README.md`.

## 0. Что из чего состоит

| Часть | Папка | Нужно для сборки |
|---|---|---|
| Сервер (API + отдача веба) | `apps/server` | Node.js 24.7+ и pnpm 10 |
| Веб | `apps/web` | то же |
| Десктоп клинера (Tauri 2) | `apps/desktop` | то же + Rust (MSVC) + WebView2 |
| Движок анализа (Python) | `sidecar` | Python 3.12+ и `uv`, видеокарта AMD для OCR |

## 1. Общая подготовка (один раз)

1. **Git:** https://git-scm.com/download/win.
2. **Node.js 24 LTS** (не ниже 24.7, официальный установщик x64 с https://nodejs.org). Проверка: `node --version`.
3. **pnpm** через corepack (в PowerShell от имени администратора):
   ```powershell
   corepack enable
   corepack prepare pnpm@10.34.9 --activate
   ```
4. Клонировать репозиторий и поставить зависимости:
   ```powershell
   git clone <адрес репозитория> komaflow
   cd komaflow
   pnpm install
   ```
   Компилятор для этого не нужен: SQLite и argon2 встроены в Node, `sharp` ставится готовым бинарником.
5. Проверка, что всё собирается:
   ```powershell
   pnpm test        # ~130 тестов, все зелёные
   pnpm build       # apps/server/dist, apps/web/dist, apps/desktop/dist
   ```

## 2. Посмотреть всё локально (режим разработки)

```powershell
copy apps\server\.env.example apps\server\.env
$env:KOMAFLOW_DEV="1"; pnpm --filter @komaflow/server admin -- seed --fixtures
```
Команда создаёт пользователя `demo` / `demo-password` и демо-главу. Затем в трёх окнах PowerShell:

```powershell
pnpm dev:server                          # API на http://127.0.0.1:8787
pnpm dev:web                             # веб на http://localhost:5173
pnpm --filter @komaflow/desktop dev      # интерфейс десктопа в браузере на http://localhost:1420
```
Данные разработки лежат в `apps/server/data` (в git не попадают).

## 3. Прод-сервер на Windows (запасной вариант)

```powershell
pnpm build
node --env-file=C:\komaflow\komaflow.env apps\server\dist\server.js
```
Сервер сам отдаёт и API, и собранный веб из `apps/web/dist`. Образец env — `deploy/komaflow.env.example`. Запуск службой через NSSM, бэкапы и HTTPS — `deploy/windows/README.md`.

## 4. Прод-сервер на Orange Pi (Linux ARM64)

Всё по `deploy/README.md`: Node 24, `pnpm install --frozen-lockfile`, `pnpm build`, systemd-юнит, nginx + certbot, первый пользователь через `komaflow-admin create-user`. Перед этим желательно прогнать спайк S3: `bash tools/spikes/s3-arm/run.sh`.

## 5. Десктоп (установщик для клинера)

> Rust-часть десктопа ещё ни разу не собиралась: на машине разработки не было Rust. Первая сборка может выдать ошибки компиляции — пришлите вывод, исправим.

1. **Visual Studio Build Tools 2022** с компонентом «Разработка классических приложений на C++» (MSVC + Windows SDK): https://visualstudio.microsoft.com/visual-cpp-build-tools/
2. **Rust:** https://rustup.rs → стандартная установка (toolchain `stable-x86_64-pc-windows-msvc`). Проверка: `cargo --version`.
3. **WebView2** уже есть в Windows 10/11. Если нет — Evergreen Runtime с сайта Microsoft.
4. Иконки (один раз): из SVG генерируются `icon.ico` / `icon.png`.
   ```powershell
   pnpm --filter @komaflow/desktop tauri icon src-tauri/icons/icon.svg
   ```
   Если команда не примет SVG, подставьте любой PNG 1024×1024.
5. Запуск в режиме разработки (первый раз собирается 5–15 минут):
   ```powershell
   pnpm --filter @komaflow/desktop tauri dev
   ```
6. Установщик:
   ```powershell
   pnpm --filter @komaflow/desktop tauri build
   ```
   Результат: `apps\desktop\src-tauri\target\release\bundle\nsis\komaflow_0.1.0_x64-setup.exe` (ставится без прав администратора) и `...\bundle\msi\*.msi`.

Токен входа хранится в «Диспетчере учётных данных Windows» (запись `komaflow`). Рабочие папки глав — `%LOCALAPPDATA%\komaflow\workspaces`.

## 6. Движок анализа (ПК клинера с AMD gfx1030/1031/1032)

Десктоп без движка работает: боксы рисуются вручную. Чтобы включить анализ:

```powershell
pip install uv                                   # или установщик с https://docs.astral.sh/uv/
cd sidecar
python -m venv .venv
.venv\Scripts\python -m pip install -e .
.venv\Scripts\komaflow-sidecar install --backends rocm,cpu --models layout,ocr,lama
```
Установка скачивает около 8 ГБ (модели разметки, OCR и LaMa для автоклина): изолированный Python 3.12 через uv, PyTorch ROCm с точными версиями из `sidecar/locks/`, веса моделей по зафиксированным ревизиям. Глобальный Python не меняется. Всё ставится в `%LOCALAPPDATA%\komaflow\sidecar`, лог — в `...\sidecar\logs`.

Проверка без десктопа (спайк S2), подробности — в `docs/spikes/S2-report.md`:
```powershell
.venv\Scripts\komaflow-sidecar analyze --pages test_data --out out\s2 --overlay
```
Собранный десктоп сам находит установленный движок и запускает его.

Тесты движка без видеокарты (модели заменены заглушками):
```powershell
.venv\Scripts\python -m pip install pytest
.venv\Scripts\python -m pytest
```

## 7. Частые проблемы

- **`node:sqlite` или `crypto.argon2` не найдены** — Node старше 24.7. Обновите Node.
- **`pnpm` не найден** — повторите `corepack enable` в консоли администратора и откройте новое окно.
- **sharp не ставится** (редко, нестандартная платформа) — `pnpm rebuild sharp`. Для Orange Pi нужен официальный Node arm64.
- **Веб открывается, но вход не держится по http** — в режиме разработки нужен `KOMAFLOW_DEV=1`: без него cookie помечается `Secure` и работает только по HTTPS.
- **Порт занят** — `KOMAFLOW_PORT` в `apps/server/.env` (для веба и десктопа тогда поправьте proxy в их `vite.config.ts`).
