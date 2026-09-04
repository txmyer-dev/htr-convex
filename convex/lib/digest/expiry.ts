// Expiry (STEALS: HTR src/htr/digest/expiry.py): the state none of the earlier repos had. A
// draft with a deadline stops waiting when the deadline passes with no ruling. The assistant
// then does the one thing it may do alone: tells the counterparty a reply is coming, in the
// owner's hold-the-room voice, and re-lists the item at the top of the next digest. It never
// sends the draft.

export type Overdueable = { status: string; deadline?: number | null };

export function isOverdue(p: Overdueable, nowMs: number): boolean {
  return p.status === "pending" && p.deadline != null && p.deadline <= nowMs;
}

export function holdNotice(tenant: { displayName: string; owner: { name: string; discloseAssistant: boolean } }): string {
  const tail = tenant.owner.discloseAssistant ? " (This is an automated note from their assistant.)" : "";
  return (
    `Hi, this is ${tenant.displayName}. ${tenant.owner.name} has seen your message and will reply ` +
    `personally as soon as possible.${tail}`
  );
}
