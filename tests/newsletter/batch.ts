/**
 * Self-check for the batch sender, no database and no mail service. From the project root:
 * `npx cross-env TS_NODE_PROJECT=tests/newsletter/tsconfig.json ts-node tests/newsletter/batch.ts`
 *
 * Covers the two properties the batch rewrite was made for and that nothing else
 * asserts — grouping by `user_id:account_id` with one mailbox/staff load per batch
 * instead of one per group, and a group surviving a transaction whose document
 * fails to build.
 */
import assert from 'assert';
import Account from '../../models/account';
import Email from '../../models/email';
import { UserModule } from '../../models/module';
import su from '../../serverTasks/serverUser.json';
import * as newsletterTemplate from '../../email_templates/transaction-newsletter';
import type {
  AccountStaffGetterType,
  AccountTransactionGetterType,
} from '../../serverStartup/queries/account';

type Transaction = AccountTransactionGetterType[0];
type Stub = (...args: any[]) => any;

const say = (message: string) => process.stdout.write(`${message}\n`);

const transaction = (id: number, userId: number, accountId: number): Transaction => ({
  id, user_id: userId, account_id: accountId, uuid: `uuid-${id}`, name: `T${id}`,
} as Transaction);

const staff = (accountId: number): AccountStaffGetterType[0] => ({
  account_id: accountId, email: `staff${accountId}@example.com`,
} as AccountStaffGetterType[0]);

const newAccount = (): Account => new Account(su as UserModule);

const stub = <T extends object>(target: T, name: keyof T, fn: Stub) => {
  (target as any)[name] = fn;
};

const groupingLoadsOncePerBatch = async () => {
  const account = newAccount();
  const transactions = [
    transaction(1, 10, 100),
    transaction(2, 10, 100),
    transaction(3, 10, 200),
    transaction(4, 20, 200),
  ];

  let mailboxLoads = 0;
  let staffLoads = 0;
  const sentGroups: string[][] = [];

  stub(Email.prototype, 'loadMailboxList', async () => {
    mailboxLoads += 1;
    return [{ user_id: 10, username: 'ten@example.com' }, { user_id: 20, username: 'twenty@example.com' }];
  });
  (global as any).DB_query = {
    account: {
      staff_getter: async () => {
        staffLoads += 1;
        return [staff(100), staff(200)];
      },
    },
  };
  stub(account, 'loadTransactionList', async () => transactions);
  stub(account, 'sendTransactionNewsletter', async (group: AccountTransactionGetterType) => {
    sentGroups.push(group.map((item) => `${item.user_id}:${item.account_id}`));
    return new Map(group.map((item) => [item.id, 'sent' as const]));
  });

  const result = await account.sendTransactionNewsletterBatch([1, 2, 3, 4, 5]);

  assert.deepStrictEqual(
    sentGroups.map((group) => group.join('+')).sort(),
    ['10:100+10:100', '10:200', '20:200'],
    'транзакции должны группироваться по user_id:account_id',
  );
  assert.strictEqual(mailboxLoads, 1, 'ящики грузятся один раз на батч, а не на группу');
  assert.strictEqual(staffLoads, 1, 'staff грузится один раз на батч, а не на группу');
  assert.deepStrictEqual(
    { ...result, results: [...result.results].sort((a, b) => a.id - b.id) },
    {
      sent_count: 4,
      failed_count: 0,
      skipped_count: 1,
      results: [
        { id: 1, status: 'sent' },
        { id: 2, status: 'sent' },
        { id: 3, status: 'sent' },
        { id: 4, status: 'sent' },
        { id: 5, status: 'skipped' },
      ],
      plan: [],
    },
    'счётчики и построчный результат должны сойтись, недоступная транзакция — skipped',
  );
};

const partialFailureKeepsTheLetter = async () => {
  const account = newAccount();
  const transactions = [transaction(1, 10, 100), transaction(2, 10, 100), transaction(3, 10, 100)];

  let uploaded: { fileName: string }[] = [];
  let drafts = 0;
  let sends = 0;

  stub(newsletterTemplate, 'renderTransactionNewsletterTemplate', async () => ({ status: 'OK', data: '<html/>' }));
  stub(account, 'buildTransactionPdf', async (item: Transaction) => {
    if (item.id === 2) throw new Error('шаблон не найден');
    return { pdfBuffer: Buffer.from(`pdf-${item.id}`), fileName: `T${item.id}.pdf` };
  });
  stub(Email.prototype, 'createDraft', async () => {
    drafts += 1;
    return { id: 777 };
  });
  stub(Email.prototype, 'createAttachmentToken', async () => ({ token_uuid: 'token' }));
  stub(Email.prototype, 'uploadDraftAttachments', async (args: { files: { fileName: string }[] }) => {
    uploaded = args.files;
  });
  stub(Email.prototype, 'sendDraft', async () => { sends += 1; });

  const statuses = await account.sendTransactionNewsletter(transactions, {
    from: 'ten@example.com',
    staffList: [staff(100)],
  });

  assert.deepStrictEqual(
    [...statuses.entries()],
    [[1, 'sent'], [2, 'failed'], [3, 'sent']],
    'упавшая транзакция помечается failed, остальные — sent',
  );
  assert.deepStrictEqual(uploaded.map((file) => file.fileName), ['T1.pdf', 'T3.pdf'], 'письмо уходит с остальными вложениями');
  assert.strictEqual(drafts, 1, 'на группу создаётся один черновик');
  assert.strictEqual(sends, 1, 'черновик отправляется и не удаляется как сбойный');
};

const dryRunPlansWithoutSending = async () => {
  const account = newAccount();
  const transactions = [transaction(1, 10, 100), transaction(2, 10, 100), transaction(3, 20, 200)];

  stub(Email.prototype, 'loadMailboxList', async () => [{ user_id: 10, username: 'ten@example.com' }]);
  (global as any).DB_query = { account: { staff_getter: async () => [staff(100), staff(200)] } };
  stub(account, 'loadTransactionList', async () => transactions);
  stub(account, 'sendTransactionNewsletter', async () => {
    throw new Error('dry run не должен ничего отправлять');
  });

  const result = await account.sendTransactionNewsletterBatch([1, 2, 3], { dryRun: true });

  assert.deepStrictEqual(
    [...result.plan].sort((a, b) => a.account_id - b.account_id),
    [
      { account_id: 100, from: 'ten@example.com', to: 'staff100@example.com', ids: [1, 2] },
      { account_id: 200, from: null, to: 'staff200@example.com', ids: [3] },
    ],
    'план должен показать по письму на группу, с отправителем и получателями',
  );
  assert.deepStrictEqual(
    [result.sent_count, result.failed_count, result.skipped_count, result.results],
    [0, 0, 0, []],
    'dry run ничего не отправил, поэтому и счётчики пустые',
  );
};

const main = async () => {
  await groupingLoadsOncePerBatch();
  say('OK: группировка по user_id:account_id, один загруз ящиков и staff на батч');
  await partialFailureKeepsTheLetter();
  say('OK: сбой сборки одного документа не роняет письмо группы');
  await dryRunPlansWithoutSending();
  say('OK: dry run возвращает план писем и ничего не отправляет');
};

main().catch((error) => {
  say(`\nERROR: ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
});
