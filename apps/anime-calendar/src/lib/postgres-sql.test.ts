import { describe, expect, it } from "vitest";
// @ts-expect-error Shared runtime module is plain JavaScript for Node and worker use.
import { parameters } from "../../database/sql.mjs";
describe("PostgreSQL parameter compiler", () => {
  it("supports positional and repeated numbered parameters", () => {
    expect(parameters("SELECT ? AS a, ?2 AS b, ?2 AS c, ? AS d")).toBe("SELECT $1 AS a, $2 AS b, $2 AS c, $3 AS d");
  });
  it("leaves quoted strings, comments, identifiers and dollar quotes intact", () => {
    expect(parameters("SELECT '?' AS \"?\", $$?$$, ? -- ?\n/* ? */ WHERE x = ?")).toBe("SELECT '?' AS \"?\", $$?$$, $1 -- ?\n/* ? */ WHERE x = $2");
  });
});
