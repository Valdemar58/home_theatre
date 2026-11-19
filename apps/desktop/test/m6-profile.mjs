// Manual integration fixture only; never packaged. Uses synthetic credentials.
import { app, safeStorage } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
const profile = process.env.HOME_THEATER_TEST_PROFILE;
if (!profile) throw new Error("Fixture profile required");
app.setPath("userData", profile);
app.whenReady().then(async () => {
  const fixture = JSON.parse(await readFile(join(profile, "fixture.json"), "utf8"));
  await writeFile(join(profile, "host.json"), JSON.stringify({ server: "http://127.0.0.1:5058", approved: true, secret: safeStorage.encryptString(fixture.token).toString("base64") }));
  app.quit();
}).catch(e => { console.error(e.message); app.exit(1); });
