# Обновление komaflow

Как обновить установленную систему до новой версии из GitHub. Данные (база, файлы, рабочие папки глав) при обновлении сохраняются. Схема базы обновляется сама при старте сервера, а перед изменением сервер делает её копию.

> **Обновлять все части вместе.** В версии с поворотом боксов (миграция `0002`) старый десктоп при публикации сбросил бы поворот в 0. Поэтому сначала сервер, потом сразу десктоп клинера.

Перед обновлением загляните в историю изменений: `git log --oneline HEAD..origin/main` (после `git fetch`).

---

## 1. Сервер на Orange Pi (Linux, systemd)

```bash
cd /opt/komaflow
sudo -u komaflow env $(cat /etc/komaflow/komaflow.env | xargs) node apps/server/dist/admin.js backup   # страховочная копия БД
sudo systemctl stop komaflow
sudo git fetch && sudo git checkout main && sudo git pull --ff-only
sudo pnpm install --frozen-lockfile
sudo pnpm build
sudo systemctl start komaflow
journalctl -u komaflow -n 40 --no-pager      # ищем ошибки миграций
curl -s http://127.0.0.1:8787/healthz        # {"ok":true,...}
```

- Миграции применяются при старте; копия базы до миграции — `/var/lib/komaflow/backups/db-pre-0002.sqlite`.
- Если пользователи видят старый интерфейс, пусть обновят страницу: `index.html` не кэшируется, ресурсы версионированы.
- **Откат:** `sudo systemctl stop komaflow`, `git checkout <предыдущий коммит>`, `pnpm install --frozen-lockfile && pnpm build`. Затем замените `db.sqlite` копией `db-pre-NNNN.sqlite` и удалите `db.sqlite-wal` и `db.sqlite-shm`. Запустите службу. Правки, сделанные после обновления, при откате базы пропадут.

## 2. Сервер на Windows (NSSM)

В PowerShell от имени администратора:
```powershell
cd C:\komaflow\app
node --env-file=C:\komaflow\komaflow.env apps\server\dist\admin.js backup
nssm stop komaflow
git pull --ff-only
pnpm install --frozen-lockfile
pnpm build
nssm start komaflow
Invoke-RestMethod http://127.0.0.1:8787/healthz
```
Логи службы — `C:\komaflow\logs\server.log`.

## 3. Вторая машина (ПК клинера: десктоп и движок анализа)

### 3.1 Код
```powershell
cd D:\komaflow          # папка с клоном репозитория
git pull --ff-only
pnpm install
pnpm test               # по желанию: убедиться, что всё зелёное
```

### 3.2 Десктоп
- **Собранная программа (установщик):**
  ```powershell
  pnpm --filter @komaflow/desktop tauri build
  ```
  Затем запустите новый `apps\desktop\src-tauri\target\release\bundle\nsis\komaflow_*_x64-setup.exe` поверх старой версии.
- **Режим разработки:** `pnpm --filter @komaflow/desktop tauri dev`.
- Рабочие папки глав (`%LOCALAPPDATA%\komaflow\workspaces`) и вход в аккаунт сохраняются.
- Старые главы открываются как есть: у боксов без поворота он считается равным 0.
- Перед обновлением опубликуйте открытые главы. Если на сервере кто-то менял разметку, при публикации появится вопрос о конфликте — это нормально.
- Новые параметры разметки по классам (bubble / text / onomatopoeia / panel) находятся на стартовом экране и в редакторе (кнопка ⚙ у «Разметки»). Значения по умолчанию: panel выключен, пороги — рекомендованные моделью.

### 3.3 Движок анализа (sidecar)
Код движка подтягивается вместе с репозиторием; собранный десктоп берёт его из своей установки.
Окружение с PyTorch и модели переустанавливать **не нужно**, если не менялись `sidecar/locks/*` и `sidecar/komaflow_sidecar/catalog.py`. Проверить можно так:
```powershell
git diff --stat <старый_коммит> HEAD -- sidecar/locks sidecar/komaflow_sidecar/catalog.py
```
Если эти файлы менялись:
```powershell
cd sidecar
.venv\Scripts\python -m pip install -e .
.venv\Scripts\komaflow-sidecar install --backends rocm,cpu --models layout,ocr
```
Проверка движка без десктопа: `.venv\Scripts\komaflow-sidecar capabilities`.

### 3.4 Если на второй машине тоже запускается dev-сервер
```powershell
pnpm dev:server       # миграция применится к apps\server\data\db.sqlite
```

## 4. После обновления — короткая проверка
1. Веб: вход, открыть страницу.
   - Колесо прокручивает страницу, Ctrl+колесо приближает.
   - Номера стоят снаружи боксов.
   - Есть кнопки «JSON для ИИ», «Импорт JSON» и меню «Регистр оригинала».
2. Десктоп: открыть главу.
   - Q/E поворачивают бокс.
   - Номер в списке объектов можно вписать вручную.
   - Кнопки «1. Разметка» и «2. OCR» работают раздельно.
3. Опубликовать главу с одним повёрнутым боксом и убедиться, что в вебе он нарисован с наклоном.
