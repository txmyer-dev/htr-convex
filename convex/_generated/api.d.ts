/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as crons from "../crons.js";
import type * as demo from "../demo.js";
import type * as digest from "../digest.js";
import type * as drafter from "../drafter.js";
import type * as events from "../events.js";
import type * as facts from "../facts.js";
import type * as http from "../http.js";
import type * as install from "../install.js";
import type * as knowledge from "../knowledge.js";
import type * as lib_digest_expiry from "../lib/digest/expiry.js";
import type * as lib_digest_render from "../lib/digest/render.js";
import type * as lib_drafter_lessons from "../lib/drafter/lessons.js";
import type * as lib_knowledge_chunk from "../lib/knowledge/chunk.js";
import type * as lib_knowledge_domain from "../lib/knowledge/domain.js";
import type * as lib_knowledge_links from "../lib/knowledge/links.js";
import type * as lib_knowledge_rank from "../lib/knowledge/rank.js";
import type * as lib_llm_embed from "../lib/llm/embed.js";
import type * as lib_llm_openaiCompat from "../lib/llm/openaiCompat.js";
import type * as lib_mail_agentmail from "../lib/mail/agentmail.js";
import type * as lib_mail_inbound from "../lib/mail/inbound.js";
import type * as lib_mail_svix from "../lib/mail/svix.js";
import type * as lib_proposals_lifecycle from "../lib/proposals/lifecycle.js";
import type * as lib_reader_automated from "../lib/reader/automated.js";
import type * as lib_reader_deadline from "../lib/reader/deadline.js";
import type * as lib_reader_waiting from "../lib/reader/waiting.js";
import type * as lib_rulings_parse from "../lib/rulings/parse.js";
import type * as lib_rulings_token from "../lib/rulings/token.js";
import type * as lib_site_publish from "../lib/site/publish.js";
import type * as lib_time from "../lib/time.js";
import type * as mail from "../mail.js";
import type * as proposals from "../proposals.js";
import type * as rulings from "../rulings.js";
import type * as surface from "../surface.js";
import type * as tenants from "../tenants.js";
import type * as views from "../views.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  crons: typeof crons;
  demo: typeof demo;
  digest: typeof digest;
  drafter: typeof drafter;
  events: typeof events;
  facts: typeof facts;
  http: typeof http;
  install: typeof install;
  knowledge: typeof knowledge;
  "lib/digest/expiry": typeof lib_digest_expiry;
  "lib/digest/render": typeof lib_digest_render;
  "lib/drafter/lessons": typeof lib_drafter_lessons;
  "lib/knowledge/chunk": typeof lib_knowledge_chunk;
  "lib/knowledge/domain": typeof lib_knowledge_domain;
  "lib/knowledge/links": typeof lib_knowledge_links;
  "lib/knowledge/rank": typeof lib_knowledge_rank;
  "lib/llm/embed": typeof lib_llm_embed;
  "lib/llm/openaiCompat": typeof lib_llm_openaiCompat;
  "lib/mail/agentmail": typeof lib_mail_agentmail;
  "lib/mail/inbound": typeof lib_mail_inbound;
  "lib/mail/svix": typeof lib_mail_svix;
  "lib/proposals/lifecycle": typeof lib_proposals_lifecycle;
  "lib/reader/automated": typeof lib_reader_automated;
  "lib/reader/deadline": typeof lib_reader_deadline;
  "lib/reader/waiting": typeof lib_reader_waiting;
  "lib/rulings/parse": typeof lib_rulings_parse;
  "lib/rulings/token": typeof lib_rulings_token;
  "lib/site/publish": typeof lib_site_publish;
  "lib/time": typeof lib_time;
  mail: typeof mail;
  proposals: typeof proposals;
  rulings: typeof rulings;
  surface: typeof surface;
  tenants: typeof tenants;
  views: typeof views;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  staticHosting: import("@convex-dev/static-hosting/_generated/component.js").ComponentApi<"staticHosting">;
};
