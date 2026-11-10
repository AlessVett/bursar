import type { ComponentType } from "react";
import type { RouteId } from "./routes";

export type PageLoader = () => Promise<{ Component: ComponentType }>;

/**
 * Lazy page modules by route id. A page task adds its entry here and flips `shipped` in `routes.ts`;
 * the router registers a shipped route only when its loader exists.
 */
export const PAGE_LOADERS: Partial<Record<RouteId, PageLoader>> = {
  home: () => import("../pages/HomePage").then((module) => ({ Component: module.HomePage })),
  accounts: () =>
    import("../pages/AccountsPage").then((module) => ({ Component: module.AccountsPage })),
  account: () =>
    import("../pages/AccountDetailPage").then((module) => ({
      Component: module.AccountDetailPage,
    })),
  connect: () =>
    import("../pages/ConnectPage").then((module) => ({ Component: module.ConnectPage })),
  connectCallback: () =>
    import("../pages/ConnectCallbackPage").then((module) => ({
      Component: module.ConnectCallbackPage,
    })),
};
