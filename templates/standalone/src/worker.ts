/**
 * A standalone Kukuroo deployment: a notification sink and nothing else.
 *
 *   GET  /push/enroll      the enrollment page you add to your Home Screen
 *   GET  /push/public-key  the VAPID public key, for the enrollment page
 *   POST /push/subscribe   invite-gated
 *   POST /push/send        bearer-gated, encrypts and fans out
 *
 * If you already have a Worker, you do not need this file. Import
 * `mountKukuroo` there instead and put the routes on the origin you already own.
 */

import { mountKukuroo, type KukurooEnv } from "kukuroo";

// `standalone: true` is what serves the bundled enrollment page. Without it
// /push/enroll is not routed at all, on the assumption that the host has its own.
//
// `requireInvite: true` keeps the code on /push/subscribe: a stranger who finds
// this URL cannot enroll their own device and start reading your notifications.
// Turn it off only if enrollment is meant to be open to whoever turns up.
const kukuroo = mountKukuroo({
  prefix: "/push",
  standalone: true,
  requireInvite: true,
});

export default {
  async fetch(request: Request, env: KukurooEnv): Promise<Response> {
    // `handle` returns null for anything outside its prefix, so a host Worker
    // keeps control of its own routing. Here there is nothing else to route.
    const response = await kukuroo.handle(request, env);
    if (response !== null) return response;

    // Send people to the page that does something, rather than a bare 404.
    if (new URL(request.url).pathname === "/") {
      return Response.redirect(new URL("/push/enroll", request.url).toString(), 302);
    }

    return new Response("Not found\n", { status: 404 });
  },
} satisfies ExportedHandler<KukurooEnv>;
