// Only a person writing to you is a person waiting on you (the rule HTR's Gmail intake learned
// on its first day). Bulk, no-reply, and notification mail is recorded and never drafted.
// The sender, domain and subject nets carry Python HTR's (adapters/mail_gmail.py, 2026-09-03).

const SENDER = /^(no-?reply|do-?not-?reply|notifications?|noreply-|mailer-daemon|postmaster|bounce|alerts?|newsletter|digest|updates?|info|support|billing|receipts?|hello|team|news|notes)[@+.-]/i;
const LOCAL = /(invoice|-notes$|^calendar-)/i;
const DOMAIN = /(^|\.)(mail\.|email\.|notify\.|notifications?\.|bounce\.|marketing\.|news\.|em\.|e\.|alerts?\.|updates\.|info\.|billing\.)/i;
const SERVICES = /^(ntfy\.sh|devpost\.com|fireflies\.ai|google\.com|github\.com|discord\.com)$/i;
const SUBJECT = /\b(unsubscribe|your (order|receipt|invoice|statement|password|verification code)|verify your|confirm your email|password reset|meeting recap|notes: meeting|newsletter|weekly digest|security alert|sign-?in attempt)\b/i;
const BODY = /\b(unsubscribe|manage (your )?preferences|this is an automated (message|email)|do not reply to this)\b/i;

// Headers arrive with lowercased keys (lib/mail/inbound.ts). Each one is a separate signal.
function automatedHeaders(h: Record<string, string>): boolean {
  if (h["list-unsubscribe"] || h["list-id"]) return true;
  if (/^(bulk|list|junk)$/i.test((h["precedence"] ?? "").trim())) return true;
  const auto = (h["auto-submitted"] ?? "").trim();
  if (auto && auto.toLowerCase() !== "no") return true;
  if ((h["x-auto-response-suppress"] ?? "").trim()) return true;
  return false;
}

export function looksAutomated(m: { fromAddress: string; subject?: string; text?: string; headers?: Record<string, string> }): boolean {
  if (automatedHeaders(m.headers ?? {})) return true;
  const [local, domain = ""] = m.fromAddress.toLowerCase().split("@");
  if (SENDER.test(`${local}@`) || LOCAL.test(local)) return true;
  if (DOMAIN.test(domain) || SERVICES.test(domain)) return true;
  if (m.subject && SUBJECT.test(m.subject)) return true;
  if (m.text && BODY.test(m.text.slice(-1500))) return true;
  return false;
}
