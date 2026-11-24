// @vitest-environment jsdom
// T-WEB-14 (specs/017 research R8): the portal answers 200 with the page only for the web app's screens, from the
// table in src/shared/portal-screens.ts. The web app's own matcher stays in routes.ts; this keeps the two equal.
import { describe, expect, it } from "vitest";
import { PORTAL_SCREENS, isScreenPath } from "../../../src/shared/portal-screens.js";
import { SCREEN_NEEDS, matchRoute } from "../src/routes.js";

describe("T-WEB-14 the portal's screen table is the web app's screens", () => {
  it("T-WEB-14 every screen but not-found has exactly one row, and each row's example opens that screen", () => {
    const names = Object.keys(SCREEN_NEEDS).filter((n) => n !== "not-found").sort();
    expect(PORTAL_SCREENS.map((r) => r.name).sort()).toEqual(names);
    for (const row of PORTAL_SCREENS) {
      expect(matchRoute(row.example).name, row.example).toBe(row.name);
      expect(isScreenPath(row.example), row.example).toBe(true);
      expect(isScreenPath(`${row.example}/`), `${row.example}/`).toBe(true);
    }
  });

  it("T-WEB-14 anything else is not a screen, under /api and /assets included", () => {
    for (const path of ["/api/me", "/api", "/assets/x.js", "/assets", "/nope", "/policies/a/b/c", "/.env", "/admin/escalations", "/onboarding", "/index.html"]) {
      expect(isScreenPath(path), path).toBe(false);
    }
    for (const row of PORTAL_SCREENS) {
      expect(row.pattern.test("/api/me"), row.name).toBe(false);
      expect(row.pattern.test("/assets/x.js"), row.name).toBe(false);
    }
  });
});
