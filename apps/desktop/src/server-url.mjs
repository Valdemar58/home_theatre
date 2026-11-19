export function serverUrl(value, { development = false } = {}) {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error(
      "Укажите только адрес сервера, без пути, пароля и параметров.",
    );
  }
  if (
    url.protocol !== "https:" &&
    !(development && loopback && url.protocol === "http:")
  ) {
    throw new Error(
      "Нужен HTTPS-сервер. HTTP localhost разрешён только в режиме разработки.",
    );
  }
  return url.origin;
}
