# e-Comet Skills

Агентские скиллы e-Comet помогают продавцам работать с платформой Wildberries: находить данные, проверять гипотезы,
собирать операционные отчеты и автоматизировать повторяющиеся действия. Они спроектированы как небольшие и надежные
строительные блоки для сложных рабочих процессов продавца.

Скиллы устанавливаются как marketplace-плагин в Claude Cowork и Codex Desktop.

## Быстрый старт (установка за 30 секунд)

### Claude Cowork

В Claude Desktop откройте `Cowork`, затем:

1. Перейдите в `Customize`.
2. Откройте `Plugins`.
3. Нажмите `+` или `Add marketplace`.
4. Выберите установку marketplace из GitHub-репозитория.
5. Вставьте URL: `https://github.com/e-comet/skills`.
6. Откройте marketplace `e-comet-skills`.
7. Установите плагин `e-Comet Skills`.

Важно: для работы с Wildberries включите сетевой доступ:

```text
Settings > Capabilities > Allow network egress > Domain allowlist > All domains
```

Без этого скиллы не смогут обращаться к сайту Wildberries и CDN-ресурсам WB. Если настройка управляется организацией,
попросите администратора включить ее для вашей команды.

### Codex Desktop

В Codex Desktop откройте каталог плагинов, затем:

1. Добавьте marketplace из GitHub URL: `https://github.com/e-comet/skills`.
2. Выберите marketplace `e-comet-skills`.
3. Установите плагин `e-Comet Skills`.
4. Начните новый тред, чтобы Codex загрузил установленные скиллы.

Если в вашей версии Codex Desktop нет кнопки добавления marketplace, добавьте его один раз через CLI:

```bash
codex plugin marketplace add e-comet/skills --ref main
```

После этого установите `e-Comet Skills` из каталога плагинов в Codex Desktop.

## Список скиллов

wb-product-images - получение URL фото артикулов ВБ

## Ошибки / не работает скилл?

Создайте issue на github с детальным описанием:
- Название ИИ-платформы
- Последовательность шагов для воспроизведения (конкретный пример)
- Ожидание
- Реальность
