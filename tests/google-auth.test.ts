// One Google connection for mail and calendar: what consent asks for, what a grant allows, and the
// access-token cache both clients share. Offline: every token call goes to a stub.

import { afterEach, describe, expect, test, vi } from "vitest";
import { accessToken, GOOGLE_SCOPES, hasCalendar, hasMail } from "../convex/lib/google/auth";
import { consentUrl, Gmail } from "../convex/lib/mail/gmail";

afterEach(() => {
  vi.useRealTimers();
});

const READ = "https://www.googleapis.com/auth/gmail.readonly";
const SEND = "https://www.googleapis.com/auth/gmail.send";
const CAL_READ = "https://www.googleapis.com/auth/calendar.readonly";
const CAL_OWNED = "https://www.googleapis.com/auth/calendar.events.owned";

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

/** A stubbed Google token endpoint (and a Gmail profile), counting refreshes. */
function google() {
  let refreshes = 0;
  const f = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    if (String(input) === "https://oauth2.googleapis.com/token") {
      refreshes++;
      return json({ access_token: `at-${refreshes}`, expires_in: 3600 });
    }
    return json({ emailAddress: "ben@gmail.com", auth: (init.headers as Record<string, string>).authorization });
  });
  return { f: f as unknown as typeof fetch, refreshes: () => refreshes };
}

let rt = 0;
const creds = () => ({ clientId: "cid", clientSecret: "csec", refreshToken: `rt-auth-${++rt}` });

describe("scopes", () => {
  test("consent asks for all four, every time", () => {
    expect(GOOGLE_SCOPES.split(" ").sort()).toEqual([CAL_OWNED, CAL_READ, READ, SEND].sort());
    const u = new URL(consentUrl("cid", "https://ben.example.com/oauth/google/callback", "st"));
    expect(u.searchParams.get("scope")!.split(" ").sort()).toEqual([CAL_OWNED, CAL_READ, READ, SEND].sort());
    expect(u.searchParams.get("include_granted_scopes")).toBe("false");
  });

  test("mail needs both Gmail scopes, calendar needs both calendar scopes", () => {
    const all = [READ, SEND, CAL_READ, CAL_OWNED].join(" ");
    expect([hasMail(all), hasCalendar(all)]).toEqual([true, true]);
    expect([hasMail(`${READ} ${SEND}`), hasCalendar(`${READ} ${SEND}`)]).toEqual([true, false]);
    expect(hasMail(`${READ} ${CAL_READ} ${CAL_OWNED}`)).toBe(false);
    expect(hasCalendar(`${READ} ${SEND} ${CAL_READ}`)).toBe(false);
    expect(hasCalendar(`${READ} ${SEND} ${CAL_OWNED}`)).toBe(false);
    expect(hasMail(`${READ}x ${SEND}`)).toBe(false); // whole scopes, not substrings
    expect(hasMail("")).toBe(false);
  });

  test("covers AE5: a grant saved before scopes were recorded counts as mail only", () => {
    expect(hasMail(undefined)).toBe(true);
    expect(hasCalendar(undefined)).toBe(false);
  });
});

describe("the shared access-token cache", () => {
  test("two clients on one refresh token refresh once", async () => {
    const g = google();
    const c = creds();
    const a = await accessToken(c, g.f);
    const b = await accessToken(c, g.f);
    await new Gmail(c, undefined, g.f).profile(); // the Gmail client draws on the same cache
    expect(g.refreshes()).toBe(1);
    expect([a, b]).toEqual(["at-1", "at-1"]);
  });

  test("different refresh tokens don't share", async () => {
    const g = google();
    await accessToken(creds(), g.f);
    await accessToken(creds(), g.f);
    expect(g.refreshes()).toBe(2);
  });

  test("an expired token is refreshed once before the next call", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_791_000_000_000);
    const g = google();
    const c = creds();
    expect(await accessToken(c, g.f)).toBe("at-1");
    vi.setSystemTime(1_791_000_000_000 + 3600_000);
    expect(await accessToken(c, g.f)).toBe("at-2");
    expect(await accessToken(c, g.f)).toBe("at-2");
    expect(g.refreshes()).toBe(2);
  });
});
