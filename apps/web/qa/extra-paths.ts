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
  {
    path: "/connect?step=bank&country=IT",
    auth: true,
    note: "Connect wizard: searchable bank list, initials fallback and beta badge",
  },
  {
    path: "/connect?step=consent&country=IT&bank=Banca%20Esempio",
    auth: true,
    note: "Connect wizard: consent duration, end date and read-only reassurance",
  },
  {
    path: "/connect/callback?state=invalid-state-value-000",
    auth: true,
    note: "Callback with an unknown state: expired or already used link",
  },
  {
    path: "/connect/callback?error=access_denied&state=invalid-state-value-000",
    auth: true,
    note: "Callback with a cancelled authorisation and an unknown state",
  },
  {
    path: "/accounts/999999",
    auth: true,
    note: "Account detail: not found (missing or purged id)",
  },
  { path: "/accounts/1?tab=transactions", auth: true, note: "Account detail: latest transactions" },
  {
    path: "/accounts/1?tab=connection",
    auth: true,
    note: "Account detail: consent, actions and sync history",
  },
  {
    path: "/accounts/3",
    auth: true,
    note: "Account detail: expiring consent and updates paused by the bank",
  },
  { path: "/accounts/5", auth: true, note: "Account detail: unavailable account" },
  {
    path: "/accounts/6?tab=connection",
    auth: true,
    note: "Account detail: expired consent, blocked sync, failed history",
  },
  {
    path: "/accounts/7",
    auth: true,
    note: "Account detail: disabled account, negative balance in danger",
  },
  {
    path: "/accounts/8",
    auth: true,
    note: "Account detail: withdrawn consent, loan with a negative balance",
  },
  {
    path: "/accounts/10?tab=connection",
    auth: true,
    note: "Account detail: disconnected account, no actions",
  },
];
