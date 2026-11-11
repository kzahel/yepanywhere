import type { Page, Request, Route } from "@playwright/test";

interface Routes {
  draining: boolean;
  pending: Set<Promise<unknown>>;
}
const pages = new WeakMap<Page, Routes>();

/** Keep fetch-then-fulfill callbacks alive until their responses are delivered. */
export async function routeWithDrain(
  page: Page,
  matcher: Parameters<Page["route"]>[0],
  handler: (route: Route, request: Request) => unknown | Promise<unknown>,
): Promise<void> {
  let routes = pages.get(page);
  if (!routes) {
    routes = { draining: false, pending: new Set() };
    pages.set(page, routes);
  }
  const state = routes;
  await page.route(matcher, (route, request) => {
    if (state.draining) return route.fallback();
    const work = Promise.resolve().then(() => handler(route, request));
    state.pending.add(work);
    return work.finally(() => state.pending.delete(work));
  });
}

/**
 * Refuse the pushed collection stream so list views keep reading REST.
 *
 * The stream's snapshots come from the server, so a test that rewrites a
 * `GET /api/sessions`, `/api/projects`, `/api/inbox` or `/api/project-queue`
 * response would otherwise see its fixture replaced by real rows. A refused
 * stream takes the client's older-server fallback, which refetches over REST.
 */
export async function readCollectionsOverRest(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname === "/api/activity/collections",
    (route) => route.fulfill({ status: 404, body: "" }),
  );
}

export async function drainManagedRoutes(page: Page): Promise<void> {
  const routes = pages.get(page);
  if (!routes) return;
  // Removing interception patterns can force-continue sibling requests in
  // Playwright 1.58. Drain while the handler remains registered; new arrivals
  // fall through synchronously. unrouteAll({behavior:'wait'}) alone races.
  routes.draining = true;
  const results = await Promise.allSettled([...routes.pending]);
  const errors = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (errors.length)
    throw new AggregateError(
      errors,
      "Intercepted requests failed while draining",
    );
}
