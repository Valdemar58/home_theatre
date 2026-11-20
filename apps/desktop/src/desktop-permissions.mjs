/** Fullscreen belongs to the configured app page, not arbitrary frames or windows. */
export function allowAppFullscreen({ permission, ownWindow, isMainFrame, requestingUrl, server }) {
  if (permission !== "fullscreen" || !ownWindow || isMainFrame !== true) return false;
  try {
    const page = new URL(requestingUrl), app = new URL(server);
    return app.origin !== "null" && page.origin === app.origin && !page.username && !page.password;
  } catch { return false; }
}
