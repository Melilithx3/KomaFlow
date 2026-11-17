# komaflow на Windows (запасной сервер)

Пути и конфиг те же, что на Linux; отличается только запуск службы.

1. Установить Node 24 LTS (x64, msi с nodejs.org) и включить pnpm: `corepack enable`.
2. Скопировать репозиторий в `C:\komaflow\app`, выполнить `pnpm install --frozen-lockfile` и `pnpm build`.
3. Создать `C:\komaflow\komaflow.env` по образцу `deploy/komaflow.env.example`, указав
   `KOMAFLOW_DATA_DIR=C:\komaflow\data`.
4. Служба через [NSSM](https://nssm.cc/) (от администратора):

   ```bat
   nssm install komaflow "C:\Program Files\nodejs\node.exe" --env-file=C:\komaflow\komaflow.env --max-old-space-size=512 apps\server\dist\server.js
   nssm set komaflow AppDirectory C:\komaflow\app
   nssm set komaflow AppStdout C:\komaflow\logs\server.log
   nssm set komaflow AppStderr C:\komaflow\logs\server.log
   nssm set komaflow AppRotateFiles 1
   nssm set komaflow AppRotateBytes 10485760
   nssm start komaflow
   ```

   Без NSSM: Планировщик заданий → «При запуске компьютера», та же команда, «Выполнять независимо от входа пользователя».
5. Первый пользователь: `node --env-file=C:\komaflow\komaflow.env apps\server\dist\admin.js create-user cleaner --name "Клинер"`.
6. Ночной бэкап: задание Планировщика на 04:30 с командой
   `node --env-file=C:\komaflow\komaflow.env apps\server\dist\admin.js backup`.
7. HTTPS: nginx для Windows или Caddy перед `127.0.0.1:8787` (конфиг nginx из `deploy/nginx/` подходит без изменений,
   кроме путей к сертификатам).
