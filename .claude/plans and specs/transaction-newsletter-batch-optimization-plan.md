# План: устранение N+1 в sendTransactionNewsletterBatch + гранулярный статус вложений

## Контекст

На ветке `prokhorenko_transactions_newsletter` в рабочей копии (незакоммичено на
момент написания) уже написана оптимизированная версия батч-рассылки, но она
**не подключена** — это и есть основной разрыв между кодом и спекой, который нужно
закрыть перед коммитом.

Фактическое состояние `models/account.ts`:

- `sendTransactionNewsletterNew` (строка 350) — новая реализация: грузит
  `mailboxList`/`staffList` **один раз на весь батч** (а не по разу на каждую
  user_id:account_id группу, как раньше), передаёт их в `sendTransactionNewsletter`
  через `opts.from`/`opts.staffList`. Метод существует, но **нигде не вызывается**.
- `sendTransactionNewsletterBatch` (строка 582) — старая реализация с N+1
  (`getMainMailboxAddress`/`loadStaffList` внутри `sendTransactionNewsletter` на
  каждую группу отдельно). Именно её продолжают вызывать:
  - `executeTransactionTemplate` (строка ~1636, cron/авто-путь);
  - `routes/sendTransactionNewsletter.ts:72` (var2, ручной HTTP-путь).
- `sendTransactionNewsletter` (строка 439, общий воркер на группу) уже обновлён и
  используется обеими версиями батча одинаково — сюда же перенесена
  сборка вложений **до** `createDraft`, с try/catch на каждую транзакцию
  (`statuses.set(id, 'sent'|'failed')`), вместо прежнего `markAll('sent')` после
  единственного общего цикла. Т.е. частичный отказ внутри группы (см.
  `doctemplate_service/docs/newsletter-retry-open-questions.md`, вопрос 1) уже
  частично решён на уровне сборки вложений: не смогли отрендерить одну транзакцию —
  остальные вложения группы всё равно уйдут одним письмом, а не упавшая помечается
  `failed`. Ретраев и персистентности это не даёт — вопросы 2-6 остаются открытыми.

## Разрыв, который нужно закрыть

1. `sendTransactionNewsletterNew` — мёртвый код: ни один вызывающий не переключён на
   него, оптимизация N+1 фактически не работает в проде.
2. После переключения `sendTransactionNewsletterBatch` (старая версия) становится
   полным дублем и подлежит удалению вместе с переименованием
   `sendTransactionNewsletterNew` → `sendTransactionNewsletterBatch` (рабочее имя
   `...New` — временное, из процесса рефакторинга).
3. Тестов на `sendTransactionNewsletterBatch`/`sendTransactionNewsletter` нет вообще
   (0 совпадений в `test/`, `test_doctemplate/`), несмотря на то, что метод — точка
   реальных потерь писем (см. open-questions документ).

## Задачи

- [x] В `executeTransactionTemplate` и `routes/sendTransactionNewsletter.ts:72`
      переключить вызов на `sendTransactionNewsletterNew`.
- [x] Удалить старую `sendTransactionNewsletterBatch` (строки 582-631).
- [x] Переименовать `sendTransactionNewsletterNew` → `sendTransactionNewsletterBatch`
      (включая `__name`/`__location` внутри метода и вызовы `.catch(...)` с
      `${__location}.sendTransactionNewsletterBatch` в `executeTransactionTemplate`).
- [x] tsc/lint по `models/account.ts`, `routes/sendTransactionNewsletter.ts` —
      убедиться, что убранный дубль не оставил неиспользуемых импортов/типов.
- [x] Юнит-тест на группировку `user_id:account_id` и на то, что
      `mailboxList`/`staffList` грузятся один раз на батч, а не на группу
      (мок на `loadMailboxList`/`staff_getter`, счётчик вызовов).
- [x] Юнит-тест на частичный отказ: одна транзакция в группе не рендерится
      (`buildTransactionPdf` throw) — письмо с остальными вложениями всё равно
      уходит, упавшая помечается `failed`, а не вся группа.

## Явно вне скоупа этого документа

Ретраи, персистентность, идемпотентность повторной постановки в очередь и recovery-
проход — открытые архитектурные вопросы, зафиксированные в
`doctemplate_service/docs/newsletter-retry-open-questions.md` и
`newsletter-retry-questions-by-significance.md`. Решения по ним не приняты, отдельный
план появится после того, как будут закрыты вопросы уровня 1 (scope, критерий
"окончательного отказа", нужен ли алерт).

## Верификация

1. Ручной прогон var2 (несколько транзакций одного user_id:account_id и несколько
   разных пар) — письмо уходит одно на пару, вложения соответствуют выбранным
   транзакциям.
2. Залогировать число вызовов `loadMailboxList`/`staff_getter` при батче из
   N групп — должно быть константным (1 на весь батч), а не N.
3. Смоделировать сбой рендера одной транзакции из группы — письмо всё равно уходит с
   оставшимися вложениями, `failed_count` учитывает только упавшую транзакцию.
