# <img src="plugins/e-comet-skills/assets/logo.png" alt="" width="45" height="45" align="absmiddle"> e-Comet Skills

Инструменты e-Comet помогают селлерам работать с Wildberries: анализировать данные кабинета по API и через ЛК ВБ, а также получать актуальные данные напрямую с Wildberries.

## Установка

Установка доступна в двух вариантах:
- **Базовая** — только внутренняя аналитика по своим артикулам. Подходит, если нет возможности установить десктопное приложение ИИ-агента (например, доступен только ChatGPT или Claude через веб-браузер)
- **Полная** — дополнительно доступны «живые» данные с WB, а также данные из ЛК Селлера. См. подробнее раздел [Инструменты](#инструменты)

### Базовая

> [!IMPORTANT]
> Если вы хотите Полную установку, то шаги, описанные в Базовой, делать не нужно.

<details>
<summary>Claude</summary>

1. В левом нижнем углу нажмите на `Имя` → `Settings` → `Connectors` → `Add` → `Add custom connector`.
2. `Name`: e-Comet, `Remote MCP server URL`: https://mcp.e-comet.io/mcp → `Add`.
3. У коннектора `e-comet` нажмите `Connect` и введите почту.

</details>

<details>
<summary>ChatGPT</summary>

1. В левом нижнем углу нажмите на `Имя` → `Settings` → `Security and login` → `Developer mode` → Включить.
2. На панели слева `Plugins` → `+`.
3. `Name`: e-Comet, `Connection`: https://mcp.e-comet.io/mcp, `Authentication`: OAuth, `I understand and want to continue`: Чек → `Create`.
4. В окне `Add e-Comet to ChatGPT` нажмите `Sign in with e-Comet` и введите почту.

</details>

### Полная

> [!IMPORTANT]
> Необходим ИИ-агент с поддержкой плагинов: Claude Desktop (Cowork), Claude Code, ChatGPT Desktop (Codex) или Codex CLI с платной подпиской.

#### Браузер и расширение

1. Установите [Node.js 22 или новее](https://nodejs.org/) и убедитесь, что команда `node` доступна в `PATH`.
2. Установите [расширение e-Comet](https://chromewebstore.google.com/detail/e-comet/apeallgchpgibifmbgefkhifidihmodh)
   в Chrome.
3. Активируйте расширение API-ключом из [аккаунта e-Comet](https://app.e-comet.io/account).
4. Войдите в свой аккаунт на [wildberries.ru](https://www.wildberries.ru/lk).

<details>
<summary>Claude Desktop (Cowork)</summary>

1. В левом нижнем углу нажмите на `Имя` → `Settings` → `Capabilities`, включите `Allow network egress` и выберите `All domains` в `Domain allowlist`.
2. Оставаясь в окне настроек, откройте слева `Plugins` → `Add` → `Add marketplace` → `Add from repository`.
3. Укажите `https://github.com/e-comet/skills`, нажмите `Use`, установите `Sync automatically` и нажмите `Sync`.
4. Нажмите `+` на карточке `e-Comet MCP Tools`. В окне-подтверждении нажмите `Continue`.
5. Нажмите на ⚙️ на карточке `e-Comet MCP Tools`. В разделе `Connectors` у `e-comet` нажмите `Install`. Нажмите `Add`. Нажмите `Connect` и введите почту.

</details>

<details>
<summary>Claude Code</summary>

```bash
claude plugin marketplace add https://github.com/e-comet/skills
claude plugin install e-comet-skills@e-comet-skills
```

</details>

<details>
<summary>ChatGPT Desktop (Codex)</summary>

1. В левом нижнем углу нажмите на `Имя` → `Settings` → `Configuration` и включите `Allow network access`.
2. Откройте `Plugins`, нажмите `+` → `Add marketplace`. Укажите `https://github.com/e-comet/skills` в поле `Source` и нажмите `Add marketplace`.
3. Там же, в `Plugins`, в разделе `Personal` нажмите `e-Comet MCP Tools` и в разделе `Hooks` выберите `Trust all`.
4. Убедитесь, что оба MCP-сервера, `E-comet` и `E-comet-local`, готовы к работе (справа ⚙️), иначе нажмите `Install` / `Connect` и введите почту.

</details>

<details>
<summary>Codex CLI</summary>

```bash
codex plugin marketplace add https://github.com/e-comet/skills
codex plugin add e-comet-skills@e-comet-skills
```

</details>

## Начало работы

> `Что умеет e-Comet?`

В ответе будет указан ваш тариф e-Comet, список подключенных юрлиц и краткая справка по функционалу.

## Инструменты

На текущий момент все инструменты доступны в режиме `Только чтение` и не покрывают настройки РК.

### Аналитика (свои товары)

- Воронка: открытия карточки, корзины, заказы, выручка, выкупы, % выкупа, конверсии
- Реклама: расход (ДРР, TACoS, ROMI), показы, клики, CTR, CPC, CPM, CPO, цена корзины
- Разрезы: по зонам показов (Поиск / Полки), типам кампаний (Единая, Ручная, CPC), поисковым кластерам (фразам)
- Разделение органики и рекламы по любому шагу воронки, плюс «ассоциированные артикулы» — когда заказ пришёл с рекламы другого товара
- Остатки: свои (FBS) и на складах WB (FBO)
- Цены: средний чек, цена после СПП и сам размер СПП
- Группировки: юрлицо, товар, склейка, предмет, бренд, кампания

<details>
<summary>Примеры</summary>

- *Покажи на графиках заказы по основным предметам, по дням за последние 7 дней.*

</details>

### Живые данные с Wildberries (WB) и из Личного Кабинета (ЛК) Селлера

- \[WB\] Карточка товара: остатки по складам, размеры, цена, характеристики
- \[WB\] Проверка наличия товара в поисковой выдаче по фразе (да / нет)
- \[WB\] Поисковая выдача с позицией товара по фразе
- \[WB\] Рекомендательная полка (похожие товары) с позицией товара
- \[WB\] Ссылки на фото товара
- \[ЛК\] Отзывы товара за период

<details>
<summary>Примеры</summary>

- *Сделай HTML-галерею фото артикулов ВБ 791050753 и 913357757: строка на артикул, клик открывает полный размер, стрелки переключают фото.*
- *На какой позиции артикул 791050753 в поиске ВБ по запросу «тушенка»?*
- *Покажи остатки по складам и размерам для артикула 791050753.*
- *Покажи первые две страницы рекомендаций для артикула 791050753.*
- *Проверь, находится ли артикул 791050753 в поиске ВБ по запросам «тушенка» и «говядина тушеная».*
- *Скачай для артикула 791050753 отзывы без ответа за всё время, а для 913357757 — отвеченные за июнь 2026.*

</details>

<a id="plugin-update"></a>

## Обновление

### Базовая установка

Ручные обновления не требуются, так как обновляется только удаленный MCP-сервер.

### Полная установка

Рекомендуем регулярно обновлять установку для добавления нового функционала и улучшения стабильности текущего. При использовании функций полной установки агент сообщит, если доступно обновление. Список последних изменений доступен в [CHANGELOG](CHANGELOG.md).

<a id="update-cowork"></a>

<details>
<summary>Claude Desktop (Cowork)</summary>

1. В левом нижнем углу нажмите на `Имя` → `Settings` → `Plugins` → `Browse` → `Personal` → `...` у `e-comet-skills` → `Check for updates`.
2. Снова зайдите в `Settings` → `Plugins` → `e-Comet MCP Tools` → `Update`. Если `Update` неактивна и `Last updated` совпадает с последней датой в [CHANGELOG](CHANGELOG.md) — значит у вас уже установлена последняя версия.

</details>

<a id="update-claude-code"></a>

<details>
<summary>Claude Code</summary>

```bash
claude plugin marketplace update e-comet-skills
claude plugin update e-comet-skills@e-comet-skills
```

Выполните `/reload-plugins` или перезапустите Claude Code, затем начните новую задачу.

</details>

<a id="update-codex"></a>

<details>
<summary>ChatGPT Desktop (Codex)</summary>

1. В левом нижнем углу нажмите на `Имя` → `Settings` → `Plugins` → `Marketplace` → `e-Comet MCP Tools` → `Upgrade`.

</details>

<a id="update-codex-cli"></a>

<details>
<summary>Codex CLI</summary>

```bash
codex plugin marketplace upgrade e-comet-skills
codex plugin add e-comet-skills@e-comet-skills
```

После обновления начните новую задачу.

</details>

## FAQ

### Зачем нужно расширение?

Для надёжного выполнения запросов к Wildberries через браузер. Без расширения Wildberries может блокировать запросы или возвращать неполную информацию.

## Устранение неполадок

Если живые данные Wildberries не загружаются, проверьте, что:

- Chrome запущен
- расширение e-Comet установлено и активировано
- открыта вкладка Wildberries, залогиненная под вашим аккаунтом
- Node.js 22 или новее доступен в `PATH`

Если проблема повторяется — обратитесь в поддержку e-Comet (виджет на сайте) или [создайте тикет](https://github.com/e-comet/skills/issues), указав:
- ИИ-агент с платформой
- Промпт
- Ожидаемый результат
- Фактический результат
