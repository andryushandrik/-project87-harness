// Compares the old hand-rolled &flt: builder against the new
// convertFiltersToUrl-based one for every counter. Both are inlined verbatim.
const SENT = 200; const QUEUED = 100; const FAILED_FROM = 400;
const EXTERNAL_FROM = 500; const RETRY_LIMIT = 3;
const DAY = '2026-08-18';

// ---- OLD (libs/newsletterCounters.ts, deleted) ----
const oldRule = (logic, column, operator, value) => [
  encodeURIComponent(logic), column, encodeURIComponent(operator), encodeURIComponent(String(value)),
].join(',');
const oldGroup = (...rules) => `&flt:${rules.join(';')};`;
const oldDayBounds = (date) => {
  const from = new Date(`${date}T00:00:00`);
  const to = new Date(from);
  to.setDate(to.getDate() + 1);
  const asMysql = (v) => `${v.getFullYear()}-`
    + `${String(v.getMonth() + 1).padStart(2, '0')}-`
    + `${String(v.getDate()).padStart(2, '0')} 00:00:00`;
  return { from: asMysql(from), to: asMysql(to) };
};
const oldWithinDay = (column, date) => {
  const { from, to } = oldDayBounds(date);
  return oldGroup(oldRule('&', column, '>=', from), oldRule('&', column, '<', to));
};
const OLD = {
  default: (d) => oldWithinDay('date', d),
  101: (d) => oldGroup(
    oldRule('&', 'is_template', '=', 1),
    oldRule('&', 't_has_newsletter', '=', 1),
    oldRule('&', 'r_status', '=', 1),
    oldRule('&', 'r_alarm', '=', 0),
  ) + oldWithinDay('r_start', d),
  102: (d) => oldGroup(oldRule('&', 'newsletter_status', '=', SENT)) + oldWithinDay('timestamp', d),
  103: () => oldGroup(oldRule('&', 'newsletter_status', '=', QUEUED)),
  104: (d) => oldGroup(oldRule('&', 'newsletter_status', '>=', FAILED_FROM)) + oldWithinDay('timestamp', d),
  105: () => oldGroup(oldRule('&', 'newsletter_status', '>=', FAILED_FROM)),
  106: () => oldGroup(oldRule('&', 'newsletter_status', '>=', FAILED_FROM))
    + oldGroup(
      oldRule('|', 'newsletter_status', '<', EXTERNAL_FROM),
      oldRule('|', 'newsletter_retry_count', '>=', RETRY_LIMIT),
    ),
};

// ---- NEW (public/js/libs/newsletter-filters.ts + utils/filters.ts) ----
const fltToStr = (f) => `${encodeURIComponent(f.or ? '|' : '&')},${encodeURIComponent(f.parameter || '')},`
  + `${encodeURIComponent(f.operator || '')},${encodeURIComponent(f.value || '')};`;
const convertFiltersToUrl = (filters) => {
  let res = '';
  if (filters.length) {
    filters.forEach((g) => { res += '&flt:'; g.rules.forEach((f) => { res += fltToStr(f); }); });
  }
  return res;
};
const toGroup = (id, or, rules) => ({
  id,
  rules: rules.map(([parameter, operator, value], ruleId) => ({
    id: ruleId, or, parameter, operator, value: String(value),
  })),
});
const dateFormatYmd = (date) => `${date.getFullYear()}-`
  + `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const shiftDay = (day, days) => {
  const date = new Date(`${day}T00:00:00`);
  if (Number.isNaN(date.getTime())) return day;
  date.setDate(date.getDate() + days);
  return dateFormatYmd(date);
};
const dayGroup = (id, column, day) => toGroup(id, false, [
  [column, '>=', `${day} 00:00:00`],
  [column, '<', `${shiftDay(day, 1)} 00:00:00`],
]);
const COUNTERS = [
  {
    id: 101,
    dayColumn: 'r_start',
    rules: [['is_template', '=', 1], ['t_has_newsletter', '=', 1], ['r_status', '=', 1], ['r_alarm', '=', 0]],
  },
  { id: 102, dayColumn: 'timestamp', rules: [['newsletter_status', '=', SENT]] },
  { id: 103, rules: [['newsletter_status', '=', QUEUED]] },
  { id: 104, dayColumn: 'timestamp', rules: [['newsletter_status', '>=', FAILED_FROM]] },
  { id: 105, rules: [['newsletter_status', '>=', FAILED_FROM]] },
  {
    id: 106,
    rules: [['newsletter_status', '>=', FAILED_FROM]],
    extraRules: [['newsletter_status', '<', EXTERNAL_FROM], ['newsletter_retry_count', '>=', RETRY_LIMIT]],
  },
];
const counterGroups = (c, day) => {
  const groups = [toGroup(0, false, c.rules)];
  if (c.extraRules) groups.push(toGroup(groups.length, true, c.extraRules));
  if (c.dayColumn) groups.push(dayGroup(groups.length, c.dayColumn, day));
  return groups;
};
const newQuery = (c, day) => convertFiltersToUrl(counterGroups(c, day));
const newDefault = (day) => convertFiltersToUrl([dayGroup(0, 'date', day)]);

let failed = 0;
const check = (label, a, b) => {
  if (a === b) { console.log(`  ok   ${label}`); return; }
  failed += 1;
  console.log(`  FAIL ${label}\n    old: ${a}\n    new: ${b}`);
};
console.log(`day = ${DAY}`);
check('default', OLD.default(DAY), newDefault(DAY));
COUNTERS.forEach((c) => check(String(c.id), OLD[c.id](DAY), newQuery(c, DAY)));

// month/year rollover, where the two date formatters could disagree
['2026-08-31', '2026-12-31', '2026-02-28'].forEach((d) => {
  check(`101 @ ${d}`, OLD[101](d), newQuery(COUNTERS[0], d));
});

console.log(failed ? `\n${failed} MISMATCH(ES)` : '\nall queries byte-identical');
process.exit(failed ? 1 : 0);
