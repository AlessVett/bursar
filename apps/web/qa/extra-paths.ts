/** A URL the QA run visits besides the shipped routes: a page state worth a screenshot. */
export interface QaExtraPath {
  /** Path and query, starting with "/". */
  path: string;
  /** Visit with the owner's session (true) or signed out (false). */
  auth: boolean;
  /** What the URL shows, for the reviewer. */
  note: string;
}

/** Page tasks add their state URLs here: not-found pages, tabs, filtered and empty lists. */
export const QA_EXTRA_PATHS: QaExtraPath[] = [
  { path: "/qa-unknown-page", auth: true, note: "Not-found page inside the app shell" },
  { path: "/login?expired=1", auth: false, note: "Login after the session expired" },
];
