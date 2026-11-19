import { prepareDatabase } from "./prepare.mjs";

// Не открываем HTTP и не запускаем фоновые задачи до успешного переноса.
try {
  await prepareDatabase();
  await import("../server.js");
} catch (error) {
  console.error(`Calendar startup stopped: ${error.message}`);
  process.exitCode = 1;
}
