import "server-only";
import { db } from "./db";
import { ApiError } from "./route";
import { createRoom } from "./rooms";
import { setOwnedGrant } from "./desktop";
import { selectSource } from "./desktop-stream";

/** Carry a personally selected host into a group watch, or leave the original watch intact. */
export function createRoomWithSource(device: string | undefined, ...args: Parameters<typeof createRoom>) {
  if (!device) return createRoom(...args);
  const [user, title, , , , , group] = args;
  if (!group) throw new ApiError(400, "Для совместного просмотра с устройства выберите группу. Личный просмотр сохранён.");
  return db.transaction(() => {
    setOwnedGrant(user.id, device, group.id, title, true);
    const room = createRoom(...args);
    selectSource(user.id, room.id, device);
    return room;
  })();
}
