# Harness и основной репозиторий

В рабочей копии лежат два независимых git-репозитория:

- `.git` — основной репозиторий проекта (ветки `master`, `WIP`, общий remote);
- `.harness.git` — личный harness: заметки, планы, протоколы, тестовые стенды. Локальный, без remote.

Файлы harness спрятаны от основного репозитория через `.git/info/exclude` — этот список
не версионируется ни одним из репозиториев, поэтому продублирован ниже.

## Правило границы

**Основной репозиторий не должен ссылаться на то, что существует только в harness.**
Обратное разрешено: harness свободно ссылается на код проекта.

Нарушение выглядит безобидно — строчка в `package.json`, путь в конфиге, ссылка в README, —
но у любого, кто склонировал основной репозиторий, эта ссылка ведёт в пустоту.

Известные случаи:

| Что | Когда попало | Как чинилось |
|-----|--------------|--------------|
| `package.json` → `test:newsletter` на `tests/newsletter/index.ts` | коммит `cef5ab4a1` «dt test garbage fix», 01.09.2026 — заехал попутно с несвязанной правкой | скрипт удалён из `package.json`, запуск описан ниже сырой командой |
| `.eslintignore` с `tests/` | не версионировался нигде | взят под harness-репозиторий |

## Что чей

Harness (`.harness.git`, исключены из основного репозитория):

```
.claude/                 настройки и планы агента
.mcp.json
CLAUDE.md                соглашения проекта, читает агент
docs/                    планы, ревью, протоколы тестирования
config/README.md
tests/                   стенды: сид данных рассылки, self-check батча
.eslintignore            прячет tests/ от `npm run eslint` основного репозитория
```

Всё остальное — основной репозиторий.

Пограничный случай — `.eslintignore`. Файл нужен только потому, что `tests/` существует
локально; в `.eslintrc.json` основного репозитория его прописывать нельзя (там нет и
не должно быть знания про harness).

## Установка на новой машине

`.git/info/exclude` не клонируется. После `git clone` основного репозитория и распаковки
harness добавить в `.git/info/exclude`:

```
# harness files — tracked in .harness.git, not in this repo
CLAUDE.md
docs/
config/README.md
.harness.git/
tests/
.eslintignore
```

Работа с harness-репозиторием:

```
git --git-dir=.harness.git --work-tree=. status
git --git-dir=.harness.git --work-tree=. add docs/foo.md
git --git-dir=.harness.git --work-tree=. commit -m "..."
```

## Запуск стендов рассылки

npm-скриптов для них нет и не будет — `package.json` принадлежит основному репозиторию.
Из корня проекта:

```
npx cross-env TS_NODE_PROJECT=tests/newsletter/tsconfig.json ts-node tests/newsletter/index.ts [clean|report|bulk|v3]
npx cross-env TS_NODE_PROJECT=tests/newsletter/tsconfig.json ts-node tests/newsletter/batch.ts
```
