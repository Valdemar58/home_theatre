// Переводит только параметры. SQL-диалект в доменных модулях уже PostgreSQL.
export function parameters(sql) {
  let next = 0, result = "", i = 0;
  while (i < sql.length) {
    const rest = sql.slice(i);
    const dollar = /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.exec(rest)?.[0];
    if (dollar) {
      const end = sql.indexOf(dollar, i + dollar.length);
      if (end < 0) throw new Error("Unterminated SQL dollar quote");
      result += sql.slice(i, end + dollar.length); i = end + dollar.length; continue;
    }
    if (rest.startsWith("--")) { const end = sql.indexOf("\n", i); if (end < 0) { result += rest; break; } result += sql.slice(i, end); i = end; continue; }
    if (rest.startsWith("/*")) { const end = sql.indexOf("*/", i + 2); if (end < 0) throw new Error("Unterminated SQL comment"); result += sql.slice(i, end + 2); i = end + 2; continue; }
    const c = sql[i++]; result += c;
    if (c === "'" || c === '"') {
      while (i < sql.length) {
        const n = sql[i++]; result += n;
        if (n === c) { if (sql[i] === c) result += sql[i++]; else break; }
      }
    } else if (c === "?") {
      const number = /^\d+/.exec(sql.slice(i))?.[0];
      const index = number ? Number(number) : next + 1;
      next = Math.max(next, index); i += number?.length ?? 0;
      result = result.slice(0, -1) + "$" + index;
    }
  }
  return result;
}
