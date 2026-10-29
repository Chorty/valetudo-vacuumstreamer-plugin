// The plugin has no package.json; these resolve to upstream's dependencies, hoisted to the root node_modules.
// eslint-disable-next-line node/no-extraneous-require, node/no-unpublished-require
const express = require("express");
const path = require("path");
// eslint-disable-next-line node/no-extraneous-require, node/no-unpublished-require
const RateLimit = require("express-rate-limit");

const PrecompressedStaticMiddleware = require("./middlewares/PrecompressedStaticMiddleware");
const SlowRequestMiddleware = require("./middlewares/SlowRequestMiddleware");

/*
 * WebServer.js calls these at two fixed points. They are fork behavior, not
 * VacuumStreamer features, so no vacuumstreamer.conf switch turns them off.
 */

/**
 * Called after upstream's header middlewares and before the external-access
 * check, so slow-request timing covers every request that reaches a route.
 *
 * @param {import("express").Express} app
 */
function beforeRoutes(app) {
    app.use(SlowRequestMiddleware());
}

/**
 * Called just before upstream's own express.static for the frontend build.
 * Content-hashed files under /static/ are rate-limited and served with
 * immutable one-year caching, as a precompressed .br/.gz sidecar when the
 * client accepts one. Everything else, index.html included, falls through to
 * upstream's handler and its ETag and max-age=0 defaults.
 *
 * @param {import("express").Express} app
 * @param {string} frontendBuildPath
 */
function frontendAssets(app, frontendBuildPath) {
    const staticPath = path.join(frontendBuildPath, "static");

    app.use(
        "/static/",
        RateLimit.rateLimit({
            windowMs: 10*1000,
            max: 120,
            standardHeaders: false,
            legacyHeaders: false
        }),
        PrecompressedStaticMiddleware({
            assets: PrecompressedStaticMiddleware.buildAssetIndex(staticPath),
            root: staticPath
        })
    );
    app.use("/static/", express.static(staticPath, {
        immutable: true,
        maxAge: "1y"
    }));
}

module.exports = {
    beforeRoutes: beforeRoutes,
    frontendAssets: frontendAssets,
};
