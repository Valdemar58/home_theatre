import "server-only";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { env } from "./env";
import { cacheClassOf } from "@/lib/freshness";
import { kindInfo } from "@/lib/notice-kinds";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  jellyfin_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  shiki_user_id INTEGER,
  shiki_nickname TEXT,
  shiki_access TEXT,
  shiki_refresh TEXT,
  shiki_expires INTEGER,
  shiki_synced_at INTEGER,
  shiki_error TEXT,
  created_at INTEGER NOT NULL
);

-- Кэш ответов внешних API (AniList, Seerr...) с TTL
CREATE TABLE IF NOT EXISTS cache (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Русские названия из Shikimori (ID Shikimori = MAL ID)
CREATE TABLE IF NOT EXISTS titles_ru (
  mal_id INTEGER PRIMARY KEY,
  russian TEXT,
  score REAL,
  fetched_at INTEGER NOT NULL
);

-- Снимки тайтлов для страницы списков
CREATE TABLE IF NOT EXISTS media (
  anilist_id INTEGER PRIMARY KEY,
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS list_entries (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  anilist_id INTEGER NOT NULL,
  mal_id INTEGER,
  status TEXT NOT NULL,
  waiting INTEGER NOT NULL DEFAULT 0,
  episodes INTEGER NOT NULL DEFAULT 0,
  score INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  -- синхронизация с Shikimori
  shiki_rate_id INTEGER,
  shiki_updated_at INTEGER,
  dirty INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, anilist_id)
);
CREATE INDEX IF NOT EXISTS list_entries_mal ON list_entries(user_id, mal_id);
`;

// Встроенный в Node модуль node:sqlite: не нужна нативная сборка (better-sqlite3 при установке
// компилировался и падал на медленной сети). Тонкий адаптер повторяет используемую часть API.
type Param = null | number | bigint | string | Uint8Array;
export type Statement<P extends unknown[], R> = {
  get(...params: P): R | undefined;
  all(...params: P): R[];
  run(...params: P): { changes: number | bigint; lastInsertRowid: number | bigint };
};
export type Db = {
  prepare<P extends unknown[] = unknown[], R = unknown>(sql: string): Statement<P, R>;
  exec(sql: string): void;
  transaction<T>(fn: () => T): () => T;
};

function wrap(raw: DatabaseSync): Db {
  return {
    prepare<P extends unknown[], R>(sql: string): Statement<P, R> {
      const s = raw.prepare(sql);
      return {
        get: (...p) => s.get(...(p as Param[])) as R | undefined,
        all: (...p) => s.all(...(p as Param[])) as R[],
        run: (...p) => s.run(...(p as Param[])),
      };
    },
    exec: (sql) => raw.exec(sql),
    transaction: (fn) => () => {
      raw.exec("BEGIN");
      try {
        const result = fn();
        raw.exec("COMMIT");
        return result;
      } catch (err) {
        raw.exec("ROLLBACK");
        throw err;
      }
    },
  };
}

function open(): Db {
  fs.mkdirSync(env.dataDir, { recursive: true });
  const db = wrap(new DatabaseSync(path.join(env.dataDir, "anime-calendar.db")));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Изменения схемы для уже существующих баз. */
function migrate(db: Db) {
  const columns = (table: string) =>
    new Set(db.prepare<[], { name: string }>(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  // Оценка MAL (из Shikimori) рядом с русским названием
  if (!columns("titles_ru").has("score")) db.exec("ALTER TABLE titles_ru ADD COLUMN score REAL");
  // Кэш стал хранилищем: класс записи (entity — не удаляется, listing, volatile) и когда получено
  const cacheCols = columns("cache");
  if (!cacheCols.has("class")) {
    db.exec("ALTER TABLE cache ADD COLUMN class TEXT NOT NULL DEFAULT 'volatile'");
    db.exec("ALTER TABLE cache ADD COLUMN fetched_at INTEGER");
    const set = db.prepare<[string, string]>("UPDATE cache SET class = ? WHERE key = ?");
    db.transaction(() => {
      for (const { key } of db.prepare<[], { key: string }>("SELECT key FROM cache").all()) set.run(cacheClassOf(key), key);
    })();
  }
  // Впечатления о тайтле: заметка, личные теги («так плохо, что смешно»), студия озвучки
  const entryCols = columns("list_entries");
  if (!entryCols.has("note")) db.exec("ALTER TABLE list_entries ADD COLUMN note TEXT");
  if (!entryCols.has("tags")) db.exec("ALTER TABLE list_entries ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'");
  if (!entryCols.has("voice")) db.exec("ALTER TABLE list_entries ADD COLUMN voice TEXT");
  // «Рекомендую к просмотру»: 1 — да, 0 — нет, NULL — не выбрано (локально, в Shikimori не уходит)
  if (!entryCols.has("recommend")) db.exec("ALTER TABLE list_entries ADD COLUMN recommend INTEGER");
  // Сколько серий было вышедшими при последней отметке: «+N новых» — только вышедшие после неё
  if (!entryCols.has("aired_mark")) db.exec("ALTER TABLE list_entries ADD COLUMN aired_mark INTEGER");
  // Синхронизация с AniLib: профиль пользователя (по публичным закладкам)
  const userCols = columns("users");
  if (!userCols.has("lib_user_id")) db.exec("ALTER TABLE users ADD COLUMN lib_user_id INTEGER");
  if (!userCols.has("lib_nickname")) db.exec("ALTER TABLE users ADD COLUMN lib_nickname TEXT");
  if (!userCols.has("lib_synced_at")) db.exec("ALTER TABLE users ADD COLUMN lib_synced_at INTEGER");
  if (!userCols.has("lib_error")) db.exec("ALTER TABLE users ADD COLUMN lib_error TEXT");
  // ИИ-апскейл: цель (ширина), под которую делали — карточке хватает меньшего, шапке нужно больше
  if (columns("img_upscale").size && !columns("img_upscale").has("target")) db.exec("ALTER TABLE img_upscale ADD COLUMN target INTEGER");
  // Отметка серий по просмотру в Jellyfin: до какого момента история уже разобрана
  if (!userCols.has("jf_played_at")) db.exec("ALTER TABLE users ADD COLUMN jf_played_at INTEGER");
  // Друзья: кому виден профиль и списки (all / friends / private); отдельный тайтл можно скрыть
  if (!userCols.has("visibility")) db.exec("ALTER TABLE users ADD COLUMN visibility TEXT NOT NULL DEFAULT 'friends'");
  if (!entryCols.has("private")) db.exec("ALTER TABLE list_entries ADD COLUMN private INTEGER NOT NULL DEFAULT 0");
  // Профиль: свой баннер (тайтл) и витрина наград (id через запятую; пусто — самые прокачанные)
  if (!userCols.has("profile_banner")) db.exec("ALTER TABLE users ADD COLUMN profile_banner INTEGER");
  if (!userCols.has("showcase")) db.exec("ALTER TABLE users ADD COLUMN showcase TEXT");
  // «Зал славы»: выбранные тайтлы (до 10; пусто — лучшие по оценке)
  if (!userCols.has("hall")) db.exec("ALTER TABLE users ADD COLUMN hall TEXT");
  db.exec(`
    -- Кэш картинок на диске (DATA_DIR/img-cache): оригинал и уменьшенные копии
    CREATE TABLE IF NOT EXISTS img_cache (
      key TEXT NOT NULL,
      variant TEXT NOT NULL,
      url TEXT NOT NULL,
      file TEXT NOT NULL,
      content_type TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      last_access INTEGER NOT NULL,
      PRIMARY KEY (key, variant)
    );
    -- Тайтл AniLib ↔ AniList и снимок того, что AniLib отдавал при прошлой синхронизации
    -- (по снимку видно, кто что изменил: AniLib, календарь или оба — тогда главнее календарь)
    CREATE TABLE IF NOT EXISTS lib_links (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      lib_media_id INTEGER NOT NULL,
      anilist_id INTEGER,
      how TEXT NOT NULL,
      snap_status TEXT,
      snap_episodes INTEGER,
      snap_score INTEGER,
      synced_at INTEGER,
      PRIMARY KEY (user_id, lib_media_id)
    );`);
  db.exec(`
    -- Профиль тайтла для рекомендаций: данные AniList, анализ LLM, эмбеддинг
    CREATE TABLE IF NOT EXISTS anime_profile (
      anilist_id INTEGER PRIMARY KEY,
      data TEXT NOT NULL,
      analysis TEXT,
      analysis_v INTEGER,
      embedding BLOB,
      embed_v TEXT,
      updated_at INTEGER NOT NULL
    );
    -- ИИ-апскейл картинок: состояние по каждой (ключ — как в img_cache)
    CREATE TABLE IF NOT EXISTS img_upscale (
      key TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      state TEXT NOT NULL,
      model TEXT,
      scale INTEGER,
      src_w INTEGER,
      out_w INTEGER,
      ms INTEGER,
      error TEXT,
      target INTEGER,
      updated_at INTEGER NOT NULL
    );
    -- Фоновые задачи (поиск озвучек и т. п.): очередь, дедупликация, отмена. waiters — кто ждёт результат
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      key TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      origin TEXT NOT NULL,
      waiters TEXT NOT NULL DEFAULT '[]',
      error TEXT,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS tasks_by_key ON tasks (kind, key, id);
    -- Уведомления пользователя (колокольчик в шапке; новые — ещё и тостом)
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      href TEXT,
      created_at INTEGER NOT NULL,
      read_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS notifications_by_user ON notifications (user_id, id);
    -- Дружба: заявка from → to; accepted — взаимная (одна строка на пару)
    CREATE TABLE IF NOT EXISTS friendships (
      from_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      to_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (from_id, to_id)
    );
    CREATE INDEX IF NOT EXISTS friendships_to ON friendships (to_id);
    -- Общие списки: участники (invited → member) и тайтлы; статусы участников — живые, из их личных списков
    CREATE TABLE IF NOT EXISTS shared_lists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS shared_list_members (
      list_id INTEGER NOT NULL REFERENCES shared_lists(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      invited_by INTEGER,
      joined_at INTEGER NOT NULL,
      PRIMARY KEY (list_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS shared_list_items (
      list_id INTEGER NOT NULL REFERENCES shared_lists(id) ON DELETE CASCADE,
      anilist_id INTEGER NOT NULL,
      added_by INTEGER,
      added_at INTEGER NOT NULL,
      PRIMARY KEY (list_id, anilist_id)
    );
    CREATE INDEX IF NOT EXISTS shared_list_items_by_title ON shared_list_items (anilist_id);
    -- «Посмотрели вместе»: кто кому что отметил (прежние записи — для отмены)
    CREATE TABLE IF NOT EXISTS watch_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_id INTEGER NOT NULL,
      anilist_id INTEGER NOT NULL,
      changes TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      undone_at INTEGER
    );
    -- Обсуждение под тайтлом: ответы — веткой (parent_id); удалённый с ответами остаётся заглушкой
    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      anilist_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      parent_id INTEGER,
      body TEXT NOT NULL,
      spoiler INTEGER NOT NULL DEFAULT 0,
      episode INTEGER,
      created_at INTEGER NOT NULL,
      edited_at INTEGER,
      deleted INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS comments_by_title ON comments (anilist_id);
    -- «Смотрим вместе с…»: серии, засчитанные владельцу, засчитываются и участникам
    CREATE TABLE IF NOT EXISTS watch_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      anilist_id INTEGER NOT NULL,
      members TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      last_activity INTEGER NOT NULL,
      ended_at INTEGER
    );
    -- Портрет вкуса и готовые рекомендации пользователя
    CREATE TABLE IF NOT EXISTS user_taste (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      list_hash TEXT NOT NULL,
      portrait TEXT,
      recs TEXT,
      updated_at INTEGER NOT NULL
    );
    -- Новые серии: до какой серии уже уведомили (первый проход только запоминает)
    CREATE TABLE IF NOT EXISTS episode_marks (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      anilist_id INTEGER NOT NULL,
      notified INTEGER NOT NULL,
      PRIMARY KEY (user_id, anilist_id)
    );
    -- Полученные уровни наград (уровень не отнимается) и когда получен
    CREATE TABLE IF NOT EXISTS user_achievements (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      tier INTEGER NOT NULL,
      earned_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, id)
    );
    -- Журнал просмотра: сколько серий/минут отмечено и когда (кривая активности в профиле).
    -- Пишется только при реальном просмотре: ручная отметка, Jellyfin, «вместе» — не импорт истории
    CREATE TABLE IF NOT EXISTS watch_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      anilist_id INTEGER NOT NULL,
      episodes INTEGER NOT NULL,
      minutes INTEGER NOT NULL,
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS watch_log_by_user ON watch_log (user_id, at);
    -- Сохранённые наборы фильтров каталога (query — параметры адреса, включая сортировку)
    CREATE TABLE IF NOT EXISTS filter_presets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      query TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    -- Системные настройки, которые меняются в интерфейсе без перезапуска (JSON по ключу, напр. 'llm')
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    -- Каждый вызов LLM (и локальной — с нулевой ценой): расход токенов и денег по задачам
    CREATE TABLE IF NOT EXISTS llm_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      task TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      cache_hit_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      ms INTEGER NOT NULL,
      ok INTEGER NOT NULL,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS llm_usage_at ON llm_usage (at);
    -- Тайтлы, по которым пользователь выключил уведомления о сериях
    CREATE TABLE IF NOT EXISTS notice_mutes (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      anilist_id INTEGER NOT NULL,
      PRIMARY KEY (user_id, anilist_id)
    );
    -- Сюжет от ИИ: синопсис вместо заглушки ('synopsis') и пересказ предыдущих сезонов ('recap');
    -- sources — из чего составлен (для пересказа — id предысторий: сменились — составить заново)
    CREATE TABLE IF NOT EXISTS anime_plot (
      anilist_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      data TEXT,
      sources TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (anilist_id, kind)
    );
    -- Корпус сюжета: тексты о сериях из всех источников, без срока жизни (строки не удаляются:
    -- изменился текст — новая строка, текущая — последняя). ep — номер серии в тайтле AniList;
    -- depth — анонс (teaser) / пересказ (full) / сценарий (script)
    CREATE TABLE IF NOT EXISTS episode_text (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      anilist_id INTEGER NOT NULL,
      ep INTEGER NOT NULL,
      source TEXT NOT NULL,
      lang TEXT NOT NULL,
      depth TEXT NOT NULL,
      title TEXT,
      text TEXT NOT NULL,
      url TEXT,
      license TEXT,
      hash TEXT NOT NULL,
      fetched_at INTEGER NOT NULL,
      aired TEXT,
      UNIQUE (anilist_id, ep, source, hash)
    );`);
  // Дата выхода серии по источнику (YYYY-MM-DD) — проверка сопоставления серий с AniList
  if (!columns("episode_text").has("aired")) db.exec("ALTER TABLE episode_text ADD COLUMN aired TEXT");
  // Отозвано (чужой сезон, сдвинутая серия): строка остаётся в истории, но текущей не считается
  if (!columns("episode_text").has("retracted_at")) db.exec("ALTER TABLE episode_text ADD COLUMN retracted_at INTEGER");
  // Японское название серии по источнику: сверка источников между собой и словарь для перевода
  if (!columns("episode_text").has("title_ja")) db.exec("ALTER TABLE episode_text ADD COLUMN title_ja TEXT");
  // Справочник серий по источникам — и тех, о которых текста нет: дата и названия (эталон, сверка, словарь названий).
  // Производные данные: при новом сборе источника перезаписываются
  db.exec(`CREATE TABLE IF NOT EXISTS episode_meta (
    anilist_id INTEGER NOT NULL,
    ep INTEGER NOT NULL,
    source TEXT NOT NULL,
    aired TEXT,
    title TEXT,
    title_ja TEXT,
    PRIMARY KEY (anilist_id, ep, source)
  )`);
  // Филлер (не по первоисточнику) — по данным MAL: пересказу сезона он не важен
  if (!columns("episode_meta").has("filler")) db.exec("ALTER TABLE episode_meta ADD COLUMN filler INTEGER");
  // Японские субтитры для слабослышащих (Jimaku): файл серии лежит только локально (data/plot/<id>/sdh), здесь — откуда и какой
  db.exec(`CREATE TABLE IF NOT EXISTS sdh_file (
    anilist_id INTEGER NOT NULL,
    ep INTEGER NOT NULL,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    path TEXT NOT NULL,
    hash TEXT NOT NULL,
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY (anilist_id, ep)
  )`);
  // Граф сюжета (идея #79, docs/plot-analysis-design.md): сущности, их имена и облики, появления в тайтлах,
  // отношения со сроком, события с иерархией и связи «почему». У каждой записи — серия раскрытия (revealed_ep):
  // по ней курсор зрителя прячет то, что он ещё не видел. Пока заполняются только персонажи из AniList
  db.exec(`CREATE TABLE IF NOT EXISTS plot_entity (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    anilist_char_id INTEGER UNIQUE,
    name TEXT NOT NULL,
    name_ru TEXT,
    name_ja TEXT,
    image TEXT,
    data TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS plot_alias (
    entity_id INTEGER NOT NULL,
    alias TEXT NOT NULL,
    lang TEXT,
    anilist_id INTEGER,
    from_ep INTEGER,
    to_ep INTEGER,
    revealed_ep INTEGER,
    source TEXT NOT NULL,
    PRIMARY KEY (entity_id, alias, anilist_id)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS plot_appearance (
    entity_id INTEGER NOT NULL,
    anilist_id INTEGER NOT NULL,
    role TEXT,
    first_ep INTEGER,
    last_ep INTEGER,
    source TEXT NOT NULL,
    PRIMARY KEY (entity_id, anilist_id)
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS plot_appearance_title ON plot_appearance (anilist_id)");
  db.exec(`CREATE TABLE IF NOT EXISTS plot_relation (
    id INTEGER PRIMARY KEY,
    a INTEGER NOT NULL,
    b INTEGER NOT NULL,
    kind TEXT NOT NULL,
    label TEXT,
    anilist_id INTEGER NOT NULL,
    from_ep INTEGER,
    to_ep INTEGER,
    revealed_ep INTEGER,
    context TEXT,
    source TEXT NOT NULL,
    evidence TEXT,
    created_at INTEGER NOT NULL
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS plot_relation_a ON plot_relation (a)");
  db.exec("CREATE INDEX IF NOT EXISTS plot_relation_b ON plot_relation (b)");
  db.exec(`CREATE TABLE IF NOT EXISTS plot_event (
    id INTEGER PRIMARY KEY,
    anilist_id INTEGER NOT NULL,
    parent_id INTEGER,
    level TEXT NOT NULL,
    kind TEXT,
    title TEXT NOT NULL,
    summary TEXT,
    ep_from INTEGER,
    ep_to INTEGER,
    revealed_ep INTEGER,
    source TEXT NOT NULL,
    data TEXT,
    created_at INTEGER NOT NULL
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS plot_event_title ON plot_event (anilist_id)");
  db.exec(`CREATE TABLE IF NOT EXISTS plot_event_participant (
    event_id INTEGER NOT NULL,
    entity_id INTEGER NOT NULL,
    role TEXT,
    PRIMARY KEY (event_id, entity_id)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS plot_event_link (
    from_event INTEGER NOT NULL,
    to_event INTEGER NOT NULL,
    kind TEXT NOT NULL,
    revealed_ep INTEGER,
    source TEXT NOT NULL,
    PRIMARY KEY (from_event, to_event, kind)
  )`);
  // Граф из разбора серий (задача plot_graph): ключ модели → сущность (в пределах франшизы — у сезонов общие ключи),
  // облики с картинкой и серией показа, раскрытия «это один человек», членство в группах, способности,
  // описание персонажа на конец порции; флаги тайтла и выбор зрителя «сюжет на серию N»
  if (!columns("plot_event").has("key")) db.exec("ALTER TABLE plot_event ADD COLUMN key TEXT");
  if (!columns("plot_event").has("major")) db.exec("ALTER TABLE plot_event ADD COLUMN major INTEGER NOT NULL DEFAULT 0");
  db.exec("CREATE INDEX IF NOT EXISTS plot_event_key ON plot_event (anilist_id, key)");
  if (!columns("plot_relation").has("ended_ep")) db.exec("ALTER TABLE plot_relation ADD COLUMN ended_ep INTEGER");
  if (!columns("plot_alias").has("look")) db.exec("ALTER TABLE plot_alias ADD COLUMN look TEXT");
  if (!columns("plot_alias").has("kind")) {
    db.exec("ALTER TABLE plot_alias ADD COLUMN kind TEXT");
    db.exec("ALTER TABLE plot_alias ADD COLUMN who TEXT");
  }
  db.exec(`CREATE TABLE IF NOT EXISTS plot_key (
    root_id INTEGER NOT NULL,
    key TEXT NOT NULL,
    entity_id INTEGER NOT NULL,
    PRIMARY KEY (root_id, key)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS plot_look (
    id INTEGER PRIMARY KEY,
    entity_id INTEGER NOT NULL,
    anilist_id INTEGER NOT NULL,
    look TEXT NOT NULL,
    label TEXT NOT NULL,
    label_en TEXT,
    appearance TEXT,
    kind TEXT NOT NULL,
    from_ep INTEGER NOT NULL,
    source TEXT NOT NULL,
    UNIQUE (entity_id, anilist_id, look)
  )`);
  if (!columns("plot_look").has("appearance")) db.exec("ALTER TABLE plot_look ADD COLUMN appearance TEXT");
  db.exec(`CREATE TABLE IF NOT EXISTS plot_image (
    entity_id INTEGER NOT NULL,
    url TEXT NOT NULL,
    source TEXT NOT NULL,
    label TEXT,
    look TEXT,
    anilist_id INTEGER,
    from_ep INTEGER,
    checked TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (entity_id, url)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS plot_identity (
    a INTEGER NOT NULL,
    b INTEGER NOT NULL,
    anilist_id INTEGER NOT NULL,
    revealed_ep INTEGER NOT NULL,
    note TEXT,
    source TEXT NOT NULL,
    PRIMARY KEY (a, b, anilist_id)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS plot_member (
    entity_id INTEGER NOT NULL,
    group_id INTEGER NOT NULL,
    anilist_id INTEGER NOT NULL,
    role TEXT,
    from_ep INTEGER NOT NULL,
    to_ep INTEGER,
    source TEXT NOT NULL
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS plot_member_title ON plot_member (anilist_id)");
  db.exec(`CREATE TABLE IF NOT EXISTS plot_ability (
    entity_id INTEGER NOT NULL,
    anilist_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    text TEXT,
    status TEXT NOT NULL,
    from_ep INTEGER NOT NULL,
    source TEXT NOT NULL
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS plot_ability_entity ON plot_ability (entity_id)");
  db.exec(`CREATE TABLE IF NOT EXISTS plot_note (
    entity_id INTEGER NOT NULL,
    anilist_id INTEGER NOT NULL,
    up_to INTEGER NOT NULL,
    description TEXT NOT NULL,
    goal TEXT,
    PRIMARY KEY (entity_id, anilist_id, up_to)
  )`);
  // Места (сущность kind = 'place'): вид, во что вложено, с какой серии; связи «к северу от», «три дня пути»
  db.exec(`CREATE TABLE IF NOT EXISTS plot_place (
    entity_id INTEGER NOT NULL,
    anilist_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    inside_id INTEGER,
    from_ep INTEGER NOT NULL,
    source TEXT NOT NULL,
    PRIMARY KEY (entity_id, anilist_id)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS plot_place_link (
    a INTEGER NOT NULL,
    b INTEGER NOT NULL,
    kind TEXT NOT NULL,
    distance TEXT,
    anilist_id INTEGER NOT NULL,
    revealed_ep INTEGER NOT NULL,
    source TEXT NOT NULL
  )`);
  if (!columns("plot_event").has("place_id")) db.exec("ALTER TABLE plot_event ADD COLUMN place_id INTEGER");
  // Карта франшизы (подложка с вики) и подписи на ней (прочитаны моделью со зрением); координаты — доли от 0 до 1
  db.exec(`CREATE TABLE IF NOT EXISTS plot_map (
    root_id INTEGER PRIMARY KEY,
    url TEXT NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    crop TEXT,
    built_at INTEGER NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS plot_map_label (
    root_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL
  )`);
  // Цвет карты вокруг подписи — закрыть подпись будущего места пятном в цвет фона
  if (!columns("plot_map_label").has("color")) db.exec("ALTER TABLE plot_map_label ADD COLUMN color TEXT");
  // Вектор карты (контейнер mapvec): строки подписей с рамками в пикселях обрезки, суша и страны контурами (JSON)
  db.exec(`CREATE TABLE IF NOT EXISTS plot_map_vector (
    root_id INTEGER PRIMARY KEY,
    data TEXT NOT NULL,
    built_at INTEGER NOT NULL
  )`);
  // Локальный архив тайтлов: что сохранено и на каком уровне (card — карточка, page — страница, full — всё,
  // включая серии, персонажей и картинки), когда проверить снова; очередь сохранения с приоритетом
  db.exec(`CREATE TABLE IF NOT EXISTS archive_state (
    anilist_id INTEGER PRIMARY KEY,
    level TEXT NOT NULL,
    saved_at INTEGER NOT NULL,
    next_check INTEGER NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS archive_queue (
    anilist_id INTEGER PRIMARY KEY,
    level TEXT NOT NULL,
    priority INTEGER NOT NULL,
    reason TEXT NOT NULL,
    depth INTEGER NOT NULL DEFAULT 0,
    queued_at INTEGER NOT NULL
  )`);
  // Картинки сохранённых целиком тайтлов не вытесняются при нехватке места
  if (!columns("img_cache").has("pinned")) db.exec("ALTER TABLE img_cache ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
  // Последняя серия, о которой сообщили «можно смотреть» (в библиотеке или «Стриме»); NULL — ещё не смотрели
  if (!columns("episode_marks").has("ready")) db.exec("ALTER TABLE episode_marks ADD COLUMN ready INTEGER");
  // Опенинги и эндинги по звуку (segments.ts): отпечатки начала и конца файла серии и найденные отрезки.
  // Ключ — файл («jf:<элемент Jellyfin>» / «ts:<раздача>:<файл>»): у разных релизов свои тайминги
  db.exec(`CREATE TABLE IF NOT EXISTS episode_fp (
    item_key TEXT PRIMARY KEY,
    dur REAL NOT NULL,
    head TEXT NOT NULL,
    tail TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS episode_segments (
    item_key TEXT NOT NULL,
    anilist_id INTEGER NOT NULL,
    ep INTEGER NOT NULL,
    kind TEXT NOT NULL,
    start_s REAL NOT NULL,
    end_s REAL NOT NULL,
    source TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (item_key, kind)
  )`);
  // Субтитры из других раздач (кнопка в «Озвучках»): серия тайтла → файл раздачи; сами файлы — stream-subs/<хэш>
  db.exec(`CREATE TABLE IF NOT EXISTS release_subs (
    anilist_id INTEGER NOT NULL,
    hash TEXT NOT NULL,
    title TEXT NOT NULL,
    episodes TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (anilist_id, hash)
  )`);
  // Плеер календаря: где остановился в серии (продолжить с того же места)
  db.exec(`CREATE TABLE IF NOT EXISTS playback_pos (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    anilist_id INTEGER NOT NULL,
    ep INTEGER NOT NULL,
    pos REAL NOT NULL,
    dur REAL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, anilist_id, ep)
  )`);
  // Точка места на карте: по подписи (label), внутри родителя (inside) или вручную (manual)
  db.exec(`CREATE TABLE IF NOT EXISTS plot_place_pos (
    entity_id INTEGER NOT NULL,
    root_id INTEGER NOT NULL,
    x REAL NOT NULL, y REAL NOT NULL,
    how TEXT NOT NULL,
    label TEXT,
    PRIMARY KEY (entity_id, root_id)
  )`);
  // Лента имён: как зритель зовёт персонажа с какой серии (безымянный генерал → «Гельд» с серии, где ему дали имя)
  db.exec(`CREATE TABLE IF NOT EXISTS plot_name (
    entity_id INTEGER NOT NULL,
    anilist_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    from_ep INTEGER NOT NULL,
    source TEXT NOT NULL
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS plot_name_entity ON plot_name (entity_id)");
  db.exec(`CREATE TABLE IF NOT EXISTS plot_title (
    anilist_id INTEGER PRIMARY KEY,
    group_word TEXT,
    power_system INTEGER NOT NULL DEFAULT 0,
    up_to INTEGER NOT NULL,
    built_at INTEGER NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS plot_view (
    user_id INTEGER NOT NULL,
    anilist_id INTEGER NOT NULL,
    mode TEXT NOT NULL,
    ep INTEGER,
    PRIMARY KEY (user_id, anilist_id)
  )`);
  // Уведомления: вкладка, тайтл (обложка), автор (аватар), подпись и действия
  const noticeCols = columns("notifications");
  if (!noticeCols.has("grp")) {
    db.exec("ALTER TABLE notifications ADD COLUMN grp TEXT");
    db.exec("ALTER TABLE notifications ADD COLUMN anilist_id INTEGER");
    db.exec("ALTER TABLE notifications ADD COLUMN actor_id INTEGER");
    db.exec("ALTER TABLE notifications ADD COLUMN data TEXT");
    const rows = db.prepare<[], { id: number; kind: string; title: string }>("SELECT id, kind, title FROM notifications").all();
    for (const r of rows) {
      const error = r.title.endsWith("не получилось");
      db.prepare("UPDATE notifications SET grp = ?, data = ? WHERE id = ?")
        .run(kindInfo(r.kind, error).group, JSON.stringify({ error }), r.id);
    }
    db.exec("CREATE INDEX IF NOT EXISTS notifications_by_group ON notifications (user_id, grp, id)");
  }
  // Награды — своя вкладка «Достижения»
  db.exec("UPDATE notifications SET grp = 'achievements' WHERE kind = 'achievement' AND grp != 'achievements'");
  // Старые итоги задач «Озвучки: «Тайтл»» → тайтл — отдельной строкой (обложка), текст — что найдено
  const legacy = db.prepare<[], { id: number; title: string; body: string | null; data: string | null }>(
    `SELECT id, title, body, data FROM notifications WHERE kind IN ('voices', 'prebuffer') AND title LIKE '%: «%' AND (data IS NULL OR data NOT LIKE '%subject%')`).all();
  for (const r of legacy) {
    const m = /^(.+?): «(.+)»( — не получилось)?$/.exec(r.title);
    if (!m) continue;
    const error = Boolean(m[3]);
    db.prepare("UPDATE notifications SET title = ?, body = ?, data = ? WHERE id = ?").run(
      error ? `${m[1]} — не получилось` : (r.body ?? m[1]), error ? r.body : null,
      JSON.stringify({ ...(r.data ? JSON.parse(r.data) : {}), subject: m[2], error }), r.id);
  }
  migrateLlmOutputs(db);
}

/** Результаты LLM без срока жизни: журнал (строки не удаляются) + провенанс текущего значения. */
export function migrateLlmOutputs(db: Db) {
  const columns = (table: string) =>
    new Set(db.prepare<[], { name: string }>(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  db.exec(`
    -- Все результаты LLM: задача, о чём (anime:1 | tag:X | user:1 | user:1:anime:2 | cluster:<ids>),
    -- версии схемы/промпта, хэш смыслового входа, кто сделал (провайдер, модель, ранг качества)
    CREATE TABLE IF NOT EXISTS llm_output (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task TEXT NOT NULL,
      subject TEXT NOT NULL,
      schema_v INTEGER NOT NULL,
      prompt_v INTEGER NOT NULL,
      input_hash TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      tier INTEGER NOT NULL,
      value TEXT NOT NULL,
      usage_id INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS llm_output_subject ON llm_output (task, subject, created_at);
    -- Темы из разборов, склеенные по смыслу (эмбеддинги bge-m3): «дружба» и «сила дружбы» → одна тема
    CREATE TABLE IF NOT EXISTS theme_canon (
      theme TEXT PRIMARY KEY,
      canon TEXT NOT NULL,
      embedding BLOB
    );`);
  const profCols = columns("anime_profile");
  if (!profCols.has("analysis_src")) {
    db.exec("ALTER TABLE anime_profile ADD COLUMN analysis_src INTEGER");
    db.exec("ALTER TABLE anime_profile ADD COLUMN analysis_tier INTEGER");
    db.exec("ALTER TABLE anime_profile ADD COLUMN analysis_hash TEXT");
  }
  if (!columns("anime_plot").has("tier")) {
    db.exec("ALTER TABLE anime_plot ADD COLUMN src INTEGER");
    db.exec("ALTER TABLE anime_plot ADD COLUMN tier INTEGER");
  }
  if (!columns("user_taste").has("portrait_hash")) db.exec("ALTER TABLE user_taste ADD COLUMN portrait_hash TEXT");

  // Перенос того, что сделано до журнала: модель неизвестна — «legacy», ранг как у локальной, хэш входа пустой
  // (пустой хэш считается совпадающим: старые результаты остаются в работе, а не пересчитываются)
  const has = (task: string) => Boolean(db.prepare("SELECT 1 FROM llm_output WHERE task = ? LIMIT 1").get(task));
  const legacyModel = process.env.LLM_MODEL ?? "qwen3.5:9b";
  const put = db.prepare<[string, string, number, string, number]>(
    `INSERT INTO llm_output (task, subject, schema_v, prompt_v, input_hash, provider, model, tier, value, created_at)
     VALUES (?, ?, ?, 1, '', 'legacy', '${legacyModel.replace(/'/g, "")}', 1, ?, ?)`);
  db.transaction(() => {
    if (!has("analysis")) {
      const rows = db.prepare<[], { anilist_id: number; analysis: string; analysis_v: number | null; updated_at: number }>(
        "SELECT anilist_id, analysis, analysis_v, updated_at FROM anime_profile WHERE analysis IS NOT NULL").all();
      for (const r of rows) {
        const id = Number(put.run("analysis", `anime:${r.anilist_id}`, r.analysis_v ?? 1, r.analysis, r.updated_at).lastInsertRowid);
        db.prepare("UPDATE anime_profile SET analysis_src = ?, analysis_tier = 1, analysis_hash = '' WHERE anilist_id = ?").run(id, r.anilist_id);
      }
      // Полный эмбеддинг «<модель>:1» → «<модель>:a<id анализа>»: не пересчитывать векторы
      db.exec(`UPDATE anime_profile SET embed_v = substr(embed_v, 1, length(embed_v) - 2) || ':a' || analysis_src
        WHERE embed_v LIKE '%:1' AND analysis_src IS NOT NULL`);
    }
    if (!has("synopsis") && !has("recap")) {
      const rows = db.prepare<[], { anilist_id: number; kind: string; text: string; data: string | null; sources: string | null; updated_at: number }>(
        "SELECT anilist_id, kind, text, data, sources, updated_at FROM anime_plot WHERE text != ''").all();
      for (const r of rows) {
        if (r.kind === "synopsis" && r.sources === "tmdb") {
          db.prepare("UPDATE anime_plot SET tier = 4 WHERE anilist_id = ? AND kind = 'synopsis'").run(r.anilist_id);
          continue;
        }
        const value = r.kind === "recap"
          ? JSON.stringify({ recap_ru: r.text, ...(r.data ? JSON.parse(r.data) : {}), sources: r.sources })
          : JSON.stringify({ synopsis_ru: r.text });
        const id = Number(put.run(r.kind, `anime:${r.anilist_id}`, 1, value, r.updated_at).lastInsertRowid);
        db.prepare("UPDATE anime_plot SET src = ?, tier = 1 WHERE anilist_id = ? AND kind = ?").run(id, r.anilist_id, r.kind);
      }
    }
    if (!has("portrait")) {
      const rows = db.prepare<[], { user_id: number; list_hash: string; portrait: string | null; updated_at: number }>(
        "SELECT user_id, list_hash, portrait, updated_at FROM user_taste WHERE portrait IS NOT NULL").all();
      for (const r of rows) {
        put.run("portrait", `user:${r.user_id}`, 1, r.portrait!, r.updated_at);
        db.prepare("UPDATE user_taste SET portrait_hash = list_hash WHERE user_id = ?").run(r.user_id);
      }
    }
    if (!has("tags")) {
      const row = db.prepare<[], { value: string }>("SELECT value FROM cache WHERE key = 'tags-ru:v1'").get();
      const map = row ? (JSON.parse(row.value) as Record<string, string>) : {};
      for (const [en, ru] of Object.entries(map)) put.run("tags", `tag:${en}`, 1, JSON.stringify({ ru }), Math.floor(Date.now() / 1000));
    }
  })();
}

// Один экземпляр на процесс (и переживает HMR в dev). Открывается лениво:
// при сборке Next.js импортирует модули в воркерах, и база там не нужна.
const g = globalThis as unknown as { __db?: Db };
const instance = () => g.__db ?? (g.__db = open());

export const db = new Proxy({} as Db, {
  get(_target, prop) {
    const real = instance();
    const value = Reflect.get(real, prop);
    return typeof value === "function" ? value.bind(real) : value;
  },
});

/** Подготовленный запрос, который создаётся при первом использовании. */
export function stmt<P extends unknown[] = unknown[], R = unknown>(sql: string) {
  let s: Statement<P, R> | undefined;
  return () => (s ??= instance().prepare<P, R>(sql));
}

export const now = () => Math.floor(Date.now() / 1000);
