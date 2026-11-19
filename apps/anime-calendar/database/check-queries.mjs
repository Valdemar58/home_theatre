// Проверка всего статического SQL приложения настоящим парсером PostgreSQL, без выполнения запросов.
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { createClient } from "./connection.mjs";
import { parameters } from "./sql.mjs";
const queries = [];
function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    if (fs.statSync(file).isDirectory()) { walk(file); continue; }
    if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
    const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    function visit(node) {
      if (ts.isCallExpression(node) && node.arguments[0] &&
          ((ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "prepare") ||
           (ts.isIdentifier(node.expression) && node.expression.text === "stmt"))) {
        const arg = node.arguments[0];
        if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) queries.push({ file, sql: parameters(arg.text) });
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
}
walk(path.resolve("src/server"));
const client = createClient();
await client.connect();
let errors = 0;
try {
  for (const { file, sql } of queries) {
    const count = Math.max(0, ...[...sql.matchAll(/\$(\d+)/g)].map(m => Number(m[1])));
    try { await client.query("EXPLAIN " + sql, new Array(count).fill(null)); }
    catch (error) { errors++; console.error(`${path.relative(process.cwd(),file)}: ${error.message}\n${sql}`); }
  }
} finally { await client.end(); }
if (errors) throw new Error(`${errors} of ${queries.length} static PostgreSQL queries failed validation`);
console.log(`Validated ${queries.length} static queries against PostgreSQL`);
