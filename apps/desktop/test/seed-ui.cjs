const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("/data/anime-calendar.db");
db.exec(
  "INSERT OR IGNORE INTO users (id,jellyfin_id,name,created_at) VALUES (1,'fixture-host','m5-fixture',0),(2,'fixture-viewer','viewer-fixture',0); INSERT OR IGNORE INTO shared_lists(id,name,owner_id,created_at) VALUES(1,'M5 · тестовая комната',1,0); INSERT OR IGNORE INTO shared_list_members(list_id,user_id,status,joined_at) VALUES(1,1,'member',0),(1,2,'member',0);",
);
console.log("Synthetic users and room ready");
