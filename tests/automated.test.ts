// STEALS: HTR tests/test_mail_filter.py (test_gmail_categories_and_senders_decide,
// test_notification_domains_are_automated); the header cases pin the precedence/auto-submitted fix.
import { describe, expect, test } from "vitest";
import { looksAutomated } from "../convex/lib/reader/automated";

const from = (fromAddress: string, subject = "hi", headers: Record<string, string> = {}) =>
  looksAutomated({ fromAddress, subject, text: "Can we talk Tuesday?", headers });

describe("looksAutomated", () => {
  test("a person writing to you is not automated", () => {
    for (const a of ["priya@acme.com", "sam.lee@gmail.com", "tony@felaniam.cloud", "kim@studio.co", "jo@alertlogic.com", "pat@billingsmt.com"]) {
      expect(from(a), a).toBe(false);
    }
  });

  test("notification senders and domains are automated", () => {
    for (const a of [
      "noreply@x.com", "no-reply@x.com", "notifications@x.com", "team@startup.io", "news@paper.com",
      "billing@saas.com", "invoices@vendor.com", "meeting-notes@tool.ai", "notes@tool.ai",
      "calendar-notification@google.com", "alerts@ntfy.sh", "hello@devpost.com", "fred@fireflies.ai",
      "someone@github.com", "x@discord.com", "ping@alerts.bank.com", "a@updates.shop.com",
      "a@info.brand.com", "a@billing.saas.com", "a@mail.brand.com",
    ]) {
      expect(from(a), a).toBe(true);
    }
  });

  test("automated subjects", () => {
    for (const s of ["Confirm your email", "Password reset", "Meeting recap: weekly sync", "Notes: Meeting with Ben"]) {
      expect(from("priya@acme.com", s), s).toBe(true);
    }
  });

  test("each header is its own signal", () => {
    const person = "priya@acme.com";
    expect(from(person, "hi", { precedence: "first-class", "auto-submitted": "auto-notified" })).toBe(true);
    expect(from(person, "hi", { "auto-submitted": "auto-generated" })).toBe(true);
    expect(from(person, "hi", { "auto-submitted": "no" })).toBe(false);
    expect(from(person, "hi", { precedence: "junk" })).toBe(true);
    expect(from(person, "hi", { precedence: "bulk" })).toBe(true);
    expect(from(person, "hi", { "x-auto-response-suppress": "All" })).toBe(true);
    expect(from(person, "hi", { "list-id": "<dev.lists.example>" })).toBe(true);
    expect(from(person, "hi", { "message-id": "<a@b>" })).toBe(false);
  });
});
