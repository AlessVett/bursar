# Bursar — Panel UX/UI Design

- **Date:** 2026-11-09
- **Status:** accepted
- **Applies to:** every page of `apps/web`, from M1 on. Extends §6.1 of `2026-11-09-bursar-design.md`.

The panel is the finished product, not a prototype: every page shows real data from the API. When a request fails, the page shows an error state, never invented data. The only fake data is the demo mode of M6, used for screenshots.

## 1. Users, devices and shells

- **One role:** the owner. There is no role matrix, no impersonation, no external portal and no landing page.
- **Devices:**
  - The desktop is the primary target, at 1280–1440 px.
  - The phone, at 390×844, is a first-class target for Home, Transactions, Reports and Chat, the pages the owner checks on the go.
  - Every page works at 390 px without horizontal page scroll.
- **Shells:**
  - `AuthShell` (setup, login): a centred card, the product mark, a language switch and a theme switch.
  - `AppShell`: every page after login.
- **Hidden until shipped:** pages and widgets of features that are not shipped yet are not rendered at all. There are no "coming soon" pages, no placeholder widgets and no dead buttons.

## 2. Navigation

### Route registry

One route registry (`src/app/routes.ts`) is the single source of truth. For each route it holds:

- the path;
- the i18n title key;
- the icon;
- the navigation group;
- the keywords for the command palette;
- the parent, for breadcrumbs;
- whether the route is shipped.

The sidebar, the topbar title, the breadcrumbs and the command palette all read from it.

### Sidebar groups

| Group | Items | Milestone |
|-------|-------|-----------|
| (top) | Home | M1 |
| Money | Accounts, Transactions | M1 |
| Knowledge | Documents, Reports | M3, M4 |
| Agents | Chat, Agents, Activity | M2 |
| (bottom) | Settings | M1 |

- **Sidebar sizes:** 264 px expanded, 76 px as a collapsed rail with native tooltips. Below `lg`, the sidebar becomes a drawer with a blurred backdrop; it closes on every route change and on Esc.
- **Active item:** a `primary-50` background, semibold text and a 3 px accent bar on the left.
- **Badges:** a neutral badge shows a total. An accent badge shows a count that needs action, for example expiring consents or pending agent proposals. On the collapsed rail, an accent badge becomes a dot.

### Topbar

The topbar is sticky, with a translucent blurred background. From left to right:

1. the page title, from the registry;
2. the command palette trigger (⌘K / Ctrl+K);
3. the save indicator (a green dot labelled "Saved", which turns pulsing amber while saving);
4. the privacy toggle (§6);
5. the notifications popover;
6. the user menu: language, theme (system, light, dark), density, sign out.

On a phone the search collapses to an icon.

### Inner pages

Every inner page has a breadcrumb and a back button. When there is no in-app history (`history.state.idx === 0`), the back button goes to the breadcrumb parent and never leaves the app.

### Command palette

- **Sources:**
  - pages (8 at most when the query is empty);
  - accounts, by name, bank and the last 4 IBAN digits;
  - from M1, transactions by counterparty;
  - from M3, documents.
- **Search:** case- and accent-insensitive.
- **Footer:** "↑↓ navigate · ↵ open · esc close · N results".
- **Empty result:** "No results for “xyz” — Try a name, a bank or the last digits of an IBAN."
- **Subtitles:** a result's subtitle is its group or description, never a path or an ID.

## 3. Iconic element: the cash-flow strip

The question the owner asks most is "where is my money going, and am I ahead or behind?". The answer is the **cash-flow strip**: inflows and outflows per day or per week as diverging bars around zero, with the net amount. Its colour rules:

- **Inflow:** the `positive` tone (green).
- **Outflow:** the `ink` tone (neutral slate). Spending is not an error, so it is never red.
- **Red:** only for a negative balance, a negative net when the toggle "highlight negative net" is on (default: on), and real errors.

One function maps a signed amount to a tone (`src/lib/tones.ts` → `amountTone(minor)`). Every form below uses it.

| Form | Where |
|------|-------|
| Single | Transaction rows (signed amount in the amount tone, tabular figures); account cards (a 30-day mini strip) |
| Aggregated filter | Above the transactions list: "In 2.340,00 € · Out 1.870,00 € · Net +470,00 €". Each figure toggles a direction filter, and a click on a day bar filters that date. All of it is written to the URL. |
| Distribution | Home: a 30-day strip with the running balance as a line. A click on a day opens Transactions filtered to that day; the link under the chart names the selection ("See 14 transactions on 12 Nov"). |
| Mini | Accounts list and command palette: a net-30-day chip ("+470 €" with an arrow) |

### Data freshness and consent

The secondary element, for connections only, belongs to the time/deadline family. It is a `DeadlineChip` with central thresholds in `src/lib/thresholds.ts`:

| Aspect | Red | Amber | OK |
|--------|-----|-------|----|
| Consent expiry, in calendar days | expired or ≤ 3 days | ≤ 14 days | otherwise |
| Data freshness (last successful sync) | > 72 h | > 24 h | otherwise |

The text label never depends on colour alone ("Consent expires in 9 days", "Updated 3 hours ago").

## 4. Pages and their patterns

| Page | Pattern | Milestone |
|------|---------|-----------|
| Home | Role home: greeting with the local date and a one-sentence summary that links to what needs attention; KPI row (balance per currency, 30-day in, out, net; each opens the filtered list); the 30-day cash-flow strip; accounts with freshness; alert list (expiring consents, failed syncs). The latest report headline is added in M4 and pending proposals in M2. | M1 |
| Accounts | Connections grouped by bank. Each account row: name (editable inline), masked IBAN in monospace with a copy button, balance, net-30-day chip, freshness chip, status pill. Connection actions follow its state machine: renew consent, sync now, disconnect. | M1 |
| Account detail | Detail page: hero with name, bank, masked IBAN (copy), status, balance, and a 6 px status stripe. Tabs: Overview (contextual alerts or "All good", 90-day balance chart, cash-flow strip), Transactions (pre-filtered list), Connection (consent, expiry, sync history). | M1 |
| Connect bank | Wizard: country → bank (searchable list with logos from the API, if provided) → consent duration (default the maximum) with a reassurance that access is read-only → redirect → callback page with the result and the accounts found. An empty account list shows the restricted-mode guidance (§6.3 of the spec). | M1 |
| Transactions | List grammar: header with a count badge; the cash-flow aggregate; tabs (All, Inflows, Outflows, Pending); search across counterparty, description and amount; filters (account, date range, category from M2) with chips and "Clear filters"; table with booking date (relative, absolute in `title`), counterparty, description, account, signed amount; a side drawer (520 px) for details; pagination "21–40 of 840". | M1 |
| Settings | Sections in cards with inline edit per section and a sticky "Unsaved changes" bar. Live preview where it applies (language, date and money formats). | M1 |
| Documents | List plus a detail page (summary, facts with page references, relations, original file), a duplicates filter and full-text search | M3 |
| Reports | History list and a reading view tuned for the phone (headline, sections, evidence links), on-demand generation with an optional focus | M4 |
| Agents | List and detail page with versions; an approval inbox for proposals (approve or reject; rejecting requires a reason and records a correction) | M2 |
| Activity | Unified timeline of runs, inter-agent messages, web requests and audit events | M2 |
| Chat | Conversation with the Master: streaming answers, evidence links, the phone layout first | M2 |

### Business codes

- An account shows its masked IBAN (`IT60 •••• •••• 1234`) in monospace. The copy button copies the full IBAN and shows an info toast.
- A transaction shows its bank reference only in the detail drawer.
- Internal UUIDs never appear anywhere: not in the UI, not in toasts, not in "not found" messages.

## 5. Visual system

### Tokens

Tokens are CSS variables in RGB triplets, mapped in Tailwind 4 `@theme`, so dark mode is automatic. Pages and components use semantic utilities only (`bg-surface`, `text-muted`, `border-subtle`, `text-positive`…). They never use `dark:`, `bg-white` or `text-gray-*`.

| Token | Light | Dark |
|-------|-------|------|
| `bg` | `#F6F7F9` | `#0E121B` |
| `surface` | `#FFFFFF` | `#151B27` |
| `surface-2` | `#F1F3F7` | `#1C2433` |
| `border` | `#E3E7EE` | `#273043` |
| `text` | `#141A26` | `#E7EAF1` |
| `muted` | `#5B6475` | `#9AA4B6` |
| `primary` (ink navy) | `#1E2A4A` | `#9DB0E0` |
| `primary-50` | `#EEF1F8` | `#1E2840` |
| `accent` (brass) | `#B07A22` | `#D9A74A` |
| `positive` | `#15803D` | `#4ADE80` |
| `ink` (outflow) | `#334155` | `#CBD5E1` |
| `warning` | `#B45309` on `#FEF3C7` | `#FBBF24` on `#3A2A0B` |
| `danger` | `#B91C1C` on `#FEE2E2` | `#F87171` on `#3B1416` |
| `info` | `#1D4ED8` on `#DBEAFE` | `#60A5FA` on `#13233F` |

Every text and background pair meets WCAG 2.2 AA contrast; a unit test checks the table above.

### Typography

- **Fonts:** Inter Variable for text and Manrope Variable for display (titles, large figures). Both are self-hosted through `@fontsource-variable`; no external requests are allowed under the CSP.
- **Sizes:** text at 12, 13 and 14 px; titles at 16, 20, 24 and 30 px.
- **Figures:** amounts and figures use `font-variant-numeric: tabular-nums`; codes use the monospace stack.

### Shape and motion

- Radii of 12–16 px, soft shadows, thin borders and a 4/8 px grid.
- Animations last 150–250 ms and run on entry only. Cards and rows enter in a cascade of 35 ms per item, capped at 10 items. Page transitions also run on entry only (`key={pathname}`); there is no `AnimatePresence` exit around the router outlet.
- `prefers-reduced-motion` disables all of it.

### Density

- Tables default to compact (40 px rows); Home, Reports and Chat use comfortable spacing.
- A density switch in the user menu persists per browser.

### Libraries

React Router 7, TanStack Query for server state, Zustand for UI preferences only (theme, density, privacy, sidebar), lucide-react, Recharts and `motion`. Any other library is added only by a plan task that says why.

## 6. Money, time, language and privacy

### Money

- One helper formats every amount: `formatMoney(minor: bigint | number, currency, locale, { sign })` in `packages/shared`. It formats integer minor units with `Intl.NumberFormat`. Floating-point arithmetic is never used on amounts.
- Balances are shown per currency. There is no FX conversion until a later plan adds one, and the UI says so where totals mix currencies.

### Time

- One helper formats dates: relative under 45 days ("2 hours ago", "yesterday", "in 3 days"), absolute beyond that. The absolute date with time is always in `title`.
- Local dates use the owner's time zone setting.

### Language

- Italian is the default and English is complete. Every string lives in the locale files, and a test fails when the key sets differ.
- Counts use i18next plurals: never "account/s".
- Italian copy uses typographic quotes “…” around state names and searches, and `it-IT` formats.
- Buttons are a verb plus an object, with the count when the action applies to N items.

### Privacy mode

- The topbar toggle, also bound to the `⇧⌘H` shortcut, masks every amount as `•••••` and the IBAN digits.
- The mode persists per browser and is announced with a toast.
- It hides only what is rendered: the data still reaches the browser.

## 7. Interaction rules

- **Feedback:** one `feedback(title, detail, tone)` helper shows a toast at the top right that disappears after about 4 s, and pulses the save indicator. No page builds toasts by hand.
  - The title names the outcome ("Sync started", "Account renamed"); the detail names the real object and the consequence.
  - Tones: `success` for something already done; `info` for background work ("Sync started: new transactions appear in a minute"); `warning` for a refusal or a restrictive consequence; `error` only for real errors.
- **Destructive actions:** use the softest level that fits.
  1. Reversible (disable an account): a simple confirmation that says it can be undone.
  2. Blocked: a disabled button whose `title` gives the reason.
  3. Permanent: "Disconnect bank" asks a question as its title, lists what goes away with real counts, and repeats the verb on the button ("Yes, disconnect"). "Purge transactions" is a separate level 3 action, as in §6.3 of the spec.
- **Empty states:** filter-empty, true-empty (why it is empty, plus the first step), positive ("All good: every account was updated today"), state-dependent, not found, and inline small empties.
  - The true-empty Accounts page says that Bursar only reads balances and transactions and cannot make payments.
- **Lists:**
  - Faceted tab counts, KPI figures that act as filters, filter chips with "Clear filters", and a natural-order collator.
  - Sorting cycles ascending → descending → none.
  - Skeleton rows of varied widths, never a spinner over a table.
  - When filters change, pagination returns to page 1.
- **URL state:** filters, tabs and the selected period live in the URL. Writes use `replace`; a default value is absent from the URL; an invalid value falls back to the default.
- **Errors:** a global `ErrorBoundary` shows a styled message and a "Back to Home" button.
- **Session expiry:** a 401 from the API sends the owner to the login page with "Your session expired, sign in again". A 403 from Access triggers a full reload.
- **Live updates:** server-sent events (`/api/events`) invalidate the relevant queries. A running sync shows progress on its account row, and the result arrives as a toast.

## 8. Accessibility

- Visible focus rings; full keyboard navigation (sidebar, palette, tables, drawer, dialogs with a focus trap); `aria-label` on icon-only buttons.
- Colour is never the only signal; touch targets are at least 44 px on the phone.
- Charts carry a text summary for screen readers.

## 9. Definition of done for any UI task

1. Type check, lint and unit tests pass. Component tests cover the behaviour of the shared components (feedback, empty states, `formatMoney`, thresholds, the route registry).
2. A Playwright run with the system Chrome (`playwright-core`, no browser download) visits every shipped route against a seeded test server. Each route is captured at 1440×900 in light and dark, and at 390×844. The run fails on a console error, a CSP violation, a page error, or horizontal overflow at 390 px.
3. The task's reviewer looks at the screenshots, not only at the code. They check: hierarchy, alignment, no truncated text, no "undefined", "NaN" or "Invalid Date", no raw IDs, no untranslated strings, empty and error states present, and dark mode readable.

## 10. Patterns adopted and discarded

| Pattern | Decision |
|---------|----------|
| Module sidebar, topbar, ⌘K palette, breadcrumbs | Adopted |
| Role home with KPIs and alerts | Adopted, single role |
| List grammar, detail page with tabs, drawer preview | Adopted (transactions, accounts, documents) |
| State machine with a primary action | Adopted for connections (`active`, `expiring`, `expired`, `revoked`, `error`) and agent proposals |
| Approval inbox | Adopted for agent proposals (M2) |
| Conversation thread | Adopted for Chat and Activity (M2) |
| Wizard | Adopted for connecting a bank |
| Rule builder in plain language | Adopted for transaction categorisation rules (M2) |
| Notifications popover | Adopted |
| Multi-site context, role matrix, impersonation | Discarded: single owner |
| Planner, calendar, Kanban, line-item documents, barcode | Discarded: not in the domain |
| External portal, landing page, simulated live events | Discarded: private tool; live updates come from real events |
