// Two pages, one URL. Without a tenant in the query string this is the front door: anyone can
// take an inbox and be the owner for thirty minutes. With one (/?t=slug&k=key, the link in every
// digest) it is the live ruling surface: one query, re-run by Convex on every change: what
// waits, what was ruled, what went out. Send, Skip, or type the words you would rather send.

import { useAction, useMutation, useQuery } from "convex/react";
import { useState, type FormEvent, type ReactNode } from "react";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { describeGrounding } from "../convex/lib/knowledge/domain";

type Row = NonNullable<ReturnType<typeof useQuery<typeof api.proposals.list>>>[number];

function params() {
  const u = new URL(window.location.href);
  return { slug: u.searchParams.get("t") ?? "", key: u.searchParams.get("k") ?? "" };
}

export default function App() {
  const { slug, key } = params();
  if (!slug || !key) return <FrontDoor />;
  return <Surface slug={slug} keyToken={key} />;
}

// ---- the front door ---------------------------------------------------------------------------

function FrontDoor() {
  const start = useAction(api.demo.start);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [form, setForm] = useState({ ownerName: "", ownerEmail: "", businessName: "", site: "" });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setNote(null);
    try {
      const r = await start({ ...form, site: form.site || undefined, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
      if (r.ok) {
        window.location.assign(r.url);
        return;
      }
      if (r.busy) setNote(r.nextFree ? `Every demo inbox is taken right now. The next one frees at ${clock(r.nextFree)}.` : "Every demo inbox is taken right now. Try again in a little while.");
      else setNote(r.error);
    } catch (err) {
      setNote(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="shell front">
      <header>
        <h1>Hold the Room</h1>
        <p className="lede">An assistant that reads everything, drafts everything, and sends nothing until you rule.</p>
      </header>
      <ol className="how">
        <li><strong>Take an inbox.</strong> Give the form below a name and your email. You get an address and a live page.</li>
        <li><strong>Get an email.</strong> Send one to the address from any account, or use the customer button on the page. A draft in your voice appears on the page in seconds, with the quote it rests on. A minute later a numbered digest lands in your own inbox.</li>
        <li><strong>Rule.</strong> Tap Send on the page, or reply to the digest with <code>1</code>, <code>1 no</code>, or <code>1 tell them Tuesday works</code>. What you sign goes out as you, in their thread. What you edit teaches the drafter. Nothing goes out otherwise.</li>
      </ol>
      <form className="form" onSubmit={submit}>
        <label>Your name<input required value={form.ownerName} onChange={set("ownerName")} placeholder="Sam" /></label>
        <label>Your email<input required type="email" value={form.ownerEmail} onChange={set("ownerEmail")} placeholder="you@example.com" /><span className="hint">Digests come here. Replies from this address are rulings.</span></label>
        <label>Your business<input required value={form.businessName} onChange={set("businessName")} placeholder="Sam's Bakery" /></label>
        <label><span>Its website <span className="muted">(optional)</span></span><input value={form.site} onChange={set("site")} placeholder="sams-bakery.com" /><span className="hint">Firecrawl reads it so drafts quote your real hours and prices.</span></label>
        {note && <p className="note" onClick={() => setNote(null)}>{note}</p>}
        <button className="primary" disabled={busy} type="submit">{busy ? "Taking an inbox…" : "Take an inbox"}</button>
        <p className="hint">A demo lasts thirty minutes and is then forgotten. Your email address is used for the digests and nothing else.</p>
      </form>
    </main>
  );
}

// ---- the surface ------------------------------------------------------------------------------

function Surface({ slug, keyToken }: { slug: string; keyToken: string }) {
  const tenant = useQuery(api.tenants.surface, { slug, key: keyToken });
  const rows = useQuery(api.proposals.list, { slug, key: keyToken, limit: 100 });
  const retrySite = useMutation(api.facts.retrySite);
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
      {tenant.demo && <DemoBanner slug={slug} keyToken={keyToken} tenant={tenant} onNote={setNote} quiet={pending.length > 0 || ruled.length > 0} />}
      <section>
        {pending.map((p) => <Card key={p.id} p={p} slug={slug} keyToken={keyToken} onNote={setNote} />)}
      </section>
      {ruled.length > 0 && (
        <section className="ruled">
          <h2>Ruled</h2>
          <ul>
            {ruled.map((p) => (
              <Ruled key={p.id} p={p} slug={slug} keyToken={keyToken}>
                {p.kind === "site" && p.status === "failed" && (
                  <button className="small" onClick={async () => setNote(await retrySite({ slug, key: keyToken, proposalId: p.id as Id<"proposals"> }))}>
                    {p.siteFailure === "unseen" ? "Read the site again" : "Ask again"}
                  </button>
                )}
              </Ruled>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

/**
 * One ruled item, and what happened to it: every step from the draft to the thread or the page,
 * live. A site request still on its way opens by itself, so the owner watches it land.
 */
function Ruled({ p, slug, keyToken, children }: { p: Row; slug: string; keyToken: string; children?: ReactNode }) {
  const [open, setOpen] = useState(p.kind === "site" && p.status === "sent");
  return (
    <li>
      <span className={`status ${p.status}`}>{p.status}</span> {p.summary}
      {p.error && <span className="error"> · {p.error}</span>}
      {children}
      <button className="small quiet" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Hide" : "What happened"}</button>
      {open && <Timeline proposalId={p.id as Id<"proposals">} slug={slug} keyToken={keyToken} />}
    </li>
  );
}

function Timeline({ proposalId, slug, keyToken }: { proposalId: Id<"proposals">; slug: string; keyToken: string }) {
  const steps = useQuery(api.proposals.timeline, { slug, key: keyToken, proposalId });
  if (steps === undefined) return <p className="muted timeline-note">Loading…</p>;
  if (steps.length === 0) return <p className="muted timeline-note">Nothing recorded for this one.</p>;
  return (
    <ol className="timeline">
      {steps.map((s, i) => (
        <li key={i} className={s.tone}>
          <span className="when">{s.at ? clock(s.at) : "now"}</span>
          <span>{s.text}</span>
        </li>
      ))}
    </ol>
  );
}

type Tenant = NonNullable<ReturnType<typeof useQuery<typeof api.tenants.surface>>>;

function DemoBanner({ slug, keyToken, tenant, onNote, quiet }: { slug: string; keyToken: string; tenant: Tenant; onNote: (s: string) => void; quiet: boolean }) {
  const send = useAction(api.demo.sendAsCustomer);
  const end = useMutation(api.demo.end);
  const [open, setOpen] = useState(!quiet);
  const [busy, setBusy] = useState(false);
  const [c, setC] = useState({
    name: "Sam Lee",
    subject: "Saturday?",
    text: "Hi! Are you open this Saturday morning, and what would it cost for two people? We'd love to come by around 10.",
  });
  const demo = tenant.demo!;
  if (demo.endedAt) {
    return (
      <section className="banner">
        <p><strong>This demo has ended.</strong> Its inbox went back to the pool. <a href="/">Start another →</a></p>
      </section>
    );
  }
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      onNote(await send({ slug, key: keyToken, ...c }));
      setOpen(false);
    } catch (err) {
      onNote(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="banner">
      <p>
        <strong>Your inbox:</strong> <code className="addr">{tenant.inbox}</code>
        <button className="small" onClick={() => navigator.clipboard?.writeText(tenant.inbox ?? "")}>Copy</button>
      </p>
      <p className="muted">
        Email it from any address other than {tenant.ownerEmail}. Digests go to {tenant.ownerEmail}; a reply from there rules.
        {tenant.site ? ` Drafts rest on what ${host(tenant.site)} says.` : ""} This demo ends at {clock(demo.expiresAt)}.
      </p>
      {open ? (
        <form className="form" onSubmit={submit}>
          <label>Customer's name<input value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} /></label>
          <label>Subject<input value={c.subject} onChange={(e) => setC({ ...c, subject: e.target.value })} /></label>
          <label>Their message<textarea rows={4} value={c.text} onChange={(e) => setC({ ...c, text: e.target.value })} /></label>
          <div className="actions">
            <button className="primary" disabled={busy} type="submit">{busy ? "Sending…" : "Send as this customer"}</button>
            <button type="button" disabled={busy} onClick={() => setOpen(false)}>Later</button>
          </div>
        </form>
      ) : (
        <div className="actions">
          <button onClick={() => setOpen(true)}>Send a customer email</button>
          <button onClick={async () => onNote(await end({ slug, key: keyToken }))}>End demo</button>
        </div>
      )}
    </section>
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
  const from = describeGrounding(p.grounding);
  return (
    <article className="card">
      <div className="who">
        {p.digestNo ? <span className="n">{p.digestNo}</span> : null}
        <strong>{p.toName || p.toAddress}</strong>
        <span className="muted"> · {p.sourceKind === "relist" ? "re-listed" : p.kind === "site" ? "website update" : p.kind}{when ? ` · by ${when}` : ""}</span>
      </div>
      {p.subject && <div className="muted">{p.subject}</div>}
      {p.basis[0] && <blockquote>“{p.basis[0]}”</blockquote>}
      {editing ? (
        <textarea value={words} onChange={(e) => setWords(e.target.value)} rows={6} />
      ) : (
        <p className="body">{p.body}</p>
      )}
      {from && <p className="from">{from}</p>}
      {p.gap && <p className="gap">You haven't told me: {p.gap}. {editing ? "Your answer goes out as your words and is remembered." : "Edit with your answer and I'll send it and remember it."}</p>}
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

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
