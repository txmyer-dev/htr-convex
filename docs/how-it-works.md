# How Hold the Room works

A plain-English tour of the system, using the `tony` install (tied to felaniam.cloud) as the
concrete example. See [install.ts](../convex/install.ts) for the live config this describes.

## The one-sentence version

You have an email address. Anything that lands in it gets read and answered *for* you, in a
draft written in your voice — but nothing goes out until you say send. Nothing is ever sent on
your behalf without your say-so.

## What you actually got

- **An inbox** (through AgentMail) that customers, clients, or anyone else can write to.
- **A live page** — a private link only you have — that shows everything waiting on you, in real
  time, no refresh needed.
- **A digest email** that lands in your own inbox (`txmyer@gmail.com` per the install block) the
  moment a draft exists, since `digestAt` is set to `"immediate"` rather than a fixed time.
- **Quiet hours**, 9pm–8am — the assistant still reads and drafts overnight, it just won't ping
  you until morning.
- **A second brain** that starts out knowing only what your website (felaniam.cloud) says, and
  grows every time you correct it.
- **A web agent named Ekko** — a second assistant, on your site's side, that can actually go and
  update felaniam.cloud when your second brain learns something the site doesn't say yet.

## What happens when someone emails you

1. **Someone writes in.** Say a customer emails asking about pricing.
2. **It gets read once, quietly.** If it's spam, an auto-reply, or a mailing list — anything
   automated — it's just logged and stopped there. It never gets drafted, never bothers you.
3. **If it's a real person, a draft gets written.** Before writing anything, the assistant pulls
   together everything it's allowed to use:
   - the slice of your website that actually speaks to what they asked,
   - who's writing (if they emailed from a company address, it reads *their* site too, so it
     knows who it's talking to),
   - anything you've taught it before (see "the second brain" below),
   - your own recent corrections, so it writes like you, not like its last attempt.
4. **One rule: it never makes things up.** If the honest answer needs a fact nothing tells it — a
   price, a policy, an hour — it doesn't guess. It writes "I'll confirm that" and flags exactly
   what's missing, so you can fill it in.
5. **The draft appears on your live page within seconds.** It shows the quote it's responding to,
   the draft itself, and a line saying what it drafted *from* — "Drafted from your site
   (felaniam.cloud)" or similar — so you can see its work.
6. **You get pinged.** Since the digest is immediate, a numbered email lands in your inbox about a
   minute later (it waits a beat in case two or three messages come in together, so you get one
   email, not five).

## How you actually rule on something

Three ways, take your pick:

- **Reply to the digest email** in plain English: `1`, `1 yes`, `2 no`, or `3 tell them Tuesday
  works instead`.
- **Tap a link** right in that email — Send / Skip / Edit, one set per draft.
- **Use the live page** — tap Send, Skip, or open Edit and type your own words.

What happens next depends on what you picked:

- **Sign it** → it goes out, from your inbox, in the same thread, as if you'd typed it yourself.
- **Skip it** → nothing goes out. Done.
- **Edit it** (type your own words instead of the draft) → *your* words go out, and — this is the
  important part — **that correction is the lesson**. You never have to explain the correction
  separately; the next draft for anyone else quietly matches how you actually would've said it.

There are also a few standing commands you can send any time: `all` (sign everything in the last
digest), `later` (leave it all for the next batch), `hold` (stop pinging you for a while — drafts
keep queuing, nothing expires while you're holding), and `remember <something>` to teach it a fact
out of nowhere, not just as a correction.

## If you just... don't answer

Every draft has a deadline (2 days by default, or sooner if the message itself implies one — "can
you get back to me by Friday?"). If that passes with no ruling from you:

- It does the **one and only thing it's allowed to do without you**: it sends the person a short,
  honest holding note — "Tony's seen your message and will reply personally as soon as
  possible" — never the drafted reply itself.
- The item goes back to the top of your next digest so it doesn't just vanish.

## The second brain — how it gets smarter about your business

Two ways it learns:

1. **You edit a draft that flagged a gap.** If a draft says "I'll confirm that" about, say, your
   cancellation policy, and you edit it with the real answer, that answer is remembered — word
   for word, in your voice — and used in every future draft that touches the same topic.
2. **You just tell it something**, unprompted, by replying `remember we're closed Mondays through
   January`.

Either way, what you said gets distilled into a plain factual sentence behind the scenes (so it
reads cleanly to a model later), but what's kept as the permanent record is always your own
original words.

## The part that's specific to this setup: Ekko and the site

Because a `webAgent` is configured (Ekko, at felaniam.cloud), there's an extra loop most tenants
don't have: **when it teaches itself a fact the website doesn't already say, it doesn't just
remember the fact quietly — it drafts a request to Ekko asking to put it on the site.** That
request goes through the exact same ruling process as a customer email: it lands on your page and
in your digest, you sign it or skip it like anything else. If you sign it, Ekko gets it (you're
cc'd), and once Ekko says it's done, the system quietly re-reads felaniam.cloud to confirm the
fact is actually live on a page before marking it settled. If Ekko says no, or the page never
shows it, your page tells you plainly and offers a retry — it never leaves that hanging silently.

## What it will never do

- Never sends anything you haven't explicitly signed off on — no auto-send, ever, at any autonomy
  setting currently configured (`autonomyTier: 0` means everything above the line comes to you).
- Never invents a fact, price, or date it wasn't told.
- Never lets a stale digest number sign something newer than itself — replying "1" only ever
  resolves against the *latest* batch you were sent.
- Never double-sends — every webhook and scheduled job is checked against what's already been
  done, so a retried delivery can't cause a duplicate email.

That's the whole loop: **read → draft, grounded only in what's true → tell you → you rule → it
goes out as you, or it doesn't go out at all** — and every correction you make becomes the way it
writes from then on.
