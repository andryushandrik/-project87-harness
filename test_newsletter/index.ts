/**
 * Seeds a_transaction with a predictable newsletter outbox and verifies the counters.
 *
 * Every outcome is forced by data alone, never by taking a service down: the batch
 * sender groups by `user_id:account_id` (models/account.ts:611), so each bucket gets
 * its own account and the outcomes cannot bleed into each other.
 *
 * Usage (from the project root, dev services up):
 *   npx ts-node test_newsletter/index.ts          full cycle: clean, seed, run, report
 *   npx ts-node test_newsletter/index.ts clean    remove previous test data only
 *   npx ts-node test_newsletter/index.ts report   re-check counters against expectations
 */
import serverStartup from '../serverStartup';
import Account from '../models/account';
import Email from '../models/email';
import createRegularTransactions from '../serverTasks/createTransactions';
import { UserModule } from '../models/module';
import { knex, knex2 } from '../libs/mysqlDB';
import { NEWSLETTER_STATUS } from '../libs/newsletterStatus';
import { NEWSLETTER_RETRY_LIMIT } from '../libs/transactionConstants';
import { buildNewsletterCountUrls } from '../libs/newsletterCounters';
import { dateFormat } from '../libs/date';
import su from '../serverTasks/serverUser.json';

const MARK = '[NL-TEST]';

/** techtype with neither an account file nor a system template, so buildPdf always fails */
const TECHTYPE_MISSING_TEMPLATE = 99;

const STAFF_VISIBLE = { status: 40, is_official_email: 1 };

const today = () => dateFormat('yyyy-mm-dd') as string;

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

const resolveUsers = async (account: Account): Promise<{ sender: number, noSender: number, from: string }> => {
  const email = new Email(account.__user);
  const mailboxes = await email.loadMailboxList({ is_main: true, ignore_page: true });
  if (!mailboxes.length) {
    throw new Error('No main mailbox found in the mail service — bucket 200 is impossible');
  }

  const withMailbox = new Set(mailboxes.map((mailbox) => Number(mailbox.user_id)));
  const sender = Number(mailboxes[0].user_id);

  const owners: Array<{ user_id: number }> = await knex
    .distinct('user_id')
    .from('a_account');
  const noSender = owners
    .map((row) => Number(row.user_id))
    .find((id) => id > 0 && !withMailbox.has(id));

  if (!noSender) {
    throw new Error('Every account owner has a main mailbox — cannot build the 412 bucket');
  }

  return { sender, noSender, from: mailboxes[0].username };
};

const clean = async (): Promise<number[]> => {
  const accounts: Array<{ id: number }> = await knex
    .select('id')
    .from('a_account')
    .where('name', 'like', `${MARK}%`);
  const ids = accounts.map((row) => Number(row.id));
  if (!ids.length) return [];

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

const runPipeline = async (accountIds: number[], label: string): Promise<void> => {
  say(`run: ${label}`);
  await createRegularTransactions();
  await waitForQuiet(accountIds);
};

interface IExpectation {
  key: string;
  name: string;
  expected: number;
}

const EXPECTED: IExpectation[] = [
  { key: 'planned', name: 'Запланировано на дату', expected: 1 },
  { key: 'sent', name: 'Отправлено за дату', expected: 1 },
  { key: 'queued', name: 'В очереди', expected: 1 },
  { key: 'failed', name: 'С ошибками за дату', expected: 4 },
  { key: 'failedTotal', name: 'С ошибками за всё время', expected: 4 },
  { key: 'abandoned', name: 'Повторов больше не будет', expected: 3 },
];

const report = async (account: Account): Promise<boolean> => {
  const counts = await account.loadCount(buildNewsletterCountUrls(today()), 'transaction');

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

  say('\nСчётчики вкладки:');
  let ok = true;
  EXPECTED.forEach((item) => {
    const actual = Number(counts[item.key] ?? 0);
    const pass = actual === item.expected;
    if (!pass) ok = false;
    say(`  ${pass ? 'OK  ' : 'FAIL'} ${item.name.padEnd(28)} ожидалось ${item.expected}, получено ${actual}`);
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

  if (command === 'report') {
    const ok = await report(account);
    if (!ok) process.exitCode = 1;
    return;
  }

  await clean();
  await seed(account);
  const ok = await report(account);
  if (!ok) process.exitCode = 1;
};

main()
  .catch((error) => {
    say(`\nERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(() => {
    knex.destroy();
    knex2.destroy();
  });
