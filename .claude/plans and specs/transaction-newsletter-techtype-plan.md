# Явный techtype для авто-рассылки шаблонов транзакций

## Контекст

Ветка prokhorenko_transactions_newsletter уже содержит рабочий end-to-end
пайплайн v2 из transaction-newsletter-plan.md: авто-рассылка через
executeTransactionTemplate (флаг t_has_newsletter) и ручная мгновенная
отправка var2 из контекстного меню транзакций. doctemplate_service,
HTTP-роут /transaction-newsletter, io-слой - все соответствует плану по
факту, отдельно это трогать не нужно.

В процессе разбора нашлась реальная проблема: buildTransactionPdf
(models/account.ts:306) выбирает документ (Счет/Акт) по полю
transaction.type, но a_transaction.type - мертвое поле: его нигде не
устанавливает ни одна UI-форма (ни создание транзакции, ни создание
шаблона, ни transaction-template-route), колонка type объявлена в
useTransactionTemplateCard.ts как валидный TemplateField, но не привязана
ни к одному контролу. На практике это означает, что авто-рассылка всегда
шлет "Счет" (дефолт : 1 в buildTransactionPdf), независимо от того, какой
документ реально нужен по шаблону.

Решение: перестать использовать transaction.type для выбора документа и
завести отдельную явную колонку techtype, которую нужно будет осознанно
выбрать в карточке шаблона - так же, как уже выбирается docpack_id и
переключается t_has_newsletter.

## Изменения

### 1. Миграция sql_source/migration/scripts/145_transaction_techtype.sql (новый файл)

По образцу 139_transaction_newsletter.sql:
```sql
ALTER TABLE `project87`.`a_transaction` ADD COLUMN `techtype` TINYINT UNSIGNED DEFAULT NULL AFTER `t_has_newsletter`;

DELETE FROM `sys_action` WHERE `module` = 'account' AND `action_name` = 'techtype@transaction';
INSERT INTO `sys_action` (`module`, `action_name`, `element`, `service`) VALUES ('account', 'techtype@transaction', 'transaction', '1');
INSERT INTO `sys_access_action` (`action_id`, `access`, `access_check`, `value_check`) VALUES
(last_insert_id(), 1, 0, 0),
(last_insert_id(), 2, 0, 0),
(last_insert_id(), 3, 1, '1');
```
Права techtype@transaction обязательны - без них paramChange из фронта будет
отбит accessCheck, ровно как это устроено для t_has_newsletter@transaction.

a_transaction.type (варчар) не трогаем/не дропаем - он остается в схеме
неиспользуемым, отдельная задача на очистку не входит в этот скоуп.

### 2. types/db.ts
Добавить techtype: number | null; в IATransactionRow (после type, рядом
с t_has_newsletter).

### 3. serverStartup/queries/account.ts
Добавить knex.ref('techtype').withSchema('t') в двух местах - в CTE transaction
(рядом со строкой с t_has_newsletter, ~line 557) и в финальном select
transaction_getter (~line 610). AccountTransactionGetterType подтянет новое
поле автоматически (тип выводится из knex-запроса).

### 4. models/account.ts
- buildTransactionPdf (строка 306): заменить
  `const techtype = Number(transaction.type) > 0 ? Number(transaction.type) : 1;`
  на `const techtype = Number(transaction.techtype) > 0 ? Number(transaction.techtype) : 1;`.
- executeTransactionTemplate - без изменений: копирование колонок шаблона в
  транзакцию идет динамически по Object.keys(global.DB.tables.a_transaction)
  (строка ~1440), techtype не входит в список исключений и не начинается на
  r_/t_, так что унаследуется автоматически, как и docpack_id.
- Заодно убрать мертвый documentType/opts.documentType - параметр объявлен
  в сигнатурах sendTransactionNewsletterBatch (строка 476) и
  sendTransactionNewsletterGroup (строка 353) и парсится в
  routes/sendTransactionNewsletter.ts:53, но не читается ни в одном теле
  функции и не отправляется ни одним вызывающим кодом на фронте. С появлением
  явного techtype на транзакции он окончательно не нужен ни для одного из
  путей (auto берет transaction.techtype, var2 уже шлет готовый docx).
  Удаляю параметр из всех трех мест.

### 5. public/js/modules/account/routes/transaction-template-route/useTransactionTemplateCard.ts
Добавить 'techtype' в union TemplateField (строка 36-52). changeField
уже универсален (paramChange({ actionName: '${field}@transaction', ... })),
доп. логики не требует. Поле 'type' в union не трогаю (уже мертвое, отдельно
не убираю - не в скоупе).

### 6. public/js/modules/account/routes/transaction-template-route/index.tsx
Рядом с блоком "Авто-рассылка" (строки 316-330) добавить пикер типа документа:
```tsx
<div className={cn(styles.label, styles.labelWithIcon)}>
  <span>Тип документа:</span>
</div>
<SingleSelectUpdated
  value={template.techtype != null ? String(template.techtype) : ''}
  options={[
    { value: '1', label: techtypeList?.[1]?.name || 'Счет' },
    { value: '2', label: techtypeList?.[2]?.name || 'Акт' },
  ]}
  placeholder="Не выбран"
  disabled={disabled}
  off={new Set([ESingleSelectElements.CUSTOM_VALUES])}
  onChangeValue={(val) => {
    changeField('techtype', val ? Number(val) : null);
    return true;
  }}
/>
```
- Импортировать SingleSelectUpdated, ESingleSelectElements из
  @pjs/components/select/single-select (уже используется в DateRuleRow) и
  useTechtypeList из @pjs/hooks/user (как в transactions-table/index.tsx:14-15).
- Ограничиваю список до 1 (Счет) / 2 (Акт) - "Акт Сверки" (3) не относится к
  единичному шаблону транзакции, это отдельный массовый отчет
  (processReconciliation), сюда не подходит.
- Пикер не гейтим строго за t_has_newsletter - виден всегда в карточке
  шаблона, как docpack_id, но по факту влияет только на авто-рассылку.

## Верификация

1. Прогнать миграцию 145_transaction_techtype.sql на dev БД, убедиться что
   колонка и permission-строки создались (sys_action/sys_access_action).
2. В UI карточки шаблона (transaction-template-route) выбрать "Акт" в новом
   пикере, включить "Авто-рассылка", вручную нажать "Создать транзакцию" -
   убедиться, что письмо действительно приходит с PDF "Акт", а не "Счет"
   (сверить имя вложения/лог newsletter batch в консоли сервера).
3. Проверить, что с techtype не выбран (null) поведение не ломается -
   buildTransactionPdf уйдет в дефолт techtype=1 ("Счет"), как и раньше.
4. tsc/линт по измененным файлам (types/db.ts, serverStartup/queries/account.ts,
   models/account.ts, useTransactionTemplateCard.ts, index.tsx) - убедиться,
   что удаление documentType не оставило неиспользуемых импортов/типов в
   routes/sendTransactionNewsletter.ts и public/js/controllers/account.ts.
