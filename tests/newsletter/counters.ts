/**
 * Node-side copy of the newsletter counter definitions from
 * `public/js/libs/newsletter-filters.ts`. That module cannot be imported here: it
 * resolves through webpack path aliases and pulls in React. Keep the two in sync —
 * the URLs produced here must stay byte-identical to the frontend ones.
 */
import {
  NEWSLETTER_ABANDONED_RULES,
  NEWSLETTER_STATUS,
  NEWSLETTER_STATUS_FAILED_FROM,
} from '../../libs/newsletter';

type DayColumn = 'timestamp' | 'r_start' | 'date';

type RuleSpec = [parameter: string, operator: string, value: string | number];

interface IRule {
  or: boolean;
  parameter: string;
  operator: string;
  value: string;
}

const toGroup = (or: boolean, rules: RuleSpec[]): IRule[] => rules.map(
  ([parameter, operator, value]) => ({
    or, parameter, operator, value: String(value),
  }),
);

const dayGroups = (column: DayColumn, day: string): IRule[][] => [
  toGroup(false, [[column, '>=', day]]),
  toGroup(false, [[column, '<=', `${day} 23:59:59`]]),
];

interface INewsletterCounter {
  id: number;
  name: string;
  allOf: RuleSpec[];
  anyOf?: RuleSpec[];
  dayColumn?: DayColumn;
}

export const NEWSLETTER_COUNTERS: INewsletterCounter[] = [
  {
    id: 101,
    name: 'Запланировано',
    dayColumn: 'r_start',
    allOf: [
      ['t_has_newsletter', '=', 1],
      ['r_status', '=', 1],
      ['r_alarm', '=', 0],
    ],
  },
  {
    id: 102,
    name: 'Отправлено',
    dayColumn: 'timestamp',
    allOf: [['newsletter_status', '=', NEWSLETTER_STATUS.SENT]],
  },
  {
    id: 103,
    name: 'В очереди',
    allOf: [['newsletter_status', '=', NEWSLETTER_STATUS.QUEUED]],
  },
  {
    id: 104,
    name: 'Ошибки дня',
    dayColumn: 'timestamp',
    allOf: [['newsletter_status', '>=', NEWSLETTER_STATUS_FAILED_FROM]],
  },
  {
    id: 105,
    name: 'Все ошибки',
    allOf: [['newsletter_status', '>=', NEWSLETTER_STATUS_FAILED_FROM]],
  },
  {
    id: 106,
    name: 'Без повторов',
    allOf: NEWSLETTER_ABANDONED_RULES.all,
    anyOf: NEWSLETTER_ABANDONED_RULES.any,
  },
];

const ruleToStr = (rule: IRule): string => [
  encodeURIComponent(rule.or ? '|' : '&'),
  encodeURIComponent(rule.parameter),
  encodeURIComponent(rule.operator),
  encodeURIComponent(rule.value),
].join(',') + ';';

const counterQuery = (counter: INewsletterCounter, day: string): string => {
  const groups = counter.allOf.map((rule) => toGroup(false, [rule]));
  if (counter.anyOf) groups.push(toGroup(true, counter.anyOf));
  if (counter.dayColumn) groups.push(...dayGroups(counter.dayColumn, day));
  return groups.map((rules) => `&flt:${rules.map(ruleToStr).join('')}`).join('');
};

export const buildNewsletterCountUrls = (day: string): Record<string, string> => NEWSLETTER_COUNTERS
  .reduce((acc, counter) => ({ ...acc, [counter.id]: counterQuery(counter, day) }), {});

/**
 * Self-check: `npx ts-node tests/newsletter/counters.ts`. `ToolbarSearch` renders a
 * filter group only when it holds a single rule, so every rule that is not part of a
 * real disjunction has to travel in a group of its own — otherwise the counter's
 * filter still applies but disappears from the search bar.
 */
if (require.main === module) {
  const assert = require('assert');
  const day = '2026-09-01';

  const parseGroups = (query: string): string[][][] => query
    .split('&flt:')
    .filter(Boolean)
    .map((group) => group.split(';').filter(Boolean).map((rule) => rule.split(',').map(decodeURIComponent)));

  NEWSLETTER_COUNTERS.forEach((counter) => {
    const groups = parseGroups(counterQuery(counter, day));
    const disjunctions = counter.anyOf ? 1 : 0;

    assert.deepStrictEqual(
      groups.filter((rules) => rules.length > 1).length,
      disjunctions,
      `${counter.name}: одиночными должны быть все группы, кроме OR-группы`,
    );

    if (!counter.dayColumn) return;

    const bounds = groups.filter((rules) => rules.every(([, parameter]) => parameter === counter.dayColumn));
    assert.deepStrictEqual(
      bounds.map(([[, , operator, value]]) => [operator, value]),
      [['>=', day], ['<=', `${day} 23:59:59`]],
      `${counter.name}: день должен быть двумя правилами-границами`,
    );
  });

  console.log('OK: правила счётчиков совпадают с тем, что умеет показать поиск');
}
