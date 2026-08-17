# План реализации: рефакторинг рассылки транзакций (var2)

## Цель

Перенести бизнес-логику авто-рассылки транзакций (var2) из IO-слоя и фронтового
оркестратора в модели, сделав её переиспользуемой. Фронт перестаёт дублировать
бэкенд: вместо ~4N+1 вызовов — генерация docx на пачку + один HTTP-вызов.

## Принятые решения

1. **Генерация документа** — generic-метод в `models/doctemplate.ts`, оркестрация в
   `models/account.ts`.
2. **Фронтовый var2** — гибрид: генерация docx на фронте (по той же схеме и с тем же
   кэшированием, что `generateTransactionPDF` / `processReconciliation`); docx уходит
   на бэк, где конвертируется в pdf, формируется и отправляется письмо. Аттач/отправка
   полностью на бэке.
3. **Транспорт** — один **HTTP** POST с multipart-набором docx (не сокет: в сокет может
   не влезть столько файлов). Файлы — base64 в JSON-теле, как в `doctemplate_service`.
4. **Объём итерации** — только var2 (авто-отправка `sendTransactionNewsletterManual`).
   v1 (черновик с вложением, `createDraftWithAttachments`) не трогаем.
5. **Доступ** — отдельное право `sendTransactionNewsletter` не проверяем. Достаточно:
   lc транзакций (накладывается в `loadTransactionList`) + права на отправку письма
   (проверяются в `Email.createDraft`/`sendDraft`).

## Пайплайн var2

```
1. FE  → данные для генерации (template из кэша + parties из кэша + data на транзакцию)
2. FE  → generateDocx(template, params) на фронте → docx
3. FE  → ОДИН HTTP POST /transaction-newsletter (JSON, docx в base64)
         { transaction_ids, document_type, files: [{ transaction_id, fileName, content }] }
4. BE  → docx → pdf → формирование письма → отправка → { sent, failed, skipped }
5. FE  → один тост по агрегированному результату
```

## Целевая архитектура (слои)

```
Frontend (var2)
  sendTransactionNewsletterManual:
    1. валидации (лимит 30, наличие main mailbox, права ящика createDraft/attachment/sendDraft)
    2. for id of ids: generateTransactionDocx(id, techtype)   // кэш: 1×шаблон + 1×стороны на пачку
    3. thunk sendTransactionNewsletterHTTP → POST /transaction-newsletter (base64 docx)
    4. тост из { sent_count, failed_count, skipped_count }

routes/sendTransactionNewsletter.ts (HTTP, var2)
  POST /transaction-newsletter
    auth: req.session.user.id; body: express.json({ limit: '40mb' })
    декодирует base64 → Buffer, без newsletter-accessCheck
    → new Account(req.session.user).sendTransactionNewsletterBatch(ids, { documentType, docxFiles })
    → res.json({ status: 'OK', data: { sent_count, failed_count, skipped_count } })

io/models/account.ts (тонкий, auto-путь)
  a.executeTransactionTemplate (accessCheck('createTransaction') остаётся)
    → account.sendTransactionNewsletterBatch(ids)             // только t_has_newsletter=1

models/
  account.sendTransactionNewsletterBatch(ids, opts)
    ├─ грузит транзакции через loadTransactionList (lc → недоступные отсеиваются)
    ├─ from = getMainMailboxAddress(Email)
    ├─ to   = getRecipientsFromStaff
    ├─ pdf  = opts.docxFiles[id] ? this.convertToPDF(docx)      (var2)
    │                            : this.buildTransactionPdf(...)  (auto)
    └─ account.sendTransactionNewsletter(tr, { from, to, pdf })
         └─ Email: createDraft → createAttachmentToken → uploadDraftAttachment → sendDraft
                   (+ fail-safe удаление черновика при ошибке)

  account.buildTransactionPdf(tr, type)                          (только auto)
    └─ new Doctemplate(this.__user).renderDocumentToPdf(doc, controlDate, extra)

  doctemplate.renderDocumentToPdf(document, controlDate?, extra?) (generic)
    parseSources → getData → renderDocxByDoctemplateService → convertToPDF
```

Оба пути (var2 через HTTP-route и auto через io) сходятся в
`account.sendTransactionNewsletterBatch` → `account.sendTransactionNewsletter`; различие —
источник PDF. Ни HTTP-route, ни io ничего не конвертируют и не формируют — вся логика
в моделях.

## Изменения по файлам

### 1. `models/email.ts`
- Новый метод `uploadDraftAttachment({ mailId, username, tokenUuid, fileName, content })`.
  Переносим FormData + `mailAxios.post('/mail/draft/attachment')` из io-хелпера
  (`io/models/account.ts:91-111`). Это единственный прямой вызов `mailAxios` из io-хелпера;
  его место рядом с `createAttachmentToken` / `sendDraft`.

### 2. `models/doctemplate.ts`
- Новый generic `renderDocumentToPdf(document, controlDate?, extraData?)`:
  `parseSources(document.sources)` → `this.getData(sources, controlDate)` →
  сборка `NEW`/`_`/`qr` из `extraData` → `renderDocxByDoctemplateService(template, ...)`
  → `this.convertToPDF(docx)`. Возвращает `{ pdfBuffer, fileName }`. Не знает про
  транзакции. `parseSources` переносим сюда из io.

### 3. `models/account.ts`
- `private resolveMainTransactionDocument(transaction, documentType)` — выбор main-документа
  (логика из текущего `buildTransactionNewsletterPdf`, io:121-142).
- `buildTransactionPdf(transaction, documentType?)` — резолвит документ + docparameters + QR,
  собирает `docParams`, вызывает `new Doctemplate(this.__user).renderDocumentToPdf(...)`.
- `getMainMailboxAddress(userId)` — через `new Email(this.__user).loadMailboxList(...)`.
- `getRecipientsFromStaff(staffList)` + `emailRegexp` — резолв получателей на бэке.
- `sendTransactionNewsletter(transaction, { from, to, pdfBuffer, fileName, documentType? })`:
  Email createDraft → createAttachmentToken → uploadDraftAttachment → sendDraft;
  fail-safe удаление черновика при ошибке после его создания; → `'sent'|'failed'|'skipped'`.
- `sendTransactionNewsletterBatch(transactionIds, { documentType?, docxFiles? })`:
  грузит транзакции (lc), резолвит from/to; на каждую — `docxFiles[id]` → `convertToPDF`
  (var2), иначе `buildTransactionPdf` (auto); агрегирует
  `{ sent_count, failed_count, skipped_count }` (+ notLoaded → skipped).
  `docxFiles` — `Record<transaction_id, { fileName: string, content: Buffer }>`.

### 4. `routes/sendTransactionNewsletter.ts` (новый HTTP-роут)
- Экспорт `post: RequestHandler` по образцу `routes/bufferToPDF.ts`:
  - `if (!req.session?.user?.id) return next(401)`;
  - читает `{ transaction_ids, document_type, files }` из `req.body`;
  - валидация: `transaction_ids` непустой, лимит 30, суммарный размер; маппинг
    `files[] → docxFiles` с `Buffer.from(content, 'base64')`;
  - `new Account(req.session.user).sendTransactionNewsletterBatch(ids, { documentType, docxFiles })`;
  - `res.json({ status: 'OK', data: result })`; ошибки → `next(moduleInstance.errorHandler(...))`.
- Регистрация в `routes/index.ts`:
  `app.post('/transaction-newsletter', express.json({ limit: '40mb' }), sendTransactionNewsletterPost)`
  (локальный лимит тела, как `express.json({ limit: '40mb' })` в `doctemplate_service`).

### 5. `io/models/account.ts` (тонкий слой)
- Удаляем хелперы (≈стр. 62-278): `parseSources`, `getRecipientsFromStaff`,
  `getMainMailboxAddress`, `uploadDraftAttachment`, `buildTransactionNewsletterPdf`,
  `sendTransactionNewsletter`, `sendTransactionNewsletterBatch`.
- Удаляем сокет-хендлер `a.sendTransactionNewsletterBatch` (ручной var2 теперь HTTP;
  авто-путь вызывает модель напрямую). Сокет-эндпоинт `a.sendTransactionNewsletterPrepared`
  **не создаём** — заменён HTTP-роутом.
- `a.executeTransactionTemplate` — без изменений по доступу
  (`accessCheck('createTransaction')` остаётся), вызывает модельный
  `account.sendTransactionNewsletterBatch` (стр. 1062-1074).

### 6. `public/js/controllers/account.ts`
- Новый thunk `sendTransactionNewsletterHTTP` по образцу `convertBufferToPDFHTTP` (стр. 573):
  `fetch('/transaction-newsletter', { method: 'POST', headers: { 'Content-Type':
  'application/json' }, body: JSON.stringify({ transaction_ids, document_type, files }) })`,
  где `files[].content` — docx в base64. Возвращает `{ sent_count, failed_count, skipped_count }`.

### 7. `public/js/components/transactions-table/index.tsx`
- Новый `generateTransactionDocx(transactionId, techtype)` — копия `generateTransactionPDF`
  до `generateDocx`, **без** `convertBufferToPDFHTTP`. Возвращает
  `{ fileName: 'Счёт N от dd.mm.yy.docx', docx: report.data }`. Использует те же
  `fetchTemplateIfNeeded` + `fetchPartiesIfNeeded` (кэш) и ту же сборку `params`.
- Рефактор `generateTransactionPDF` → вызывает `generateTransactionDocx` + `convertBufferToPDFHTTP`
  (устранение дублирования схемы; поведение download-пути не меняется).
- `sendTransactionNewsletterManual`:
  - оставляем валидации (лимит 30, наличие main mailbox, права ящика);
  - **убираем** `transactionNewsletterPermissions` / проверку `sendTransactionNewsletter`;
  - **убираем** `loadNewsletterRecipients` и цикл createDraft/token/upload/send/deleteMail;
  - `for id of ids: generateTransactionDocx(id, techtype)` — шаблон/стороны из кэша
    (1× на пачку), `loadTransactionForDocumentGenerator` — N× (как в существующих путях);
  - кодируем docx в base64, один вызов `dispatch(sendTransactionNewsletterHTTP(...))`;
  - тост из ответа `{ sent_count, failed_count, skipped_count }`.

## Контракт HTTP-эндпоинта

```
POST /transaction-newsletter
Content-Type: application/json            // express.json({ limit: '40mb' })
Cookie: <session>                          // auth: req.session.user.id

body:
{
  transaction_ids: number[],              // лимит 30, проверяется на бэке
  document_type?: string,
  files: Array<{
    transaction_id: number,
    fileName: string,                      // имя .docx
    content: string                        // docx в base64
  }>
}

200 OK:
{ status: 'OK', data: { sent_count: number, failed_count: number, skipped_count: number } }

401 — нет сессии; 400 — пустой transaction_ids / превышен лимит / битый payload.
```

## Модель доступа

- **lc транзакций** — `loadTransactionList` накладывает `accessCheck_updateLC('transaction')`
  (`models/account.ts:251`); недоступные id не загружаются → `skipped_count`.
- **Права на отправку письма** — проверяются в пути отправки (`Email.createDraft`/`sendDraft`
  по выбранному ящику). Отдельной проверки не добавляем.
- Отдельное право `sendTransactionNewsletter` на бэке/фронте не используем. Если оно
  больше нигде не задействовано — кандидат на удаление из permission-схемы (отдельно,
  с подтверждением).

## Порядок реализации

1. `models/email.ts` — `uploadDraftAttachment`.
2. `models/doctemplate.ts` — `renderDocumentToPdf` + `parseSources`.
3. `models/account.ts` — `resolveMainTransactionDocument`, `buildTransactionPdf`,
   `getMainMailboxAddress`, `getRecipientsFromStaff`, `sendTransactionNewsletter`,
   `sendTransactionNewsletterBatch`.
4. `routes/sendTransactionNewsletter.ts` + регистрация в `routes/index.ts`.
5. `io/models/account.ts` — удалить хелперы и сокет-хендлеры рассылки;
   `a.executeTransactionTemplate` → модельный батч.
6. `public/js/controllers/account.ts` — thunk `sendTransactionNewsletterHTTP`.
7. `public/js/components/transactions-table/index.tsx` — `generateTransactionDocx`,
   рефактор `generateTransactionPDF`, переписать `sendTransactionNewsletterManual`.

## Замечания / риски

1. Транспорт — HTTP, файлы base64 в JSON-теле (как `doctemplate_service`); локальный
   лимит `express.json({ limit: '40mb' })` на роуте. base64 раздувает payload ~на 33%,
   docx-счета мелкие — при лимите 30 укладывается.
2. Бэк — источник истины по доступу (lc + права почты); фронтовые проверки остаются как
   UX-гейт.
3. Получатели резолвятся на бэке — фронт больше не грузит staff для рассылки.
4. Идемпотентность — флаг `isSendingTransactionNewsletter` на фронте (уже есть);
   серверной дедупликации в этой итерации нет (пункт v3).
5. `t_has_newsletter` для авто-пути (`executeTransactionTemplate`) — без изменений.
6. Если в будущем потребуется потоковая загрузка больших файлов — заменить base64-JSON на
   multipart (потребует `multer`/`busboy`, сейчас в зависимостях нет).
