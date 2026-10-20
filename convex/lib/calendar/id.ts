// Calendar event ids HTR chooses itself, so a retried write finds the event it already made.

/**
 * Google's id for an insert card's event: the proposal id's bytes in lowercase hex. Convex ids use
 * letters past `v`, outside Google's base32hex alphabet; hex stays inside it, and is stable (KTD5).
 */
export function eventIdFor(proposalId: string): string {
  return Array.from(new TextEncoder().encode(proposalId), (b) => b.toString(16).padStart(2, "0")).join("");
}
