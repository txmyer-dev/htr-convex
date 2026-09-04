// The live ruling surface. One query, re-run by Convex on every change: what waits, what was
// ruled, what went out. Send, Skip, or type the words you would rather send. The URL carries
// the tenant and the owner's key: /?t=tony&k=<key> (npx convex run tenants:surfaceUrl).

import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

type Row = NonNullable<ReturnType<typeof useQuery<typeof api.proposals.list>>>[number];

function params() {
  const u = new URL(window.location.href);
  return { slug: u.searchParams.get("t") ?? "", key: u.searchParams.get("k") ?? "" };
}

export default function App() {
  const { slug, key } = params();
  if (!slug || !key) return <main className="shell"><p>This page needs the link from your digest email.</p></main>;
  return <Surface slug={slug} keyToken={key} />;
}

function Surface({ slug, keyToken }: { slug: string; keyToken: string }) {
  const tenant = useQuery(api.tenants.surface, { slug, key: keyToken });
  const rows = useQuery(api.proposals.list, { slug, key: keyToken, limit: 100 });
  const [note, setNote] = useState<string | null>(null);
  if (tenant === undefined || rows === undefined) return <main className="shell"><p className="muted">Loading…</p></main>;
  const pending = rows.filter((r) => r.status === "pending");
  const ruled = rows.filter((r) => r.status !== "pending");
  return (
    <main className="shell">
      <header>
        <h1>{tenant.displayName}</h1>
        <p className="muted">
          {pending.length === 0 ? "Nothing waiting on you." : `${pending.length} waiting on you.`}
          {tenant.hold ? ` Holding the room${tenant.hold.until ? ` until ${tenant.hold.until}` : ""}.` : ""}
        </p>
        {note && <p className="note" onClick={() => setNote(null)}>{note}</p>}
      </header>
      <section>
        {pending.map((p) => <Card key={p.id} p={p} slug={slug} keyToken={keyToken} onNote={setNote} />)}
      </section>
      {ruled.length > 0 && (
        <section className="ruled">
          <h2>Ruled</h2>
          <ul>
            {ruled.map((p) => (
              <li key={p.id}>
                <span className={`status ${p.status}`}>{p.status}</span> {p.summary}
                {p.error && <span className="error"> · {p.error}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

function Card({ p, slug, keyToken, onNote }: { p: Row; slug: string; keyToken: string; onNote: (s: string) => void }) {
  const rule = useMutation(api.rulings.ruleFromSurface);
  const [editing, setEditing] = useState(false);
  const [words, setWords] = useState(p.body);
  const [busy, setBusy] = useState(false);
  const act = async (verdict: "sign" | "reject" | "edit") => {
    setBusy(true);
    try {
      onNote(await rule({ slug, key: keyToken, proposalId: p.id as Id<"proposals">, verdict, body: verdict === "edit" ? words : undefined }));
    } finally {
      setBusy(false);
    }
  };
  const when = p.deadline ? new Date(p.deadline).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) : null;
  return (
    <article className="card">
      <div className="who">
        {p.digestNo ? <span className="n">{p.digestNo}</span> : null}
        <strong>{p.toName || p.toAddress}</strong>
        <span className="muted"> · {p.sourceKind === "relist" ? "re-listed" : p.kind}{when ? ` · by ${when}` : ""}</span>
      </div>
      {p.subject && <div className="muted">{p.subject}</div>}
      {p.basis[0] && <blockquote>“{p.basis[0]}”</blockquote>}
      {editing ? (
        <textarea value={words} onChange={(e) => setWords(e.target.value)} rows={6} />
      ) : (
        <p className="body">{p.body}</p>
      )}
      <div className="actions">
        {editing ? (
          <>
            <button className="primary" disabled={busy || !words.trim()} onClick={() => act("edit")}>Send my words</button>
            <button disabled={busy} onClick={() => setEditing(false)}>Back</button>
          </>
        ) : (
          <>
            <button className="primary" disabled={busy} onClick={() => act("sign")}>Send</button>
            <button disabled={busy} onClick={() => act("reject")}>Skip</button>
            <button disabled={busy} onClick={() => setEditing(true)}>Edit</button>
          </>
        )}
      </div>
    </article>
  );
}
