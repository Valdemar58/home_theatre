import "server-only";
import { jellyfin } from "./stream";
import { ApiError } from "./route";

type MediaUser = {
  Id: string;
  Policy?: { IsAdministrator?: boolean; IsDisabled?: boolean };
};

/** Media-backend identity is independent of home_theater account roles. */
export async function jellyfinPlaybackUser(
  own: string,
  itemId: string,
): Promise<string> {
  if (!own.startsWith("local:")) {
    const available = await jellyfin(
      `/Items/${encodeURIComponent(itemId)}?userId=${encodeURIComponent(own)}`,
    )
      .then(() => true)
      .catch(() => false);
    if (available) return own;
  }
  const users = await jellyfin<MediaUser[]>("/Users");
  const configured = process.env.JELLYFIN_PLAYBACK_USER_ID;
  const service = users.find(
    (u) =>
      !u.Policy?.IsDisabled &&
      (configured ? u.Id === configured : u.Policy?.IsAdministrator),
  );
  if (!service)
    throw new ApiError(
      503,
      "В Jellyfin нет доступного пользователя для серверного просмотра. Проверьте настройку медиабэкенда.",
    );
  return service.Id;
}
