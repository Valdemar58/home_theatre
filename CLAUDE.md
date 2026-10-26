# Домашний кинотеатр — контекст для Claude

Общение с пользователем — **на русском**. Комментарии в коде — на русском, в стиле окружающего кода.

## Что это

Домашний кинотеатр на Docker Compose, разворачивается одной командой на новой машине (цель — Linux-мини-сервер / Linux-раздел dualboot):

| Сервис | Порт | Назначение |
|---|---|---|
| jellyfin | 8096 | медиасервер; библиотеки «Аниме», «Сериалы», «Фильмы», **«Стрим»** (`/data/media/stream`, .strm-файлы) |
| seerr | 5055 | запросы фильмов/сериалов |
| anime-calendar | 5056 | **свой сервис** `apps/anime-calendar` (Next.js 16), основная разработка идёт здесь |
| sonarr / radarr / prowlarr / bazarr | 8989 / 7878 / 9696 / 6767 | *arr-стек |
| qbittorrent | `${QBIT_WEBUI_PORT:-8090}` | торрент-клиент |
| flaresolverr | 8191 | обход Cloudflare для RuTracker |
| torrserver | 8092 (наружу), 6882 tcp/udp пиры | стриминг из торрента без скачивания |
| ollama | 11434 | локальная LLM (`qwen3.5:9b`) + эмбеддинги (`bge-m3`) |
| upscaler | — (внутри сети) | ИИ-апскейл картинок (Real-ESRGAN ncnn-vulkan, `apps/upscaler`); профиль `upscaler` (`COMPOSE_PROFILES`), без него всё работает |
| recyclarr | профиль `tools` | профили качества из TRaSH |

Оверрайды: `compose.nvidia.yml` (GPU для jellyfin и ollama), `compose.intel.yml`, `compose.vpn.yml`.

Скрипты (`scripts/`):
- `init.py` — создаёт каталоги `config/*`, `data/*` (включая `media/stream`), генерирует ключи в `.env`;
- `bootstrap.py` — настраивает всё через API: `--only <шаг>`; шаги: qbittorrent, sonarr, radarr, prowlarr, recyclarr, formats, jellyfin, bazarr, seerr, torrserver, ollama, anime-calendar;
- `backup.py` — архив конфигов (без `Definitions`, `ollama`, сокетов).
- `split-tunnel/` — раздельное туннелирование (хост): домены из `domains.txt` и трафик контейнеров из `sources.txt` (torrserver 172.25.0.250, qbittorrent .251 — адреса закреплены в compose) идут мимо VPN (подробности — «Сеть и VPN»). Ставит пользователь: `sudo ./split-tunnel.sh install`; `split-tunnel status`, `split-tunnel check <домен>`.
- `vpn-endpoint-route/` — обход бага AmneziaVPN 5.0.3 (Linux): служба ищет шлюз по дампу всех маршрутов в буфер 8 КБ; при большом числе Docker-интерфейсов (IPv6-маршруты veth) дамп > 8 КБ → «No default gateway available, skipping exclusion route» → петля в туннеле («sendmmsg: message too long»). Скрипт: `ip rule to <сервер> lookup 1518` + шлюз провайдера в таблице 1518, хук NM обновляет шлюз. Серверы — `endpoints.txt`.

`.env`: `CONFIG_ROOT=./config`, `DATA_ROOT=./data`, `PUID/PGID=1000`, `TZ=Europe/Moscow`, ключи сервисов, `JELLYFIN_ADMIN_USER/PASSWORD`, `RUTRACKER_USER/PASSWORD`, `JELLYFIN_API_KEY`, `ANIME_CALENDAR_TORZNAB_KEY`, `LLM_MODEL`, `EMBED_MODEL`.

## Правила безопасности

- **Никогда не выводить** логин/пароль RuTracker, Jellyfin и прочие секреты из `.env` — только маскировать (`V***`). Скрипты читают `.env` сами.
- Email пользователя не отправлять во внешние сервисы.

## Git

Репозиторий: `https://github.com/Valdemar58/home_theatre` (приватный), ветка `main`.

Сообщения коммитов:
- кратко описывают изменения, простыми предложениями, чтобы легко читалось;
- без подписей и строк соавторства (`Co-Authored-By` и т. п.);
- без длинного тире и двоеточий.

## Решения пользователя (не переспрашивать)

- Русская озвучка в приоритете, с выбором студии; трекеры: RuTracker + публичные. VPN — опционально.
- Английские релизы в Sonarr — «оставить как есть».
- LLM — **только локальная** (Ollama), не Claude/облако.
- Стриминг — **TorrServer + Jellyfin** (просмотр в плеере Jellyfin).
- Время в календаре — в поясе устройства (подпись «МСК», «МСК+2»).
- Списки: локальные + синхронизация с Shikimori; вход через Jellyfin; русские названия — Shikimori; оценки MAL/AniList.

## anime-calendar — устройство

Next.js 16 App Router, Tailwind v4 (`bg-linear-to-*`), TanStack Query, iron-session, SQLite через **`node:sqlite`** (адаптер в `src/server/db.ts`; better-sqlite3 убран — нативная сборка падала).
Docker: `NODE_OPTIONS="--dns-result-order=ipv4first --no-network-family-autoselection --disable-warning=ExperimentalWarning"` (иначе ETIMEDOUT на медленной сети).

- Данные: AniList GraphQL (лимит 30/мин, `src/server/anilist.ts`), Shikimori (`shikimori.io`, GraphQL `russian`, `score`; OAuth OOB), Fribb anime-lists + Anime-Lists XML (anidb → TVDB сезон/сдвиг, `src/server/idmap.ts`).
- Страница тайтла: `AnimeDetailsView.tsx`, галерея/фон — `src/server/media-images.ts` (постер AniList, TMDB через Seerr, скриншоты Shikimori), `Lightbox.tsx`, `NextEpisode.tsx`, `lib/time.ts` (`formatAiring`, `tzLabel`).
- Календарь: `src/components/calendar/` — `CalendarView`, `MonthGrid` (ResizeObserver, «+N»), `WeekView`, `AgendaView`, `DayDrawer`, `QuickFilters`.
- RU-индексатор: `src/server/ru/*` — Torznab для Sonarr, парсинг названий RuTracker, сопоставление с сезонами TVDB, студии озвучки со страниц тем (FlareSolverr-cookie, windows-1251), ассистент импорта, кнопка «Озвучки» (`VoicesButton.tsx`: «Смотреть» / «Скачать»).
- Стриминг: `src/server/stream.ts` — .torrent через Prowlarr → TorrServer `POST /torrent/upload` → .strm в `${STREAM_DIR}/<Title> (year) [tvdbid-X]/Season NN/` → `POST /Library/Media/Updated` в Jellyfin. Авторизация Jellyfin 12: заголовок `Authorization: MediaBrowser Token="<key>"` (X-Emby-Token даёт 401). Очистка — `cleanupStreams()` каждые 30 мин.
- Рекомендации и граф: `src/server/llm.ts` (Ollama, structured outputs, `think:false`, последовательная очередь), `src/server/reco/` — `profile.ts` (профили AniList + LLM-разбор + эмбеддинги), `math.ts` (вектор вкуса, теги, `hybridScore`), `engine.ts` (портрет вкуса, кандидаты, LLM-rerank), `graph.ts` (BFS по рекомендациям + 300 популярных, Louvain, ForceAtlas2 с усилением рёбер внутри кластера — `lib/graph-layout.ts`, LLM-названия кластеров). UI: `RecommendationsView.tsx`, `GraphView.tsx` (sigma v3, живая физика FA2 в воркере, перетаскивание узлов, своя отрисовка hover), `Impressions.tsx` (оценка, теги «так плохо, что смешно», «озвучка решает», студия озвучки, заметка).
- Фоновые задачи и уведомления: `src/server/tasks.ts` (очередь `tasks`, обработчики `HANDLERS`: «voices», «prebuffer»), `src/server/notifications.ts` (`notify({kind, title, anilistId?, actorId?, subject?, actions?, error?})` — текст короткий, тайтл/автор показываются обложкой и аватаром; вкладка `grp` по `lib/notice-kinds.ts`: titles / friends / important), колокольчик/тосты `Notifications.tsx`, карточка `NoticeItem.tsx`, страница `/notifications`; новые серии — `server/episode-notices.ts` (раз в 10 мин, `episode_marks`, выключатель `notice_mutes`). Всплывающая карточка тайтла — `HoverCard.tsx` (`useHoverCard`/`HoverZone`), служебные страницы — `ADMIN_NAV` в `AppShell.tsx`.
- Друзья (заход 4): `src/server/social.ts` (заявки `friendships`, видимость `users.visibility` all/friends/private + `list_entries.private`; проверка — только `visibleTo`/`canSee` из `lib/social-rules.ts`; профиль, «друзья о тайтле», «советуют друзья»), совпадение вкусов — `tasteMatch` в `reco/card.ts`; общие списки и «посмотрели вместе» — `src/server/together.ts` (`shared_lists*`, журнал `watch_events` с отменой, `watch_sessions` «Смотрим вместе», `onProgress` — из PUT списка и `jellyfin-sync`), правила — `lib/together-rules.ts`; обсуждение — `src/server/comments.ts` + `lib/comments-tree.ts`; награды — `lib/achievements.ts` + `server/achievements.ts` (`user_achievements`, уведомление вида `achievement` → вкладка «Достижения»); профиль — RPG (`lib/profile-rpg.ts`, `/api/users/[id]/stats`, `RpgProfile` в `ProfilePrototypes.tsx`, `BadgeTile`, `charts.tsx`), журнал просмотра `watch_log`. Тестовый друг — аккаунт Jellyfin `test-friend` (без библиотек, пароль `TEST_FRIEND_PASSWORD` в `.env`).
- Сюжет: `src/server/plot.ts` (серии TMDB через Seerr → Kitsu, синопсис вместо заглушки: описание сезона TMDB или LLM, «Что было раньше» — таблица `anime_plot`), правила `lib/plot.ts`, UI `Plot.tsx` (`Description`, `Episodes`).
- Карта тайтлов: `src/server/reco/atlas.ts` (общая карта ~6000 тайтлов, `atlas.json` в данных, сборка в фоне), `lib/atlas.ts` (острова, раскладка, пружины), `MapView.tsx` (sigma: размеры в единицах карты, свои слои «туман»/«кольца»/оверлей; наведение и перетаскивание — только на оверлее: любое изменение узлов/редьюсеров в sigma пересчитывает все узлы и рёбра; прозрачность цвета рёбер WebGL не учитывает — смешивать с фоном). Старый граф — `/graph/legacy`.
- Проверки: `npx tsc --noEmit`, `npx vitest run` (179 тестов), скриншоты — puppeteer-core + Chrome (headless считает, что мыши нет: для JS-наведения подменять `matchMedia`, для CSS `hover:` Tailwind v4 — запускать Chrome с `--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4`).

Интерфейс:
- Цвета — только из палитры (`app/globals.css`, превью `/palette`): тон по смыслу (`accent`, `special`, `positive`, `negative`, `warning`, `info`, `neutral`) + вариант (`soft`, `solid`, `outline-tone`, `tone-text`), напр. `className="tone-info soft"`, `<Badge tone="negative">`, `text-positive-300`. Наведение и disabled выводятся формулой — свои цвета для состояний не заводить.
- Никаких `alert` / `confirm` / `prompt`: `useConfirm()` / `useAlert()` из `components/Dialogs.tsx` (страж — тест `no-native-dialogs`).

Известные грабли:
- Правки с обратным слешем (`\b`, `\p{L}`) — только через Edit, не через heredoc/python (портит `\b` → backspace). В JS `\b` не работает с кириллицей — использовать `\p{L}`-lookaround.
- Prowlarr обрезает названия — полное название берём со страницы темы.
- Индексатор Sonarr блокируется после рестарта контейнеров — лечится тестом индексатора.
- MTU: docker-сеть проекта с MTU `${DOCKER_MTU:-1376}` (≤ MTU AmneziaVPN `amn0`); при 1500 TLS из контейнеров виснет (`UND_ERR_CONNECT_TIMEOUT` к Shikimori, 429/блок индексаторов). Менять MTU — только `docker compose down && up -d`.
- Bazarr новых версий требует `audio_only_include` в элементах языкового профиля (иначе HTTP 500) — учтено в `bootstrap.py`.
- На Windows: SQLite-ошибки «locking protocol» у Jellyfin на NTFS-маунте, Docker-диск WSL (`ext4.vhdx`) только растёт — главная причина переезда на Linux.

## Где остановились (2026-10-13)

Работа идёт заходами по **`TASKS.md`** (мой список: задачи, статусы, очередь) из **`IDEAS.md`** (список пользователя: новые замечания вписывать туда же со следующим номером, под каждым пунктом — строка статуса `→ ✅/🔄/📋 … (TASKS N.N)`). Перед каждым заходом — уточнения у пользователя.

- Переезд на Linux завершён (стек с GPU, `DATA_ROOT=./data`, Windows-раздел read-only в `/mnt/windows`).
- **Заход 1 закрыт**, кроме 1.11 (Shikimori: OAuth-приложение можно создать только через сутки после регистрации — ждём ключи `SHIKIMORI_CLIENT_ID/SECRET/APP_NAME`).
- Список admin импортирован из AniLib (100 тайтлов), синхронизация AniLib — карточка в Настройках, раз в 30 мин.
- Звёзды оценки — вариант 4 (временный, пользователь вернётся к дизайну; вариант 1 в `RatingStarsV1.tsx`).
- Заходы 2 и 3 закрыты. **Заход 4 «Друзья»**: 4.1–4.4 готовы (профили, друзья, видимость, вкусы, общие списки, «посмотрели вместе», обсуждение); 4.5 «Награды» — прототип ждёт выбора стиля и правки порогов. Дальше — заход 5 «Манга/ранобе».
- **Заход 7**: часть A (7.1–7.6), 7.7 «Сюжет» и 7.8 «Карта тайтлов» готовы; дальше 7.9 Authentik (часть C).

## Сеть и VPN

- VPN на хосте — AmneziaVPN (сейчас протокол WireGuard, интерфейс `vpn0`; целевой — AmneziaWG, на сервере `awg-quick`). Он ставит свои `ip rule` раньше чужих и подменяет DNS (`/opt/AmneziaVPN/bin/update-resolv-conf.sh`).
- `scripts/split-tunnel/`: трафик к доменам из `domains.txt` и с адресов из `sources.txt` (торрент-контейнеры; адресаты в локальных/docker-сетях не трогаются) помечается fwmark WireGuard `0xca6c` (VPN сам пропускает его мимо туннеля) + своё правило на таблицу 1515; DNS хоста перехватывается в dnsmasq NetworkManager (он ходит к 1.1.1.1 через VPN). **После `install` — `docker compose up -d --force-recreate`**, иначе в контейнерах `EAI_AGAIN`.
- Почему торренты мимо VPN: через VPN ~1,3 МБ/с (серия стрима требует ~1 МБ/с — остановки), напрямую ~31 МБ/с. Подсеть docker закреплена (`172.25.0.0/16`) — смена подсети/адресов требует `docker compose down && up -d`.
- Docker Hub напрямую от провайдера заблокирован — только через VPN (не добавлять в обход). AniLib/AnimeGo — геоблок, только мимо VPN; AnimeGo недоступен вообще.
- Lib-API (`api.cdnlibs.org`) требует браузерные `Referer`/`Origin` (иначе 403), `Site-Id: 5` — AniLib. AniList отклоняет стандартный User-Agent urllib.
- zsh: не называть переменную `path` (связана с `PATH`).
