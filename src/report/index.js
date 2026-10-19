import express from "express";
import { adminEnabled, createReportAdminRouter } from "./admin.js";
import { createReportMcpRouter } from "./gateway.js";
import { createReportOAuthRouter, reportOAuthEnabled } from "./oauth.js";
import { createProvisionRouter } from "./provision.js";
import { createReportStore } from "./store.js";

// Report gateway module. Self-contained: it touches nothing outside
// src/report/ except the shared credential encryption helper, so it can be
// moved to its own service by copying this folder and migration 013.
// Off unless REPORT_ENABLED=true (also the kill switch: unset it and every
// /report* route answers 404).

export function reportStatus(env = process.env) {
  return { enabled: reportOAuthEnabled(env), dashboard: adminEnabled(env) };
}

const OWN_PATHS = /^(\/report(\/|-admin|$)|\/\.well-known\/oauth-(authorization-server|protected-resource)\/report)/;

export function createReportRouter({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const router = express.Router();
  const getStore = (req) => {
    if (req.app.locals.reportStore) return req.app.locals.reportStore;
    if (!req.app.locals.cachedReportStore) req.app.locals.cachedReportStore = createReportStore(env);
    return req.app.locals.cachedReportStore;
  };

  router.use(createReportOAuthRouter({ env, getStore, fetchImpl }));
  router.use(createReportMcpRouter({ env, getStore, fetchImpl }));
  router.use(createProvisionRouter({ env, getStore }));
  router.use(createReportAdminRouter({ env, getStore, fetchImpl }));

  // Express 5 forwards rejected async handlers here. A failure in this module
  // answers 500 for its own paths and never reaches the posting app's handlers.
  router.use((error, req, res, next) => {
    if (!OWN_PATHS.test(req.path)) return next(error);
    console.error("[report] unhandled", error?.code || error?.name || "Error");
    if (!res.headersSent) res.status(500).json({ error: "server_error" });
    return undefined;
  });
  return router;
}
