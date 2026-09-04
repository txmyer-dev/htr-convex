// Only a person writing to you is a person waiting on you (the rule HTR's Gmail intake learned
// on its first day). Bulk, no-reply, and notification mail is recorded and never drafted.

const SENDER = /^(no-?reply|do-?not-?reply|notifications?|noreply-|mailer-daemon|postmaster|bounce|alerts?|newsletter|digest|updates?|info|support|billing|receipts?|hello)[@+.-]/i;
const DOMAIN = /(^|\.)(mail\.|email\.|notify\.|notifications?\.|bounce\.|marketing\.|news\.|em\.|e\.)/i;
const SUBJECT = /\b(unsubscribe|your (order|receipt|invoice|statement|password|verification code)|verify your|newsletter|weekly digest|security alert|sign-?in attempt)\b/i;
const BODY = /\b(unsubscribe|manage (your )?preferences|this is an automated (message|email)|do not reply to this)\b/i;

export function looksAutomated(m: { fromAddress: string; subject?: string; text?: string; headers?: Record<string, string> }): boolean {
  const h = m.headers ?? {};
  if (h["list-unsubscribe"] || h["list-id"] || /bulk|list|auto-replied|auto-generated/i.test(h["precedence"] ?? h["auto-submitted"] ?? "")) return true;
  const [local, domain = ""] = m.fromAddress.toLowerCase().split("@");
  if (SENDER.test(`${local}@`)) return true;
  if (DOMAIN.test(domain)) return true;
  if (m.subject && SUBJECT.test(m.subject)) return true;
  if (m.text && BODY.test(m.text.slice(-1500))) return true;
  return false;
}
