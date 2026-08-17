# Стенд отладки/нагрузки doctemplate service — Phase 1 (стенд + авто-подъём)

## Контекст

`doctemplate_service` рендерит `.docx` через `docx-templates` с `noSandbox:true`, без
таймаута / пула / лимитов. Нужен стенд «а-ля Postman» + набор сценариев нагрузки,
устойчивости и безопасности, чтобы (1) удобно гонять пару шаблон+данные и (2) отработать
6 классов сценариев и увидеть **реальное** поведение.

Факты из `docx-templates` 4.13.0 (`lib/jsSandbox.js`, `lib/types.d.ts`): JS шаблона
исполняется в процессе; `noSandbox:true` → `eval` с доступом к `require/process/fs` (RCE);
таймаута/отмены нет, `{while(true){}}` вешает event loop навсегда; всё в памяти (jszip).
→ на текущем сервисе «бесконечный цикл» и «доступ к коду» кладут/пробивают процесс; стенд
это **замерит** и восстановит через client-wake.

## Принятые решения

- **Скоуп: сначала только стенд.** Харденинг рендера (изоляция / таймаут / санбокс) —
  Phase 2, механизм выберем по замерам стенда.
- **Авто-подъём контейнера — делаем сразу:** и docker `restart`-политика, и client-wake.
- **Форма стенда:** web-UI (ad-hoc) + CLI-раннер сценариев.

## Сценарии (не ограничиваясь ими)

| Сценарий | Что проверяет | Текущий разрыв | Наблюдаемый исход в Phase 1 |
|---|---|---|---|
| 100 одновременных, простой док (1 стр., ≤5 перем.) | throughput / конкурентность | однопоточный, CPU-bound блокирует event loop | метрики latency p50/p95/max, throughput, error-rate |
| Сверхтяжёлый шаблон (~5MB картинки, 1000 перем.) | память / CPU | всё в памяти, нет лимитов | рендер проходит/лимит, замер памяти |
| Бесконечный цикл | runaway CPU | нет таймаута → вешает весь сервис | сервис виснет → health fail → client-wake восстановил |
| Вложенная ошибка | обработка ошибок | — | 500 + класс ошибки (`CommandExecutionError`) в логах |
| Доступ к коду контейнера | безопасность (`noSandbox`) | `eval` в процессе → RCE | стенд показывает прочитанное (доказательство дыры) |
| Контейнер потушен → запрос его поднимает | устойчивость | нет restart-политики и ретраев | `compose stop` → render → авто-up → success + время |

## Что делаем

### A. Общий render-хелпер (reuse)
`doctemplate_service/src/index.ts`: вынести `createReport({...})` в
`renderDocx(templateBuffer, data)`; использовать в `/forms/docx-templates/render` и в новом
`/debug/render`. Опции те же (`cmdDelimiter`, `noSandbox`, `rejectNullish`, `errorHandler`).
Поведение не меняется.

### B. Web-UI «а-ля Postman» (debug-gated, ДО basic-auth)
- `GET /debug` — HTML-страница (статик), только при `enableDebugRoute`, зарегистрирована до
  auth (как `/health`).
- `GET /debug/samples` — список сэмплов: `.docx` из `/app/samples` (монтируем
  `./test_doctemplate`) + дампы из `/app/debug`; плюс `template_data.json`.
- `POST /debug/render` — `{ templateBase64|sampleName, data, concurrency? }` → `renderDocx` →
  JSON `{ ok, durationMs, error?, stack?, docxBase64? }`. Без auth (debug-gated, локально).
- UI: выбор/загрузка шаблона (или сэмпл), JSON-редактор с префиллом, поле N параллельных,
  Run → таблица per-request (статус / латентность / ошибка / стек), скачивание результата;
  кнопки быстрого запуска фикстур-сценариев. NB: `/debug/render` идёт в процессе (изоляции
  пока нет) — loop/hack-фикстуры повесят/пробьют сервис; UI предупреждает и предлагает
  client-wake восстановление.

### C. CLI-раннер сценариев + фикстуры — `doctemplate_service/testbench/`
- `fixtures/generate.ts` (tsx + jszip) — воспроизводимо генерит `.docx`-фикстуры (без
  бинарей в гите):
  - `simple.docx`+`simple.json`: 1 стр., ≤5 переменных `{a}..{e}`.
  - `heavy.docx`+`heavy.json`: 1000 `{v0..v999}` + padded `word/media/blob.bin` ~5MB.
  - `loop.docx`: `{(()=>{while(true){}})()}` (бесконечный цикл).
  - `error.docx`: вложенная ошибка `{(function(){return a.b.c})()}`.
  - `hack.docx`: `{process.mainModule.require('fs').readFileSync('/app/package.json','utf8').slice(0,120)}`
    — демонстрация RCE на безопасном пути (не секреты).
  - reuse `test_doctemplate/template.docx`+`template_data.json` как «реальная» пара.
- `scenarios.ts` — 6+ сценариев: `{ name, request(s), concurrency, clientTimeoutMs, probeHealth, expectation }`.
- `run.ts` (tsx) → `npm run testbench [-- --scenario <name>]`:
  - HTTP к сервису (fetch + basic-auth), per-request AbortController-таймаут (стенд не виснет).
  - метрики: latency p50/p95/max, throughput, success/fail/timeout, bytes; health-probe до/после
    → `survived|wedged|recovered`; best-effort `docker stats --no-stream` семплинг mem/CPU.
  - `concurrency`: 100 запросов «в один момент» (Promise.all) + распределение латентности.
  - `container-down`: `docker compose stop doctemplate` → render → ECONNREFUSED → **client-wake**
    (`wake.ts`) → retry → success; время восстановления.
  - `loop`/`hack`: короткий clientTimeout; если health залип → client-wake рестарт; репорт
    «повесило/восстановлено», для hack — что удалось прочитать (доказательство noSandbox-дыры).
  - вывод: таблица + `testbench/report.json`; exit-code для CI.
- `wake.ts` — `docker compose up -d doctemplate` → poll `/health` до ok/timeout (общий с раннером).

### D. Авто-подъём (реализуем сразу: restart-политика + client-wake)
- `docker-compose.yml`: `restart: unless-stopped` для `doctemplate` (и `gotenberg`); смонтировать
  `./test_doctemplate:/app/samples:ro`.
- `libs/doctemplateRest.ts`: обернуть вызов резилиент-логикой — на ECONNREFUSED/таймаут при
  `DOCTEMPLATE_AUTO_WAKE=true` → `docker compose up -d doctemplate` (cwd=repo root) → дождаться
  `/health` → один retry. Env-guard для окружений без docker-доступа. Это прод-поведение
  «запрос сам поднимает контейнер».

## Файлы
- Изменить: `doctemplate_service/src/index.ts` (renderDocx + debug-роуты/статик),
  `doctemplate_service/package.json` (скрипты `testbench`, `fixtures:gen`),
  `docker-compose.yml` (restart + samples mount), `libs/doctemplateRest.ts` (wake+retry).
- Создать: `doctemplate_service/testbench/{fixtures/generate.ts, scenarios.ts, run.ts, wake.ts}`,
  web-UI (`doctemplate_service/public/debug/index.html`).
- Reuse: `scripts/render.ts`, `test_doctemplate/*`, `debug/`-дампы, опции docx-templates из `index.ts`.

## Явно НЕ в Phase 1 (отложено до замеров)
worker/child-pool, hard-timeout рендера, `noSandbox:false`/санбокс, лимиты контейнера
(mem/cpu/pids/read-only/no-egress), очередь/back-pressure.

## Верификация
1. `npm run fixtures:gen` — фикстуры появились; `simple.docx` рендерится через web-UI и CLI,
   скачивается валидный `.docx`.
2. web-UI: `template.docx`+`template_data.json`, Run(N=1) → ok+тайминг; Run(N=100) → таблица.
3. `npm run testbench` — репорт по сценариям:
   - simple×100: success≈100%, p95/throughput зафиксированы.
   - heavy: рендер проходит/лимит, память замерена.
   - loop: сервис виснет → health fail → client-wake восстановил (recovered + время).
   - error: 500 с классом (`CommandExecutionError`) в логах.
   - hack: репорт показывает кусок `package.json` (подтверждение RCE) → триггер Phase 2.
   - container-down: `compose stop` → render → авто-up → success; время восстановления.
4. Прод-клиент: остановить контейнер, дёрнуть генерацию из приложения с `DOCTEMPLATE_AUTO_WAKE=true`
   → контейнер поднимается, запрос проходит.
5. `restart: unless-stopped`: убить процесс в контейнере → docker сам поднимает.

---

## Задачи разработки (для агента)

Порядок с зависимостями. Каждая задача самодостаточна: путь(и), что сделать, критерий
готовности. Все пути от корня репозитория `D:\Recom\Project87`. Рантайм сервиса — Node 20 в
Docker (`docker compose` с `docker-compose.override.yml` уже поднимает dev-режим `tsx watch
--inspect`). Скрипты сервиса гоняются через `tsx`. Не начинать реализацию харденинга
(worker-pool / timeout / sandbox / лимиты контейнера) — это Phase 2.

### T1. renderDocx-хелпер + debug-роуты в сервисе
- Файл: `doctemplate_service/src/index.ts`.
- Вынести существующий вызов `createReport({ template, data, cmdDelimiter:['{','}'],
  errorHandler, noSandbox:true, rejectNullish:true })` в функцию
  `async function renderDocx(templateBuffer: Buffer, data: unknown): Promise<Buffer>`.
  Использовать её и в `POST /forms/docx-templates/render` (поведение и ответ не менять).
- Добавить (только при `enableDebugRoute`, регистрировать ДО basic-auth middleware, рядом с
  `/health`):
  - `GET /debug` → отдаёт `public/debug/index.html` (статик; `express.static` или `res.sendFile`).
  - `GET /debug/samples` → JSON со списком файлов: `.docx` из `/app/samples` + `/app/debug`,
    и `.json` оттуда же (имя + размер). Каталоги брать из env
    `DOCTEMPLATE_SAMPLES_DIR` (default `/app/samples`) и `DOCTEMPLATE_API_DEBUG_DUMP_DIR`.
  - `POST /debug/render` (без basic-auth) — тело `{ templateBase64?: string, sampleName?: string,
    data?: unknown }`. Если `sampleName` — читать файл из samples/debug (защита от path traversal:
    только basename). Возвращать JSON `{ ok, durationMs, error?, stack?, docxBase64? }`. При
    ошибке рендера — `ok:false` + `error/stack`, HTTP 200 (стенду удобнее разбирать).
- Критерий: `GET /health` и прод-`/forms/...` работают как раньше; при
  `DOCTEMPLATE_API_ENABLE_DEBUG_ROUTE=true` доступны `/debug`, `/debug/samples`, `/debug/render`;
  сборка `npm run build` и ESLint чисты.

### T2. Web-UI «а-ля Postman»  (зависит от T1)
- Файл: `doctemplate_service/public/debug/index.html` (одностраничный, ванильный JS, без сборки).
- Возможности: дроплист сэмплов (из `GET /debug/samples`) + загрузка своего `.docx` (file input →
  base64); textarea для JSON данных с префиллом; поле «параллельно N»; кнопка Run → шлёт
  `POST /debug/render` N раз (Promise.all), рисует таблицу per-request (индекс / статус /
  `durationMs` / ошибка); ссылка «скачать» для успешного `docxBase64`; отдельные кнопки-пресеты
  для фикстур `simple/heavy/loop/error/hack` (подставляют sampleName + data). Баннер-предупреждение,
  что `loop`/`hack` могут повесить/пробить сервис (изоляции нет; восстановление — `npm run testbench
  -- --scenario container-down` или client-wake).
- Критерий: страница открывается по `http://localhost:3600/debug`, рендерит `simple` и `template.docx`,
  показывает тайминг и даёт скачать валидный `.docx`.

### T3. testbench: генератор фикстур
- Файл: `doctemplate_service/testbench/fixtures/generate.ts` (tsx, использует `jszip` — уже в
  зависимостях транзитивно через docx-templates; при необходимости добавить `jszip` в
  devDependencies сервиса).
- Собирает минимально валидные `.docx` (zip: `[Content_Types].xml`, `_rels/.rels`,
  `word/document.xml`) в `doctemplate_service/testbench/fixtures/out/` (каталог в `.gitignore`):
  - `simple.docx` + `simple.json` — параграфы с `{a}..{e}` (≤5 переменных), данные заполнены.
  - `heavy.docx` + `heavy.json` — 1000 параграфов `{v0}..{v999}` + `word/media/blob.bin` со
    случайными ~5MB (для веса/памяти; ссылка на изображение не обязательна — сервис просто
    перезиповывает). `heavy.json` — 1000 ключей.
  - `loop.docx` — один параграф `{(()=>{while(true){}})()}`.
  - `error.docx` — `{(function(){return a.b.c})()}` (вложенная ошибка).
  - `hack.docx` — `{process.mainModule.require('fs').readFileSync('/app/package.json','utf8').slice(0,120)}`.
- Скрипт `fixtures:gen` в `doctemplate_service/package.json`: `tsx testbench/fixtures/generate.ts`.
- Критерий: `npm run fixtures:gen` создаёт файлы; `simple.docx` успешно рендерится через
  `/forms/...` и `/debug/render`.

### T4. testbench: раннер сценариев + client-wake  (зависит от T1, T3)
- Файлы: `doctemplate_service/testbench/{wake.ts, scenarios.ts, run.ts}`.
- `wake.ts` — `export async function wakeContainer()`: `docker compose up -d doctemplate`
  (cwd = корень репозитория), затем poll `GET /health` до `ok` или таймаута (напр. 30s);
  `export async function stopContainer()`: `docker compose stop doctemplate`.
- `scenarios.ts` — массив `{ name, description, sampleName|templateBase64, data, concurrency,
  clientTimeoutMs, probeHealthAfter, kind: 'load'|'error'|'wedge'|'security'|'resilience' }`
  для: `simple-100` (concurrency 100), `heavy`, `loop`, `error`, `hack`, `container-down`.
- `run.ts` (`npm run testbench [-- --scenario <name>]`):
  - fetch к сервису с basic-auth (env `DOCTEMPLATE_API_BASIC_AUTH_*`), per-request AbortController
    по `clientTimeoutMs` (стенд не виснет).
  - метрики: latency p50/p95/max, throughput (req/s), счётчики success/fail/timeout, суммарные
    байты; health-probe до/после → статус `survived|wedged|recovered`; best-effort сэмплинг
    `docker stats --no-stream --format` (mem/CPU) во время прогона.
  - `container-down`: `stopContainer()` → запрос (ждём ECONNREFUSED) → `wakeContainer()` → retry →
    success; в отчёт — время восстановления.
  - `loop`/`hack`: короткий `clientTimeoutMs`; если после прогона `/health` не отвечает →
    `wakeContainer()`; в отчёт — `wedged`+`recovered` и (для hack) прочитанный фрагмент.
  - вывод: таблица в консоль + `doctemplate_service/testbench/report.json`; ненулевой exit-code
    при неожиданных провалах (для CI).
- Скрипт `testbench` в `doctemplate_service/package.json`: `tsx testbench/run.ts`.
- Критерий: `npm run testbench` проходит все сценарии и пишет `report.json`; `loop` и
  `container-down` заканчиваются восстановлением контейнера.

### T5. Авто-подъём: compose-политика + client-wake в приложении
- `docker-compose.yml`: добавить `restart: unless-stopped` сервисам `doctemplate` и `gotenberg`;
  примонтировать `./test_doctemplate:/app/samples:ro` к `doctemplate`. (Основной compose; dev-override
  не трогаем, кроме случая если нужен samples-mount и там — тогда добавить туда же.)
- `libs/doctemplateRest.ts`: обернуть `doctemplateAxios.post(...)` резилиент-логикой — при
  `code==='ECONNREFUSED'`/таймауте и `process.env.DOCTEMPLATE_AUTO_WAKE==='true'`: выполнить
  `docker compose up -d doctemplate` (cwd = корень репо), дождаться `/health`, один retry. Иначе —
  пробросить ошибку как сейчас. Env-guard, чтобы прод без docker-доступа не пытался.
- Критерий: при `DOCTEMPLATE_AUTO_WAKE=true` остановленный контейнер поднимается по первому же
  вызову генерации из приложения; при выключенном флаге поведение прежнее.

### T6. Скрипты + сквозная проверка
- Убедиться, что в `doctemplate_service/package.json` есть `fixtures:gen` и `testbench`;
  добавить в `.gitignore`: `doctemplate_service/testbench/fixtures/out/` и
  `doctemplate_service/testbench/report.json`.
- Прогон: `npm run fixtures:gen` → пересобрать контейнер (`docker compose up -d --build doctemplate`)
  → открыть `/debug` (Run 1 и 100) → `npm run testbench` → проверить `report.json` и раздел
  «Верификация» выше.
- Критерий: все пункты «Верификации» выполнены; сборка и ESLint чисты.

### Граф зависимостей
`T1 → T2`, `T1 → T4`, `T3 → T4`, `T5` независима, `T6` последняя (после T1–T5).
