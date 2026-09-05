// Components. Static hosting serves the built surface (src/, Vite) from this deployment's
// convex.site origin. It is mounted without an httpPrefix: the app owns "/" so the AgentMail
// webhook and the ruling links in every digest already sent keep their root URLs, and http.ts
// registers the static catch-all after them (exact and longer prefixes win).
import staticHosting from "@convex-dev/static-hosting/convex.config";
import { defineApp } from "convex/server";

const app = defineApp();
app.use(staticHosting);

export default app;
