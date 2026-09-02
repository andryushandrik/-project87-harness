/**
 * Seeds a_transaction with a predictable newsletter outbox and verifies the counters.
 *
 * Every outcome is forced by data alone, never by taking a service down: the batch
 * sender groups by `user_id:account_id` (models/account.ts:611), so each bucket gets
 * its own account and the outcomes cannot bleed into each other.
 *
 * Usage (from the project root, dev services up):
 *   npm run test:newsletter              full cycle: clean, seed, run, report
 *   npm run test:newsletter -- clean     remove previous test data only
 *   npm run test:newsletter -- report    re-check counters against expectations
 *   npm run test:newsletter -- bulk      add planned templates spread over days
 *   npm run test:newsletter -- v3        seed the manual mass-send screen, send nothing
 *
 * `bulk` runs no pipeline and sends nothing: it only fills the outbox table with rows
 * to look at, and it shifts the counters the `report` expectations pin down.
 */
import serverStartup from '../../serverStartup';
import Account from '../../models/account';
import Email from '../../models/email';
import createRegularTransactions from '../../serverTasks/createTransactions';
import { UserModule } from '../../models/module';
import { knex, knex2 } from '../../libs/mysqlDB';
import { NEWSLETTER_RETRY_LIMIT, NEWSLETTER_STATUS } from '../../libs/newsletter';
import { buildNewsletterCountUrls, NEWSLETTER_COUNTERS } from './counters';
import { dateFormat } from '../../libs/date';
import su from '../../serverTasks/serverUser.json';

const MARK = '[NL-TEST]';

const NO_SENDER_LOGIN = 'nl-test-nosender';

/** techtype with neither an account file nor a system template, so buildPdf always fails */
const TECHTYPE_MISSING_TEMPLATE = 99;

const STAFF_VISIBLE = { status: 40, is_official_email: 1 };

const today = () => dateFormat('yyyy-mm-dd') as string;

const inDays = (days: number) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return dateFormat(date, 'yyyy-mm-dd') as string;
};

const BULK_PLAN: Array<{ days: number, count: number }> = [
  { days: 0, count: 12 },
  { days: 2, count: 7 },
  { days: 3, count: 8 },
  { days: 4, count: 9 },
];

const say = (message: string) => process.stdout.write(`${message}\n`);

interface ISeedAccount {
  key: string;
  name: string;
  techtype: number;
}

const ACCOUNTS: ISeedAccount[] = [
  { key: 'sent', name: `${MARK} отправлено`, techtype: 1 },
  { key: 'noRecipients', name: `${MARK} нет получателей`, techtype: 1 },
  { key: 'docFail', name: `${MARK} документ не собрался`, techtype: TECHTYPE_MISSING_TEMPLATE },
  { key: 'noSender', name: `${MARK} нет отправителя`, techtype: 1 },
];

/**
 * ! The nightly run detaches sending: executeTransactionTemplate resolves as soon as
 * the batch is fired (models/account.ts:1685-1696). Polling the rows is the only way
 * to know the run is actually over.
 */
const waitForQuiet = async (accountIds: number[], timeoutMs = 300_000): Promise<void> => {
  const started = Date.now();
  let previous = '';
  let stableCount = 0;

  while (Date.now() - started < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await knex
      .select('id', 'newsletter_status', 'newsletter_retry_count')
      .from('a_transaction')
      .whereIn('account_id', accountIds)
      .orderBy('id');

    const snapshot = JSON.stringify(rows);
    const queued = rows.filter((row) => Number(row.newsletter_status) === NEWSLETTER_STATUS.QUEUED);

    if (snapshot === previous && !queued.length) stableCount += 1;
    else stableCount = 0;
    previous = snapshot;

    if (stableCount >= 3) return;

    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => { setTimeout(resolve, 2000); });
  }

  throw new Error(`Newsletter run did not settle in ${timeoutMs}ms`);
};

/**
 * Owns the 412 bucket. The mail service never hears about this user, so it can
 * never grow a main mailbox and the bucket cannot silently turn into a 200.
 */
const ensureNoSenderUser = async (): Promise<number> => {
  const [existing]: Array<{ id: number }> = await knex
    .select('id')
    .from('u_user')
    .where('name', NO_SENDER_LOGIN);
  if (existing) return Number(existing.id);

  const [id] = await knex2('u_user').insert({
    name: NO_SENDER_LOGIN,
    sname: 'Тестов',
    fname: 'Безъящика',
    timestamp: dateFormat('mysql-timestamp') as string,
    user_created: 0,
  });
  say(`user: создан ${NO_SENDER_LOGIN} (${id}) — владелец без основного ящика`);
  return Number(id);
};

const resolveUsers = async (account: Account): Promise<{ sender: number, noSender: number, from: string }> => {
  const email = new Email(account.__user);
  const mailboxes = await email.loadMailboxList({ is_main: true, ignore_page: true });
  if (!mailboxes.length) {
    throw new Error('No main mailbox found in the mail service — bucket 200 is impossible');
  }

  return {
    sender: Number(mailboxes[0].user_id),
    noSender: await ensureNoSenderUser(),
    from: mailboxes[0].username,
  };
};

const clean = async (): Promise<number[]> => {
  const accounts: Array<{ id: number }> = await knex
    .select('id')
    .from('a_account')
    .where('name', 'like', `${MARK}%`);
  const ids = accounts.map((row) => Number(row.id));
  if (!ids.length) {
    await knex2('u_user').where('name', NO_SENDER_LOGIN).del();
    return [];
  }

  const transactions: Array<{ id: number }> = await knex
    .select('id')
    .from('a_transaction')
    .whereIn('account_id', ids);
  const transactionIds = transactions.map((row) => Number(row.id));

  if (transactionIds.length) {
    await knex2('a_transaction_record').whereIn('transaction_id', transactionIds).del();
    await knex2('a_transaction').whereIn('id', transactionIds).del();
  }
  await knex2('a_staff').whereIn('account_id', ids).del();
  await knex2('a_parameter').whereIn('account_id', ids).del();
  await knex2('a_accessmap').where('element', 'account').whereIn('element_id', ids).del();
  await knex2('a_account').whereIn('id', ids).del();
  await knex2('u_user').where('name', NO_SENDER_LOGIN).del();

  say(`clean: removed ${ids.length} accounts, ${transactionIds.length} transactions`);
  return ids;
};

const seedAccounts = async (
  account: Account,
  users: { sender: number, noSender: number, from: string },
): Promise<Record<string, number>> => {
  const recipient = process.env.NL_TEST_RECIPIENT || users.from;

  const created = await account.createAccount(...ACCOUNTS.map((spec) => ({
    user_id: spec.key === 'noSender' ? users.noSender : users.sender,
    name: spec.name,
    type: 'client',
    status: 40,
    _staff: [{
      account_id: 0,
      sname: 'Тестов',
      fname: 'Тест',
      occupation: 'Получатель рассылки',
      email: recipient,
      // The 422 bucket: the staff getter filters on these two, so the row exists
      // but never reaches the sender, which is exactly the production symptom.
      ...(spec.key === 'noRecipients' ? { status: 40, is_official_email: 0 } : STAFF_VISIBLE),
    }],
  })));

  const byKey: Record<string, number> = {};
  ACCOUNTS.forEach((spec, index) => { byKey[spec.key] = Number(created[index].id); });

  await knex2('a_accessmap').insert(ACCOUNTS.map((spec) => ({
    uuid: knex.raw('UUID_TO_BIN(UUID())'),
    element: 'account',
    element_id: byKey[spec.key],
    user_id: users.sender,
    level: 0,
    timestamp: dateFormat('mysql-timestamp') as string,
    user_created: users.sender,
  })));

  say(`seed: ${ACCOUNTS.length} accounts, recipient ${recipient}`);
  return byKey;
};

const seedTemplates = async (
  account: Account,
  accountIds: Record<string, number>,
): Promise<Record<string, number>> => {
  const created = await account.createTransaction(...ACCOUNTS.map((spec) => ({
    account_id: accountIds[spec.key],
    is_template: 1,
    t_has_newsletter: 1,
    techtype: spec.techtype,
    name: spec.name.slice(0, 45),
    type: 'sale',
    is_debit: 0,
    date: today(),
    r_status: 1,
    r_start: today(),
    _records: [{
      transaction_id: 0, name: 'Тестовая позиция', amount: 1, price: 1000,
    }],
  })));

  const byKey: Record<string, number> = {};
  ACCOUNTS.forEach((spec, index) => { byKey[spec.key] = Number(created[index].id); });
  return byKey;
};

const setTemplateState = async (
  templateIds: number[],
  state: { r_status: number, r_start?: string | null },
): Promise<void> => {
  if (!templateIds.length) return;
  await knex2('a_transaction').whereIn('id', templateIds).update({
    r_status: state.r_status,
    ...(state.r_start === undefined ? {} : { r_start: state.r_start }),
  });
};

const bulkAccount = async (account: Account): Promise<number> => {
  const email = new Email(account.__user);
  const [mailbox] = await email.loadMailboxList({ is_main: true, ignore_page: true });
  if (!mailbox) {
    throw new Error('Нет основного ящика — некому владеть тестовым аккаунтом');
  }

  const owner = Number(mailbox.user_id);
  const [created] = await account.createAccount({
    user_id: owner,
    name: `${MARK} план`,
    type: 'client',
    status: 40,
  });

  await knex2('a_accessmap').insert({
    uuid: knex.raw('UUID_TO_BIN(UUID())'),
    element: 'account',
    element_id: Number(created.id),
    user_id: owner,
    level: 0,
    timestamp: dateFormat('mysql-timestamp') as string,
    user_created: owner,
  });

  return Number(created.id);
};

const seedBulk = async (account: Account): Promise<void> => {
  const existing: Array<{ id: number }> = await knex
    .select('id')
    .from('a_account')
    .where('name', 'like', `${MARK}%`)
    .orderBy('id');

  const accountIds = existing.length
    ? existing.map((row) => Number(row.id))
    : [await bulkAccount(account)];

  const specs = BULK_PLAN.flatMap(({ days, count }) => {
    const date = inDays(days);
    return Array.from({ length: count }, (unused, index) => ({
      account_id: accountIds[index % accountIds.length],
      is_template: 1,
      t_has_newsletter: 1,
      techtype: 1,
      name: `${MARK} план ${date} #${index + 1}`.slice(0, 45),
      type: 'sale',
      is_debit: 0,
      date,
      r_status: 1,
      r_start: date,
      _records: [{
        transaction_id: 0, name: 'Тестовая позиция', amount: 1, price: 1000,
      }],
    }));
  });

  await account.createTransaction(...specs);
  BULK_PLAN.forEach(({ days, count }) => say(`bulk: ${count} шаблонов на ${inDays(days)}`));
};

/**
 * Data for the manual mass-send screen ("Рассылка документов"). Nothing is sent
 * here: the accounts only set up the outcomes a tester triggers from the UI — one big
 * enough to split into two batches of 30, one to mix two accounts in a selection, one
 * whose staff is invisible to the recipient filter so every letter is skipped.
 *
 * ! There is deliberately no "owner without a mailbox" account here, unlike the
 * automatic run above: the transaction getter narrows to `user_id = <reader>`, so an
 * account owned by anyone else is invisible on the screen no matter what the accessmap
 * says. That bucket is only reachable through the nightly pipeline.
 */
const V3_ACCOUNTS: Array<{ key: string, name: string, count: number }> = [
  { key: 'v3bulk', name: `${MARK} v3 массовая (35)`, count: 35 },
  { key: 'v3second', name: `${MARK} v3 второй аккаунт (5)`, count: 5 },
  { key: 'v3NoRecipients', name: `${MARK} v3 без получателей (3)`, count: 3 },
];

const seedV3 = async (account: Account): Promise<void> => {
  const users = await resolveUsers(account);
  const recipient = process.env.NL_TEST_RECIPIENT || users.from;
  say(`users: отправитель ${users.sender} (${users.from})`);

  const created = await account.createAccount(...V3_ACCOUNTS.map((spec) => ({
    user_id: users.sender,
    name: spec.name,
    type: 'client',
    status: 40,
    _staff: [{
      account_id: 0,
      sname: 'Тестов',
      fname: 'Тест',
      occupation: 'Получатель рассылки',
      email: recipient,
      ...(spec.key === 'v3NoRecipients' ? { status: 40, is_official_email: 0 } : STAFF_VISIBLE),
    }],
  })));

  await knex2('a_accessmap').insert(created.map((row) => ({
    uuid: knex.raw('UUID_TO_BIN(UUID())'),
    element: 'account',
    element_id: Number(row.id),
    user_id: users.sender,
    level: 0,
    timestamp: dateFormat('mysql-timestamp') as string,
    user_created: users.sender,
  })));

  const specs = V3_ACCOUNTS.flatMap((spec, index) => Array.from(
    { length: spec.count },
    (unused, number) => ({
      account_id: Number(created[index].id),
      techtype: 1,
      name: `${MARK} ${spec.key} #${number + 1}`.slice(0, 45),
      type: 'sale',
      is_debit: 0,
      date: today(),
      _records: [{
        transaction_id: 0, name: 'Тестовая позиция', amount: number + 1, price: 1000,
      }],
    }),
  ));

  await account.createTransaction(...specs);
  V3_ACCOUNTS.forEach((spec) => say(`v3: ${spec.count} транзакций — ${spec.name}`));
  say(`v3: получатель ${recipient}`);
};

const runPipeline = async (accountIds: number[], label: string): Promise<void> => {
  say(`run: ${label}`);
  await createRegularTransactions();
  await waitForQuiet(accountIds);
};

/**
 * ! The error counters are one short of the four failed rows on purpose: the
 * transaction load check is `user_id = <reader>`, so the 412 account — owned by the
 * user without a mailbox, or the bucket would not exist — never enters the reader's
 * counters. Its row is asserted directly instead.
 */
const EXPECTED: Record<number, number> = {
  101: 1,
  102: 1,
  103: 1,
  104: 3,
  105: 3,
  106: 2,
};

/**
 * ! WARNING: counts have to be read as the owner of the test accounts. The server user
 * is id 0, and the load check narrows every getter to `user_id = 0`, so it reports
 * zeros no matter what is in the table. The lowest id is the sender's account, and
 * only the sender is in the accessmap — reading as the 412 owner also returns zeros.
 */
const reportAs = async (): Promise<Account> => {
  const [owner]: Array<{ user_id: number }> = await knex
    .select('user_id')
    .from('a_account')
    .where('name', 'like', `${MARK}%`)
    .orderBy('id')
    .limit(1);

  return new Account({ ...(su as UserModule), id: Number(owner?.user_id ?? 0) });
};

const report = async (): Promise<boolean> => {
  const account = await reportAs();
  const accounts: Array<{ id: number }> = await knex
    .select('id')
    .from('a_account')
    .where('name', 'like', `${MARK}%`);

  /**
   * ! Scoping to the test accounts is what makes the expectations absolute. Without
   * it the counters also see live data — including the rows this very run creates
   * from the production templates, since the nightly task takes every template there
   * is — so no baseline taken before the run survives it.
   */
  const counts = await account.loadCount(
    buildNewsletterCountUrls(today()),
    'transaction',
    { account_id: accounts.map((row) => Number(row.id)) },
  );

  const rows: Array<{
    newsletter_status: number | null,
    newsletter_retry_count: number | null,
    name: string,
  }> = await knex
    .select('t.newsletter_status', 't.newsletter_retry_count', 'a.name')
    .from('a_transaction as t')
    .join('a_account as a', 'a.id', 't.account_id')
    .where('a.name', 'like', `${MARK}%`)
    .whereNull('t.is_template')
    .orderBy('t.id');

  say('\nСтроки аутбокса:');
  rows.forEach((row) => say(
    `  ${String(row.newsletter_status ?? 'NULL').padEnd(6)}`
    + ` попыток=${String(row.newsletter_retry_count ?? 0).padEnd(3)} ${row.name}`,
  ));

  const hasNoSenderRow = rows.some(
    (row) => Number(row.newsletter_status) === NEWSLETTER_STATUS.NO_SENDER,
  );
  let ok = hasNoSenderRow;
  say(`\n  ${hasNoSenderRow ? 'OK  ' : 'FAIL'} строка 412 в аутбоксе`);

  say('\nСчётчики вкладки:');
  NEWSLETTER_COUNTERS.forEach((counter) => {
    const expected = EXPECTED[counter.id];
    const actual = Number(counts[counter.id] ?? 0);
    const pass = actual === expected;
    if (!pass) ok = false;
    say(`  ${pass ? 'OK  ' : 'FAIL'} ${counter.name.padEnd(16)} ожидалось ${expected}, получено ${actual}`);
  });

  return ok;
};

const seed = async (account: Account): Promise<void> => {
  const users = await resolveUsers(account);
  say(`users: отправитель ${users.sender} (${users.from}), без ящика ${users.noSender}`);

  const accountIds = await seedAccounts(account, users);
  const templateIds = await seedTemplates(account, accountIds);
  const allAccounts = Object.values(accountIds);
  const allTemplates = Object.values(templateIds);

  await runPipeline(allAccounts, 'фаза 1 — все шаблоны активны');

  // Templates off: the retry query is the only thing left running, so 503 rows climb
  // toward the limit while nothing new is created.
  await setTemplateState(allTemplates, { r_status: 0 });
  for (let i = 2; i <= NEWSLETTER_RETRY_LIMIT; i++) {
    // eslint-disable-next-line no-await-in-loop
    await runPipeline(allAccounts, `фаза 2 — повтор ${i}/${NEWSLETTER_RETRY_LIMIT}`);
  }

  // A fresh 503 that still has retries left, so "будет повтор" and "повторов больше
  // не будет" are populated at the same time.
  await setTemplateState([templateIds.docFail], { r_status: 1, r_start: today() });
  await runPipeline(allAccounts, 'фаза 3 — свежий сбой сборки документа');

  // A row the sender never reached: same state the pipeline leaves behind when the
  // process dies mid-send (newsletter-status-design.md, check 10).
  await account.createTransaction({
    account_id: accountIds.sent,
    name: `${MARK} в очереди`.slice(0, 45),
    type: 'sale',
    is_debit: 0,
    date: today(),
    newsletter_status: NEWSLETTER_STATUS.QUEUED,
    _records: [{
      transaction_id: 0, name: 'Тестовая позиция', amount: 1, price: 1000,
    }],
  });

  await setTemplateState(allTemplates, { r_status: 0 });
  await setTemplateState([templateIds.sent], { r_status: 1, r_start: today() });
};

const main = async (): Promise<void> => {
  const command = process.argv[2] || 'all';
  await serverStartup();
  const account = new Account(su as UserModule);

  if (command === 'clean') {
    await clean();
    return;
  }

  if (command === 'bulk') {
    await seedBulk(account);
    return;
  }

  if (command === 'v3') {
    await clean();
    await seedV3(account);
    return;
  }

  if (command === 'report') {
    const ok = await report();
    if (!ok) process.exitCode = 1;
    return;
  }

  await clean();
  await seed(account);
  const ok = await report();
  if (!ok) process.exitCode = 1;
};

main()
  .catch((error) => {
    say(`\nERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await knex.destroy();
    await knex2.destroy();
    process.exit(process.exitCode ? 1 : 0);
  });
