import "server-only";
import { mediaByMalIds } from "./anilist";
import { db, now, stmt } from "./db";
import { HttpError } from "./http";
import { getRow, getRows, saveMedia, withShikimori, type EntryRow } from "./lists";
import { getUserById, type User } from "./session";
import * as shiki from "./shikimori";

const payload = (r: EntryRow) => ({ status: r.status, episodes: r.episodes, score: r.score });
const ts = (iso: string) => Math.floor(Date.parse(iso) / 1000);

function setUserShiki(userId: number, fields: Record<string, unknown>) {
  const keys = Object.keys(fields);
  db.prepare(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`)
    .run(...keys.map((k) => fields[k]), userId);
}

export function saveTokens(userId: number, t: shiki.Tokens, profile?: { id: number; nickname: string }) {
  setUserShiki(userId, {
    shiki_access: t.access_token,
    shiki_refresh: t.refresh_token,
    shiki_expires: t.created_at + t.expires_in,
    shiki_error: null,
    ...(profile ? { shiki_user_id: profile.id, shiki_nickname: profile.nickname } : {}),
  });
}

export function unlinkShikimori(userId: number) {
  setUserShiki(userId, {
    shiki_access: null, shiki_refresh: null, shiki_expires: null, shiki_user_id: null,
    shiki_nickname: null, shiki_synced_at: null, shiki_error: null,
  });
  db.prepare("UPDATE list_entries SET shiki_rate_id = NULL, shiki_updated_at = NULL, dirty = 1 WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM list_entries WHERE user_id = ? AND deleted = 1").run(userId);
}

/** Действующий access-токен (обновляется за 5 минут до истечения). */
async function accessToken(user: User): Promise<string | null> {
  if (!user.shiki_access || !user.shiki_refresh || !user.shiki_user_id) return null;
  if ((user.shiki_expires ?? 0) > now() + 300) return user.shiki_access;
  try {
    const t = await shiki.refreshTokens(user.shiki_refresh);
    saveTokens(user.id, t);
    return t.access_token;
  } catch (err) {
    if (err instanceof HttpError && (err.status === 400 || err.status === 401)) {
      setUserShiki(user.id, { shiki_access: null, shiki_error: "Доступ к Shikimori отозван, привяжи аккаунт заново" });
    }
    throw err;
  }
}

const updateSynced = stmt(
  `UPDATE list_entries SET shiki_rate_id = ?, shiki_updated_at = ?, dirty = 0 WHERE user_id = ? AND anilist_id = ?`);
const takeRemote = stmt(
  `UPDATE list_entries SET status = ?, episodes = ?, score = ?, waiting = ?, updated_at = ?,
     shiki_rate_id = ?, shiki_updated_at = ?, dirty = 0 WHERE user_id = ? AND anilist_id = ?`);
const hardDelete = stmt("DELETE FROM list_entries WHERE user_id = ? AND anilist_id = ?");

async function pushRow(token: string, user: User, row: EntryRow): Promise<void> {
  if (row.deleted) {
    if (row.shiki_rate_id) {
      await shiki.deleteRate(token, row.shiki_rate_id).catch((e) => {
        if (!(e instanceof HttpError && e.status === 404)) throw e;
      });
    }
    hardDelete().run(user.id, row.anilist_id);
    return;
  }
  if (!row.mal_id) return; // тайтла нет на MAL/Shikimori
  const rate = row.shiki_rate_id
    ? await shiki.updateRate(token, row.shiki_rate_id, payload(row))
    : await shiki.createRate(token, user.shiki_user_id!, row.mal_id, payload(row));
  updateSynced().run(rate.id, ts(rate.updated_at), user.id, row.anilist_id);
}

/** Сразу отправить одно изменение. Ошибка не страшна: запись останется dirty и уйдёт при синхронизации. */
export async function pushEntry(userId: number, anilistId: number): Promise<void> {
  const user = getUserById(userId);
  if (!user) return;
  try {
    const token = await accessToken(user);
    const row = getRow(userId, anilistId);
    if (token && row?.dirty) await pushRow(token, user, row);
  } catch (err) {
    console.warn(`[sync] push ${anilistId}: ${String(err)}`);
  }
}

export type SyncStats = { pushed: number; pulled: number; imported: number; removed: number; skipped: number };

export async function syncUser(user: User): Promise<SyncStats> {
  const stats: SyncStats = { pushed: 0, pulled: 0, imported: 0, removed: 0, skipped: 0 };
  const token = await accessToken(user);
  if (!token) return stats;

  try {
    const remote = new Map((await shiki.listRates(user.shiki_user_id!, token)).map((r) => [r.target_id, r]));

    for (const row of getRows(user.id, true)) {
      const r = row.mal_id ? remote.get(row.mal_id) : undefined;
      if (row.mal_id) remote.delete(row.mal_id);

      if (row.deleted) {
        await pushRow(token, user, row);
        stats.removed++;
        continue;
      }
      if (!row.mal_id) {
        stats.skipped++;
        continue;
      }
      if (!r) {
        if (row.shiki_rate_id && !row.dirty) {
          // Удалено на Shikimori
          hardDelete().run(user.id, row.anilist_id);
          stats.removed++;
        } else {
          await pushRow(token, user, row);
          stats.pushed++;
        }
        continue;
      }
      const remoteTs = ts(r.updated_at);
      if (row.dirty && row.updated_at >= remoteTs) {
        await pushRow(token, user, { ...row, shiki_rate_id: r.id });
        stats.pushed++;
      } else if (remoteTs > (row.shiki_updated_at ?? 0) || row.dirty) {
        const waiting = r.status === "planned" ? row.waiting : 0;
        takeRemote().run(r.status, r.episodes, r.score, waiting, remoteTs, r.id, remoteTs, user.id, row.anilist_id);
        stats.pulled++;
      } else if (row.shiki_rate_id !== r.id) {
        updateSynced().run(r.id, remoteTs, user.id, row.anilist_id);
      }
    }

    // Новое на Shikimori: сопоставляем MAL → AniList и добавляем
    if (remote.size) {
      const media = await withShikimori(await mediaByMalIds([...remote.keys()]));
      saveMedia(media);
      const insert = db.prepare(
        `INSERT OR IGNORE INTO list_entries (user_id, anilist_id, mal_id, status, waiting, episodes, score,
           updated_at, shiki_rate_id, shiki_updated_at, dirty, deleted) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 0, 0)`);
      for (const m of media) {
        const r = remote.get(m.idMal!);
        if (!r) continue;
        insert.run(user.id, m.id, m.idMal, r.status, r.episodes, r.score, ts(r.updated_at), r.id, ts(r.updated_at));
        remote.delete(m.idMal!);
        stats.imported++;
      }
      stats.skipped += remote.size;
    }
    setUserShiki(user.id, { shiki_synced_at: now(), shiki_error: null });
    return stats;
  } catch (err) {
    setUserShiki(user.id, { shiki_error: String(err instanceof Error ? err.message : err).slice(0, 300) });
    throw err;
  }
}

export async function syncAll(): Promise<void> {
  const users = db.prepare<[], User>("SELECT * FROM users WHERE shiki_refresh IS NOT NULL").all();
  for (const user of users) {
    try {
      const s = await syncUser(user);
      console.log(`[sync] ${user.name}: ${JSON.stringify(s)}`);
    } catch (err) {
      console.warn(`[sync] ${user.name}: ${String(err)}`);
    }
  }
}
