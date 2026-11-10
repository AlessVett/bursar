import { createBrowserRouter, type DataRouter, type RouteObject } from "react-router";
import { LoginPage } from "../pages/LoginPage";
import { NotFoundPage } from "../pages/NotFoundPage";
import { SetupPage } from "../pages/SetupPage";
import { AppShell } from "./AppShell";
import { AuthShell } from "./AuthShell";
import { RouteErrorBoundary } from "./ErrorBoundary";
import { PAGE_LOADERS } from "./pages";
import { RequireAuth } from "./RequireAuth";
import { shippedRoutes } from "./routes";

function PendingPage() {
  return <div aria-busy="true" className="min-h-dvh bg-bg" />;
}

/** Shipped routes that have a page loader, as lazy route objects. */
function pageRoutes(): RouteObject[] {
  return shippedRoutes().flatMap((def) => {
    const loader = PAGE_LOADERS[def.id];
    return loader ? [{ path: def.path, lazy: loader }] : [];
  });
}

/**
 * The route tree: `/setup` and `/login` in the AuthShell, every shipped page plus the not-found page
 * in the AppShell, each area behind its `RequireAuth` guard. Exported for tests (memory router).
 */
export function appRoutes(): RouteObject[] {
  return [
    {
      errorElement: <RouteErrorBoundary />,
      hydrateFallbackElement: <PendingPage />,
      children: [
        {
          element: <RequireAuth area="auth" />,
          children: [
            {
              element: <AuthShell />,
              children: [
                { path: "/setup", element: <SetupPage /> },
                { path: "/login", element: <LoginPage /> },
              ],
            },
          ],
        },
        {
          element: <RequireAuth area="app" />,
          children: [
            {
              element: <AppShell />,
              children: [
                {
                  errorElement: <RouteErrorBoundary />,
                  children: [...pageRoutes(), { path: "*", element: <NotFoundPage /> }],
                },
              ],
            },
          ],
        },
      ],
    },
  ];
}

export function createAppRouter(): DataRouter {
  return createBrowserRouter(appRoutes());
}
