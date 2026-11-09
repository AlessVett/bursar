import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import type { JWTVerifyGetKey } from "jose";
import type { Logger } from "pino";
import { type AuthDeps, authRoutes, requireSession } from "../auth/routes";
import type { Config } from "../config";
import { accessGuard } from "./access";
import { originCheck } from "./origin";
import { webAppHandler } from "./static";

export type AppEnv = { Variables: { sessionId: number } };

/** Maximum /api request body: requests are small JSON documents. Uploads get their own limit. */
export const API_BODY_LIMIT_BYTES = 64 * 1024;

export interface AppDeps {
  config: Pick<Config, "publicUrl" | "cfAccess" | "webDistDir">;
  logger: Logger;
  healthCheck: () => boolean;
  accessKeys?: JWTVerifyGetKey;
  auth?: AuthDeps;
}

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    }),
  );

  app.use("*", async (c, next) => {
    const started = performance.now();
    await next();
    deps.logger.debug(
      {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        ms: Math.round(performance.now() - started),
      },
      "request",
    );
  });

  if (deps.config.cfAccess) {
    app.use("*", accessGuard({ ...deps.config.cfAccess, getKey: deps.accessKeys }));
  }

  app.get("/healthz", (c) =>
    deps.healthCheck() ? c.json({ ok: true }) : c.json({ ok: false }, 503),
  );

  app.use("/api/*", originCheck(deps.config.publicUrl));
  app.use(
    "/api/*",
    bodyLimit({
      maxSize: API_BODY_LIMIT_BYTES,
      onError: (c) => c.json({ error: "Request body too large" }, 413),
    }),
  );
  if (deps.auth) {
    app.route("/api/auth", authRoutes(deps.auth));
    app.use("/api/*", requireSession(deps.auth.sessions));
    app.get("/api/me", (c) => c.json({ authenticated: true }));
  }
  app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

  if (deps.config.webDistDir) {
    app.get("*", webAppHandler(deps.config.webDistDir));
  }

  app.onError((error, c) => {
    deps.logger.error({ error: error.message, stack: error.stack }, "Unhandled error");
    return c.json({ error: "Internal error" }, 500);
  });

  return app;
}
