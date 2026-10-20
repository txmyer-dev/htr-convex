// One Google connection, shared by the mail and calendar clients. Consent asks for four scopes,
// the narrowest set that reads mail, sends as the owner, reads every calendar (free/busy too) and
// writes only to calendars the owner owns. No scope limits writes to `primary`: callers name it.
// The granted scope string is kept on the grant; a grant from before it was kept is mail only.

export const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";

export const GMAIL_READ = "https://www.googleapis.com/auth/gmail.readonly";
export const GMAIL_SEND = "https://www.googleapis.com/auth/gmail.send";
export const CALENDAR_READ = "https://www.googleapis.com/auth/calendar.readonly";
export const CALENDAR_OWNED = "https://www.googleapis.com/auth/calendar.events.owned";
export const GOOGLE_SCOPES = [GMAIL_READ, GMAIL_SEND, CALENDAR_READ, CALENDAR_OWNED].join(" ");

export type GoogleCreds = { clientId: string; clientSecret: string; refreshToken: string };
type Fetch = typeof fetch;

const granted = (scope: string, ...need: string[]) => {
  const have = new Set(scope.split(/\s+/));
  return need.every((s) => have.has(s));
};

/** Read and send. A grant with no recorded scope predates recording it, and was mail only. */
export function hasMail(scope: string | undefined): boolean {
  return scope === undefined || granted(scope, GMAIL_READ, GMAIL_SEND);
}

/** Read every calendar and write to the owner's own. Both, or no calendar. */
export function hasCalendar(scope: string | undefined): boolean {
  return scope !== undefined && granted(scope, CALENDAR_READ, CALENDAR_OWNED);
}

// Access tokens live an hour; an isolate that stays warm reuses one instead of refreshing per call.
// Keyed by refresh token: one refresh token yields one access token carrying every granted scope.
const tokens = new Map<string, { token: string; exp: number }>();

export async function accessToken(creds: GoogleCreds, f: Fetch = fetch): Promise<string> {
  const hit = tokens.get(creds.refreshToken);
  if (hit && Date.now() < hit.exp - 60_000) return hit.token;
  const res = await f(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: creds.clientId, client_secret: creds.clientSecret,
      refresh_token: creds.refreshToken, grant_type: "refresh_token",
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Google token refresh ${res.status}: ${text.slice(0, 200)}`);
  const j = JSON.parse(text) as { access_token: string; expires_in?: number };
  tokens.set(creds.refreshToken, { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 });
  return j.access_token;
}
