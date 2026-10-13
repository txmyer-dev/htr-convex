# Installing Hold the Room

Hold the Room reads your Gmail and your meetings, drafts the replies and the follow-ups, and
asks you before anything goes out. Urgent mail reaches your phone at once; the rest arrives as
one digest. Everything runs on your own server, with your own accounts. Nothing is shared with
anyone else's install.

This takes about 30 minutes, most of it in Google's console.

## What you need

- **A Linux server** (a VPS) with 2 GB of RAM or more, ports 80 and 443 free, and a public IP.
- **A domain** you control. You'll point two names at the server, for example `htr.example.com`
  and `api.htr.example.com`.
- On the server: **Docker** with the compose plugin ([install](https://docs.docker.com/engine/install/)),
  **Node 20+** ([install](https://nodejs.org/en/download/package-manager)), and **git**.
- Accounts, each your own:
  - **Gmail**, the mailbox Hold the Room reads and replies from.
  - **An LLM API key**: OpenAI, or any OpenAI-compatible provider (base URL, key and model).
  - **The ntfy app** on your phone ([ntfy.sh](https://ntfy.sh)), free. Your alerts arrive here.
  - **Fireflies** (recommended), for meeting notes and action items.
  - Optional: **ClickUp** (action items become tasks), **Firecrawl** (drafts can read your
    website), **Composio**, **treg** and **jev**.

## 1. Point your domain at the server

At your DNS provider, add two **A records** pointing to the server's public IP:

| Name | Type | Value |
|---|---|---|
| `htr.example.com` | A | your server's IP |
| `api.htr.example.com` | A | your server's IP |

Setup checks these records and tells you if they're wrong. HTTPS certificates are issued
automatically once DNS resolves.

## 2. Get the code and run setup

```bash
git clone https://github.com/txmyer-dev/htr-convex.git hold-the-room   # or your fork
cd hold-the-room
npm ci
npm run setup
```

Setup asks one question at a time and explains each one. In order, it:

1. checks Docker and Node;
2. asks for your domain, name, email, time zone, when you want the digest, and your quiet
   hours (no phone alerts at night);
3. starts Convex, its dashboard and Caddy (`compose.yml`), and saves an admin key to `.env.local`;
4. deploys Hold the Room;
5. asks for your keys. They're typed blind and stored on your Convex deployment, never in a file;
6. walks you through **your own Google OAuth client** (below);
7. creates your install and gives you a link to connect Gmail;
8. checks every connection and prints what passed and what didn't.

If something fails, fix it and run `npm run setup` again. Your answers are remembered, and keys
that are already set can be kept by pressing Enter.

### Your Google OAuth client (step 6)

Google requires every app that reads Gmail to have an OAuth client. You create your own, so your
mail never passes through anyone else's app. Setup prints these steps with your exact URL filled in:

1. In [Google Cloud Console](https://console.cloud.google.com), signed in as the Gmail you'll
   connect, create a project. Then go to **APIs & Services → Library → Gmail API → Enable**.
2. **Google Auth Platform → Get started**: app name "Hold the Room", your email, Audience **External**.
3. **Data access → Add scopes**: `gmail.readonly` and `gmail.send`.
4. **Audience → Publish app**, so it says **In production**. Don't skip this: in Testing mode,
   Google cuts off access every 7 days. Your app stays "unverified", which is fine for your own use.
5. **Clients → Create client → Web application**. Under **Authorized redirect URIs**, add exactly
   `https://htr.example.com/oauth/google/callback`, with your domain and no trailing slash.
6. Paste the client ID and secret into setup.

When you open the connect link, Google warns that the app isn't verified. Choose **Advanced →
Go to Hold the Room**, then allow both **read** and **send**.

### Fireflies

At the end, setup prints a webhook URL and a signing secret. In Fireflies, go to **Settings →
Developer settings**, set the **Webhook URL** to the URL setup gave you, and paste the
**signing secret**.

## 3. What "working" looks like

- `npm run setup` ends with every connection marked ✓.
- **Email:** send yourself a real question from another address, for example "Can you send me
  the quote by Friday?". Hold the Room picks it up within about 2 minutes and drafts a reply. With
  a digest time, the draft arrives in your next digest; with "immediate", it reaches your phone
  and inbox within a minute. Tap **Send**, **Skip** or **Edit**. Nothing is sent unless you
  approve it.
- **Urgent mail** ("URGENT: can you sign this today?") reaches your phone immediately, before
  the draft, unless it's quiet hours. In that case it arrives when quiet hours end.
- **Meetings:** after a recorded meeting, the notes and action items appear in the digest's
  **Meetings** section and on your phone. With ClickUp, each action item becomes a task for you
  to approve.
- **Your page:** setup prints a private link showing everything waiting for you. Keep it to yourself.

## Updating

```bash
npm run update
```

This pulls the latest code, updates the containers to the versions the repo specifies, deploys,
applies any data changes, and runs the health check.

## Day to day

- **Dashboard** (logs, data): `ssh -L 6791:127.0.0.1:6791 you@your-server`, then open
  <http://localhost:6791> and paste the admin key from `.env.local`.
- **A key changed?** Run `npm run setup` again, or use `npx convex env set NAME` (paste the
  value when it asks).
- **Health:** a connection that goes down, or comes back, sends a push to your phone. Check by hand with
  `npx convex run health:beat` then `npx convex run install:status '{"slug":"<your short name>"}'`.

## Back up

Two files and one Docker volume hold everything:

- `.env`: its `INSTANCE_SECRET` signs your admin key;
- `.env.local`: the admin key;
- the `htr_convex-data` volume: your data. Export a snapshot with `npx convex export --path backup.zip`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Setup says a domain doesn't point here | Fix the A record, wait a few minutes, and run setup again. |
| Port 80 or 443 is in use | Another web server is running. Stop it, or put Hold the Room behind it (route both domains to `127.0.0.1:3211` and `:3210`). |
| Gmail: `redirect_uri_mismatch` | The redirect URI on your OAuth client must be exactly `https://<domain>/oauth/google/callback`. |
| Gmail stops after a week | The OAuth app is still in Testing. Publish it (step 4 above), then connect again: `npm run setup`, and answer yes to "Connect Gmail again?". |
| No phone alerts | Make sure your phone's ntfy app is subscribed to the exact topic setup printed. |
| A ✗ in the health check | The message next to it names the key or service. Fix it and run setup again. |
