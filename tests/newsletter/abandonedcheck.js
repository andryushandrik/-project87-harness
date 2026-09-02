// isNewsletterAbandoned was a direct boolean expression, now it is evaluated from
// NEWSLETTER_ABANDONED_RULES. Brute-force both over the whole interesting range.
const FAILED_FROM = 400; const EXTERNAL_FROM = 500; const RETRY_LIMIT = 3;

// ---- OLD (direct expression, as it stood before the refactor) ----
const oldIsAbandoned = (status, retryCount) => (
  (status ?? 0) >= FAILED_FROM
  && (status < EXTERNAL_FROM || (retryCount ?? 0) >= RETRY_LIMIT)
);

// ---- NEW (data-driven, mirrors libs/newsletterStatus.ts) ----
const RULES = {
  all: [['newsletter_status', '>=', FAILED_FROM]],
  any: [
    ['newsletter_status', '<', EXTERNAL_FROM],
    ['newsletter_retry_count', '>=', RETRY_LIMIT],
  ],
};
const holds = (values, [column, operator, value]) => (
  operator === '>=' ? values[column] >= value : values[column] < value
);
const newIsAbandoned = (status, retryCount) => {
  const values = {
    newsletter_status: status ?? 0,
    newsletter_retry_count: retryCount ?? 0,
  };
  return RULES.all.every((r) => holds(values, r)) && RULES.any.some((r) => holds(values, r));
};

const statuses = [null, undefined, 0, 100, 200, 399, 400, 412, 422, 499, 500, 502, 503, 504, 600];
const retries = [null, undefined, 0, 1, 2, 3, 4, 99];

let compared = 0;
let failed = 0;
statuses.forEach((s) => retries.forEach((r) => {
  compared += 1;
  const a = oldIsAbandoned(s, r);
  const b = newIsAbandoned(s, r);
  if (a !== b) {
    failed += 1;
    console.log(`  FAIL status=${s} retry=${r}: old=${a} new=${b}`);
  }
}));

console.log(`compared ${compared} combinations`);

// Spot-check the intent, so a matching pair of wrong implementations still fails.
const expect = (label, got, want) => {
  if (got === want) { console.log(`  ok   ${label}`); return; }
  failed += 1;
  console.log(`  FAIL ${label}: got ${got}, want ${want}`);
};
expect('4xx is abandoned regardless of retries', newIsAbandoned(412, 0), true);
expect('5xx under the retry limit is not', newIsAbandoned(503, 1), false);
expect('5xx at the retry limit is', newIsAbandoned(503, 3), true);
expect('success is not', newIsAbandoned(200, 9), false);
expect('queued is not', newIsAbandoned(100, 9), false);
expect('no status is not', newIsAbandoned(null, 9), false);

console.log(failed ? `\n${failed} FAILURE(S)` : '\nold and new agree everywhere');
process.exit(failed ? 1 : 0);
