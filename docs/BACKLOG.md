# Figma-Normalizator — что не доделано и что можно улучшить

Снимок состояния на коммит `f2cb9e7`. Как устроен пайплайн — см.
**[ARCHITECTURE.md](./ARCHITECTURE.md)**; нумерация ссылается на его разделы.

Отсортировано по влиянию на конечную цель — IR, пригодный для кодогенерации.
Часть пунктов подтверждена замерами на реальном экспорте (см. раздел 8
ARCHITECTURE.md): 134 ноды, 361 запись в `unresolved`, 80% токенов не резолвятся,
**0 mapped-инстансов из 46**.

Легенда: 🔴 блокер · 🟠 существенный пробел · 🟡 качество/производительность ·
🟢 инфраструктура и следующие этапы.

## 🔴 Блокеры для кодогенерации

**B1. ✅ (исправлено) `fileKey` всегда пустой.** ~~В реальном экспорте `source.fileKey === ""` во всех
134 нодах.~~ `manifest.json` теперь запрашивает `enablePrivatePluginApi`, а
`code.ts#resolveFileKey` явно эмитит `UnresolvedEntry("missing-file-key")`, когда
`figma.fileKey` всё равно недоступен (непубличный/не-org плагин), вместо тихой
пустой строки. См. `plugin/README.md` → «`fileKey`: when it's populated…».

**B2. 🟡 Частично исправлено. В реальном экране 0 mapped-инстансов из 46.**
`component-map.yaml` покрывает библиотеку **NUI - iOS Components** (10
записей), а реальный экран использует `Section Header`, `Container`,
`Segmented Controls`, `Slider`, `Tab Bars`, `Insights Card`, `🔒 Assets / *` и
т. д. — эти компоненты просто отсутствуют в карте, и добавить их может только
человек с доступом к дизайн-системе (`compose`/`package`/`variants` для
каждого — не то, что можно достоверно угадать из кода). Это по-прежнему
открыто.

~~Отдельно: в файле есть `Badge` (ед. ч.), а в карте — `Badges` (мн. ч.) → 3
промаха на пустом месте, потому что `findComponentMapEntry` сравнивает строки
**точно**.~~ Исправлено: `findComponentMapEntry` (`mappings/src/index.ts`)
теперь, если точное совпадение не найдено, повторяет поиск по нормализованному
имени (регистр/пробелы/наивное отбрасывание конечной "s") — фиксит именно
`Badge`/`Badges` и подобный дрейф без ложных срабатываний на действительно
немаппленных наборах (`Section Header`, `Container` по-прежнему `null`).
Сопоставление по `figmaComponentKey` не сделано — в `component-map.yaml` нет
устойчивого across-file key, только `figmaNodeId` (per-file, бесполезен здесь).

**B3. ✅ (исправлено) Потеря литеральных значений типографики.** ~~При
`typography.token === null` (20 случаев) в IR не остаётся ничего.~~ `TokenRef`
теперь несёт опциональное поле `literal` (`typographyLiteral` в схеме:
`fontFamily`/`fontStyle`/`fontSize`/`fontWeight`/`lineHeight`/`letterSpacing`),
заполняемое из того же `getStyledTextSegments`-сегмента, когда `token === null`.
См. `plugin/README.md` → «Typography literal fallback».

**B4. ✅ (исправлено) Нет числовых размеров.** ~~`sizing: {width: "fixed"}` не несёт
значения в px.~~ `Sizing` теперь несёт опциональное `dimensions: {width?, height?}`,
заполняемое из `node.width/node.height` (округление до целого px, как у
`AssetNode.width/height`) независимо от режима — см. `plugin/README.md` → «Sizing
dimensions».

**B5. 🟡 Частично исправлено. Не извлекаются целые классы свойств.**
~~Молча теряются: `strokes`/`strokeWeight`/`strokeAlign` (границы), `effects`
(тени, blur), `opacity` ноды~~ — эти три теперь извлекаются в
`LayoutNode.border`/`effects`/`opacity` (`effects.ts`), с `unsupported-effect`
для `LAYER_BLUR`/`BACKGROUND_BLUR`. См. `plugin/README.md` → «Border, effects,
and opacity».

Ещё не сделано (по-прежнему молча теряются, без единого `UnresolvedEntry`):
`rotation`, `blendMode`, `clipsContent`, `textAlignHorizontal/Vertical`,
`textAutoResize`, `maxLines`, `letterSpacing`/`lineHeight` на уровне ноды
(только per-segment фолбэк из B3 покрывает это), `textDecoration`,
`counterAxisSpacing` (grid/wrap), `layoutWrap`, `constraints`,
`minWidth/maxWidth`. Это по-прежнему нарушение задекларированного в схеме
инварианта «ничего не теряем молча» для перечисленных полей.

## 🟠 Существенные пробелы

**G1. ✅ (исправлено) Градиенты и не-SOLID заливки теряются тихо.**
~~`resolveFillColor` берёт первый `SOLID` и возвращает `null` без варнинга,
если его нет. `GRADIENT_LINEAR`, `IMAGE`, `VIDEO` просто исчезают.~~
`resolvePaintColor` (`tokens.ts`) теперь при отсутствии видимого `SOLID`
проверяет, есть ли видимая заливка другого типа, и если да — эмитит
`UnresolvedEntry("unsupported-paint")` с перечислением найденных типов,
вместо тихого `background`/`border: null`. Само разрешение градиентов/
изображений в цвет по-прежнему не реализовано — см.
`plugin/README.md` → «Non-solid paints (gradients, images, video)».

**G2. ✅ (исправлено) Коллизии `exportRef`.** ~~В реальном файле: `icon` ×3,
`action_buttons` ×2, `line` ×2, `gradient_mask` ×2, `content` ×2. Разные
картинки получат одно имя файла.~~ `resolveExportRef` (`asset.ts`) теперь
отслеживает уже занятые слаги в `ProvenanceContext.exportRefRegistry`
(общий на весь `extractSelection`) и при коллизии добавляет суффикс из
nodeId (детерминированно, не зависит от порядка обхода), плюс эмитит
`UnresolvedEntry("duplicate-export-ref")`. См. `plugin/README.md` →
«Deterministic `exportRef` collision handling».

**G3. ✅ (исправлено, частично) Эвристика `inferAssetType` промахивается.**
~~22 `image` против 3 `icon` на экране, где иконок явно больше:
`right_content` 40×56 и `misc_lightbulb` 32×32 помечены как `image`.~~
`inferAssetType` (`asset.ts`) теперь дополнительно относит к `"icon"` любой
узел ≤48×48 (не только по имени) — это чинит `misc_lightbulb` 32×32.
`right_content` 40×56 всё ещё не попадает под это правило (одна сторона
&gt;48px) — граничный случай, задокументированный в `plugin/README.md` →
«Asset type classification» как сознательно не покрытый этой эвристикой.

**G4. Ассеты не экспортируются.** `exportRef` — это только _предложенное имя_.
Реальных SVG/PNG байт нет (`exportAsync` не вызывается), `networkAccess: none`.
Кодогенератору нечего положить в ресурсы.

**G5. `INSTANCE_SWAP`-слоты всегда `null`.** Содержимое подставленного компонента
не резолвится (явно отложено). Иконки в кнопках теряются.

**G6. ✅ Конверт экспорта не покрыт схемой (исправлено).** `schema/ir/v1/schema.json`
теперь содержит `$defs/irDocument` — `{schemaVersion, nodes, unresolved, version}` —
отдельно от `irNode` (который по-прежнему описывает один элемент `nodes[]`).
`fixtures/src/__tests__/schema-validation.test.ts` валидирует каждую fixture
целиком через `irDocument`, а не только по узлам. Типы сгенерированы вручную
через `renderIRDocumentInterface()` в `generate-types-lib.mjs` (ограничение
`json-schema-to-typescript`: `unreachableDefinitions` не подхватывает
`$defs`, не достижимые из корневого `oneOf`-схемы — см. комментарии в файле).

**G7. ✅ Версия схемы не попадает в артефакт (исправлено).** `ExtractionResult`
(и оба возврата `extractSelection`) теперь несут `schemaVersion: IR_SCHEMA_VERSION`
(литерал `1`, уже существовавшая константа из `@figma-normalizator/schema`).
Экспортируемый `*.ir.json` — это теперь полноценный `IRDocument`, который можно
провалидировать и различить по версии при появлении v2. См.
`plugin/README.md` → «The export envelope: `IRDocument` and `schemaVersion`».

**G8. `symbol` заполняется у 14 объектов из 313.** Только ветка `base/color`
Android_Avalon. Для `components/*` (а на реальном экране это большинство токенов:
`components/section-header/size/padding/...`) символов нет вообще.

**G9. Продукт захардкожен.** Плагин бандлит только `android-avalon.token-map.json`;
выбора продукта (Avalon/Stelo) при экспорте нет. Задокументировано как известное
ограничение, но при появлении второго потребителя сломается.

**G10. token-map обновляется вручную и межрепозиторно.** `tools/figma-tokens/json/
tokens.json` не коммитится, генерация требует локальный чекаут Android_*,
`bundle:token-map` запускается руками. Бандл может незаметно протухнуть
относительно живого файла Figma — и при этом `symbol` просто молча отсутствует.

**G11. `tools/figma-tokens` не интегрирован.** Папка лежит в корне, но её нет в
`workspaces`, нет в CI, нет npm-скрипта-обёртки, `.gitignore` не покрывает
`__pycache__`/`.pytest_cache` (они уже в рабочем дереве), а `mappings/token-map/
README.md` всё ещё ссылается на неё как на «репозиторий DexFigmaPlugin».

**G12. Исключённая политикой _коллекция_ исчезает из токен-документа бесследно.**
`tokenExport.ts` собирает исключённые коллекции в `skippedCollections` — поле
результата, которое уходит в UI-панель и **не является частью документа**. Цикл
экспорта идёт по `kept`, поэтому переменные исключённой коллекции не посещаются
вообще и в `unresolved[]` не попадают. Исключённая _ветка_ при этом обрабатывается
правильно (`reason: "excluded-by-policy"`), так что поведение асимметрично.

Это прямо противоречит инварианту, который схема объявляет обязательным:

> Producers MUST emit an entry here for any input variable not present in
> `collections` — a variable must never be silently dropped.

Замерено на реальном экспорте: `figma-only` — локальная коллекция из 27 переменных,
исключена политикой, и в документе от неё **ноль записей** (`unresolved` содержит
только `unsupported-value` 168 и `excluded-collection-alias` 22).

Цена не теоретическая: при миграции генератора коллекция `stelo` (281 переменная)
отсутствовала в новом экспорте, и **по документу нельзя было отличить «удалена из
файла» от «отброшена политикой» или «потеряна плагином»** — потребовалась ручная
сверка с Figma. Ровно ту диагностическую дыру, которую `unresolved[]` был заведён
закрыть.

Осторожно с наивным исправлением: `exclude-remote-collections` по умолчанию `true`,
и на реальном файле это 27 remote-коллекций / ~200 переменных — по записи на
переменную превратит `unresolved[]` в шум. Разумнее отчитываться на уровне
коллекции (например, `policy.excludedCollections` с `{name, id, remote,
variableCount, reason}`), что требует правки схемы `tokens/v1`.

**G13. `codegen/tokens`'s Kotlin output shape doesn't match what real
consumers (Android_Stelo) expect — needs a deliberate redesign decision.**
Verified by generating the new emitter's real output against Android_Stelo's
production fixture and diffing it against what's actually on disk there.

Old (retired `_legacy-python` generator, still what `Android_Stelo` builds
against today): one `.kt` file **per top-level branch** (e.g.
`base/color/Color.kt`), a separate per-mode factory file per branch
(`base/color/ColorLight.kt` → `colorLight(palette: Palette)`,
`base/color/ColorDark.kt` → `colorDark(palette: Palette)`), a root aggregator
per collection (`base/Base.kt` + `base/BaseLight.kt`/`BaseDark.kt`), and
per-platform primitives variants (`primitivesAndroid()`/`primitivesIos()`).
119 files, ~16k lines. App code hard-depends on this exact shape:
`app/.../DsThemeColors.kt` has
`typealias SemanticColors = com.dexcom...token.base.color.Color` and calls
`colorLight`/`colorDark`/`componentsDark`/`componentsLight`/`primitivesAndroid`
directly by name and package.

New (`codegen/tokens` v1, this repo, merged in #16): one file **per
collection** (`Base.kt`, `Primitives.kt`, ...), every branch nested as an
inner `data class`, one factory per collection-mode taking the *whole*
upstream collection (`baseLight(primitives: Primitives)`, not
`colorLight(palette: Palette)`). 4 files, ~14.7k lines. This is a
deliberately simpler design (see `kotlin.ts`'s header comment — the old
`branch_pkg_map`/`cross_branch_deps` machinery was cut on purpose) and is
well covered by golden/unit tests, but it is **not a drop-in replacement**:
swapping it in as-is would break every reference above.

Trade-offs observed:
- Old: fine-grained per-branch diffs, matches shipping app code as-is, but
  much more emitter complexity, and per-branch files can go stale/orphaned
  if a branch is renamed or removed (the exact failure class this whole
  migration was meant to fix).
- New: far fewer, simpler-to-generate files, no orphaned-file risk (each
  file is fully rewritten every run), but factories take a whole collection
  instead of narrow per-branch dependencies, there's no root aggregator, and
  no per-platform primitives split — so it can't be dropped into an
  Android app that already depends on the old API shape without also
  touching that app's consumer code.

Decision taken for the immediate Android_Stelo request: emit a
*structural*-compatibility mode (one data-class file per top-level branch
again, in its own subpackage, restoring `token.base.color.Color`-shaped
paths, plus a separate factory-only file per branch per mode --
`token.base.color.ColorLight`/`ColorDark` -- and likewise a data-class-only
root file plus one factory-only file per collection mode --
`token.base.BaseLight`/`BaseDark`) without porting the old cross-branch/
per-parameter dependency injection or the mode-collapsing-when-values-
don't-vary-by-mode optimization. Consumers still
need small call-site updates (factories now take the whole upstream
collection, e.g. `colorLight(primitives: Primitives)` instead of
`colorLight(palette: Palette)`). Revisit later: either invest in full binary
parity (bigger, arguably wasted effort re-adding complexity stage 6
deliberately removed) or — preferred — treat this as a bridge and plan a
one-time migration of Android_Stelo's consumers to the compact
one-file-per-collection format once it's proven out, rather than
maintaining the legacy multi-file layout indefinitely.

**G14. `COMPOSE_COLOR` with an alias-typed opacity was silently falling back to
`unsupported-value` — fixed.** Figma's `COMPOSE_COLOR` variable expression
(color variable + opacity override, built via the Figma UI) has two
independent arguments: a color `VARIABLE_ALIAS` and an opacity argument that
can be either a bare number *or itself* a `VARIABLE_ALIAS` to a named opacity
token. `tokenExport.ts` only handled the bare-number case; when opacity was
also an alias it fell through to the generic "unexpected shape"
`unsupported-value` path. On the real-world fixture this was **all 168** of
its `unsupported-value` entries — not a rare edge case.

Fixed by adding a self-referential `opacity` field to `aliasTarget` in the
`tokens/v1` schema, resolving the opacity alias recursively in
`resolveMode`, and threading `edge.opacity.collection` through the
`dependsOn` computation the same way `edge.collection` already was. The
Kotlin emitter (`valueExpressionFor` in `kotlin.ts`) now emits a live
`base.copy(alpha = opacity._40)` reference instead of a baked hex literal
when this edge is present (falls back to the old flattened-literal behavior
if the opacity edge was itself excluded by policy). Covered by tests in
`tokenExport.test.ts` and `kotlin.test.ts`.

## 🟡 Качество и производительность

**Q1. ✅ (исправлено) `structuralSignature` — O(n²) по поддереву.** Раньше для
каждой пары соседей подпись **всего поддерева** строилась заново (JSON.stringify
пересчитывался на каждое сравнение, включая пересчёт подписи одного и того же
"текущего" элемента на каждой итерации внутреннего цикла). Теперь `collapseLists`
заводит `Map<FigmaNode, string>`-кэш подписей на один вызов (`memoizedSignature` в
`list.ts`): подпись каждой ноды считается один раз и переиспользуется во всех
сравнениях, где эта нода участвует.

**Q2. Глобальный мутабельный `unreadableSignatureCounter`** в `list.ts` по-прежнему
существует (используется как маркер "не читается" для нод со сломанными
component-свойствами), но после мемоизации (Q1) вызывается уже не на каждое
сравнение, а максимум один раз на ноду — частично снижает нечистоту функции, но
сам счётчик как модульная переменная остаётся: не устраняется этим фиксом, отдельная
задача, если понадобится полная чистота.

**Q3. Порог списка `MIN_RUN_LENGTH = 3` и бюджет `5000` захардкожены** без возможности
настройки из UI.

**Q4. ✅ (исправлено) Последовательный `await` в горячих циклах: нет кэша
резолвленных переменных.** `resolveVariable` резолвит режимы строго по очереди
(осталось как есть — модовые значения одной переменной естественно зависимы), но
повторные резолвы **одного и того же** `variableId`/`variableCollectionId` с разных
нод/полей теперь кэшируются: `extractSelection` оборачивает `figma.variables` в
`createCachingVariablesAPI` (`variableCache.ts`), созданный один раз на весь вызов
и переданный вниз через существующий параметр `figma`. Кэшируются сами промисы (а
не только резолвленные значения), так что параллельные обращения к одному id, ещё
не завершившиеся к моменту второго вызова, тоже не дублируют сетевой запрос.

**Q5. `BOOLEAN_OPERATION` в двух списках одновременно** — и в `CONTAINER_TYPES`
(`index.ts`), и в `VECTOR_LIKE_TYPES` (`asset.ts`). Работает, но порядок проверок
неочевиден и хрупок.

**Q6. `crossAxisAlign: "stretch"` только если тянутся ВСЕ дети.** Частичный stretch
теряется без варнинга. `BASELINE` схлопывается в `start` — тоже молча.

**Q7. `ui.ts` не покрыт тестами** (осознанно), но в нём уже накопилась логика
состояния (`lastResult`, `warningsCollapsed`, таймер статуса).

**Q8. Нет `unresolved` внутри нод, кроме `instance`.** Схема даёт
`InstanceNode.unresolved`, а layout/text/asset-проблемы живут только в плоском
корневом массиве. Связь «варнинг ↔ нода» только через `nodeId`.

**Q9. ✅ (исправлено) Огромный плоский `unresolved` (361 запись).** Раньше все
записи были равнозначны — реальная проблема (`unmapped-component`) тонула среди
десятков рутинных `unbound-literal`. Теперь `schema/ir/v1/schema.json` добавляет
опциональное поле `severity` (`"error" | "warning" | "info"`) в `unresolvedEntry`;
`extractor/severity.ts` проставляет его один раз в конце `extractSelection` по
таблице `reason -> severity` (единое место классификации, а не разбросанное по
каждому месту эмита). Панель (`ui/warnings.ts`) по-прежнему группирует по `reason`,
но теперь стабильно сортирует группы по severity (error → warning → info) —
дедупликация по (reason, field) сознательно не сделана в этом проходе, так как
она удаляла бы отдельные записи из `unresolved[]`, а группировка+сортировка уже
решает заявленную проблему «шум прячет реальные проблемы» без потери ни одной
записи.

**Q10. Два `*.token-map.json` по 35 000 строк каждый и побайтово идентичны.**
Задокументировано, но 70 000 строк дублирующегося JSON в репозитории.

## 🟢 Инфраструктура и следующие этапы

**S1. Нет MCP-сервера** для отдачи IR агентам/инструментам (Stage 2).

**S2. Нет кодогенерации** Compose/SwiftUI из IR (Stage 3).

**S3. ✅ (исправлено) Нет CI-проверки актуальности сгенерированных артефактов.**
Добавлен корневой скрипт `npm run generate` (регенерирует, в порядке зависимостей,
`schema/src/generated/ir.ts`, `mappings/src/generated/component-map.json`,
`mappings/src/generated/token-map.json` и все 5 `fixtures/src/corpus/*/expected.ir.json`
— всё из уже закоммиченных источников, без внешних входов) и
`npm run verify:generated` (`generate` + `git diff --exit-code` по этим трём
директориям). `.github/workflows/ci.yml` теперь запускает `verify:generated`
последним шагом: PR с рассинхронизированным сгенерированным артефактом красный.
Намеренно не включает `generate:token-map` (требует внешний `tokens.json` из
другого репозитория — не воспроизводимо в CI, см. G10/wire-python-tool).

**S4. Нет Python-части в CI.** `tools/figma-tokens/tests` (pytest) не запускается.

**S5. Нет версионирования/релизов плагина.** Все `package.json` — `0.0.0`,
`manifest.json.id` подставлен, но README всё ещё называет его плейсхолдером.

**S6. ✅ (исправлено) Нет сквозного e2e-теста на реальном файле.** Приложенный
`daily_*.ir.json` перемещён из корня (был неотслеживаемым файлом) в
`fixtures/src/real-world/` и теперь валидируется тестом
(`fixtures/src/__tests__/real-world.test.ts`): каждый узел из `nodes[]` — против
`irNode`, каждая запись `unresolved[]` — против `unresolvedEntry`. Полная валидация
конверта (`irDocument`) невозможна: файл захвачен до появления `schemaVersion`,
поэтому проверяется на уровне узлов/записей, а не всего конверта — задокументировано
в `fixtures/src/real-world/README.md`. Так как оригинальное Figma-дерево, породившее
этот файл, недоступно (сохранён только результат, не вход), он не участвует в
`fixtures:update`/snapshot-тесте, как остальной корпус — это дополнение, а не замена
существующих 5 синтетических фикстур.

**S7. Документация фрагментирована.** `plugin/README.md` — 26 КБ, куда попало и
описание UI, и ADR-обоснования (версионирование, алиасы, detached instances).
Стоит вынести решения в `docs/adr/`, оставив README справочником.
