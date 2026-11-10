/**
 * Values for the dynamic segments of shipped routes, keyed by the segment as written in the
 * route path. They point at seeded QA data (Task 6: account 1 is an active EUR current account).
 * A page task that ships a route with a new parameter adds its value here.
 */
export const QA_PARAMS: Record<string, string> = {
  ":accountId": "1",
};
