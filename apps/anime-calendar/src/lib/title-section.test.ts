import { expect, it } from "vitest";
import { activeTitleSection } from "./title-section";
it("selects the final short section at the document end even below the anchor", () => {
  const sections = [{id:"franchise",top:-200},{id:"similar",top:80},{id:"discussion",top:450}];
  expect(activeTitleSection(sections,160,false)).toBe("similar");
  expect(activeTitleSection(sections,160,true)).toBe("discussion");
});
it("returns to an earlier section when scrolling away from the end", () => {
  expect(activeTitleSection([{id:"overview",top:140},{id:"discussion",top:600}],160,false)).toBe("overview");
  expect(activeTitleSection([],160,true)).toBeUndefined();
});
