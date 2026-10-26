import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

// Системные alert/confirm/prompt не используем — только окна из components/Dialogs.tsx (useConfirm / useAlert).

const SRC = path.join(__dirname, "..");
const NATIVE = /\bwindow\.(alert|confirm|prompt)\(|(?<![.\w])(alert|confirm|prompt)\(\s*["'`]/;

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : files(p);
    return /\.tsx?$/.test(e.name) && !e.name.endsWith(".test.ts") ? [p] : [];
  });
}

it("нет системных alert/confirm/prompt", () => {
  const found = files(SRC).flatMap((f) => fs.readFileSync(f, "utf8").split("\n")
    .map((line, i) => (NATIVE.test(line) ? `${path.relative(SRC, f)}:${i + 1}: ${line.trim()}` : null))
    .filter((x): x is string => x !== null));
  expect(found).toEqual([]);
});
