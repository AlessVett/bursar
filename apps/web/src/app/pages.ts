import type { ComponentType } from "react";
import type { RouteId } from "./routes";

export type PageLoader = () => Promise<{ Component: ComponentType }>;

/**
 * Lazy page modules by route id. A page task adds its entry here and flips `shipped` in `routes.ts`;
 * the router registers a shipped route only when its loader exists.
 */
export const PAGE_LOADERS: Partial<Record<RouteId, PageLoader>> = {
  home: () => import("../pages/HomePage").then((module) => ({ Component: module.HomePage })),
};
