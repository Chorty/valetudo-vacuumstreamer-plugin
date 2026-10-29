const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { describe, it } = require("node:test");
// The plugin has no package.json; its tests run in the backend workspace, which provides express.
// eslint-disable-next-line node/no-extraneous-require, node/no-unpublished-require
const express = require("express");

const DEFAULT_CONFIG = require("../../backend/lib/res/default_config.json");
const Logger = require("../../backend/lib/Logger");
const MockValetudoRobot = require("../../backend/lib/robots/mock/MockValetudoRobot");
const VacuumstreamerWebServer = require("../backend/VacuumstreamerWebServer");
const ValetudoEventStore = require("../../backend/lib/ValetudoEventStore");
const WebServer = require("../../backend/lib/webserver/WebServer");

const FRONTEND_BUILD = path.join(__dirname, "../../frontend/build");

/**
 * A frontend build in a temporary directory: one hashed bundle with both
 * sidecars, one without any, and an index.html.
 *
 * @param {any} t
 */
function temporaryBuild(t) {
    const build = fs.mkdtempSync(path.join(os.tmpdir(), "valetudo-build-"));
    t.after(() => fs.rmSync(build, {recursive: true, force: true}));

    const bundle = Buffer.from("console.log('main');".repeat(100));
    fs.mkdirSync(path.join(build, "static", "js"), {recursive: true});
    fs.writeFileSync(path.join(build, "static", "js", "main.abc12345.js"), bundle);
    fs.writeFileSync(path.join(build, "static", "js", "main.abc12345.js.br"), zlib.brotliCompressSync(bundle));
    fs.writeFileSync(path.join(build, "static", "js", "main.abc12345.js.gz"), zlib.gzipSync(bundle));
    fs.writeFileSync(path.join(build, "static", "js", "plain.def67890.js"), "plain");
    fs.writeFileSync(path.join(build, "index.html"), "<!doctype html>");
    return {build: build, bundle: bundle};
}

/**
 * Serves `app` on a loopback port and closes it when the test ends.
 *
 * @param {any} t
 * @param {import("node:http").Server} server
 */
async function listening(t, server) {
    if (!server.listening) {
        await new Promise(resolve => server.once("listening", resolve));
    }
    t.after(() => {
        server.closeAllConnections();
        server.close();
    });
    return `http://127.0.0.1:${server.address().port}`;
}

/**
 * The real WebServer with MockValetudoRobot, on a free port, with
 * VALETUDO_SLOW_REQUEST_MS=100 and a robot that adds two slow test routes.
 *
 * @param {any} t
 */
async function webServer(t) {
    const settings = structuredClone(DEFAULT_CONFIG);
    settings.webserver.port = 0;
    const config = {
        get: key => settings[key],
        set: () => {},
        onUpdate: () => {},
    };

    class SlowRoutesRobot extends MockValetudoRobot {
        initModelSpecificWebserverRoutes(app) {
            app.get("/test/slow", (req, res) => {
                setTimeout(() => res.send("slow"), 150);
            });
            app.get("/test/stream", (req, res) => {
                res.locals.longLivedStream = true;
                setTimeout(() => res.send("stream"), 150);
            });
        }
    }

    // MockValetudoRobot's battery and consumable timers are never cleared; unref them so the test process can exit.
    const setInterval = global.setInterval;
    global.setInterval = (...args) => setInterval(...args).unref();
    let robot;
    try {
        robot = new SlowRoutesRobot({config: config, valetudoEventStore: new ValetudoEventStore({})});
    } finally {
        global.setInterval = setInterval;
    }

    const previousThreshold = process.env.VALETUDO_SLOW_REQUEST_MS;
    process.env.VALETUDO_SLOW_REQUEST_MS = "100";
    let server;
    try {
        server = new WebServer({
            robot: robot,
            config: config,
            mqttController: {},
            networkAdvertisementManager: {},
            ntpClient: {},
            updater: {},
            scheduler: {},
            valetudoEventStore: new ValetudoEventStore({}),
            phoenixManager: {},
            valetudoHelper: {},
        });
    } finally {
        if (previousThreshold === undefined) {
            delete process.env.VALETUDO_SLOW_REQUEST_MS;
        } else {
            process.env.VALETUDO_SLOW_REQUEST_MS = previousThreshold;
        }
    }
    return listening(t, server.webserver);
}

/**
 * A hashed bundle from the real frontend build that has a Brotli sidecar, or
 * null when the frontend has not been built.
 */
function builtBundle() {
    const directory = path.join(FRONTEND_BUILD, "static", "js");
    if (!fs.existsSync(path.join(FRONTEND_BUILD, "index.html")) || !fs.existsSync(directory)) {
        return null;
    }
    const name = fs.readdirSync(directory).find(file => /^main\.[0-9a-f]+\.js$/.test(file) && fs.existsSync(path.join(directory, file + ".br")));
    return name ? {url: `/static/js/${name}`, file: path.join(directory, name)} : null;
}

function slowRequestWarnings(t) {
    const warn = t.mock.method(Logger, "warn", () => {});
    return () => warn.mock.calls.filter(call => call.arguments[0] === "Slow HTTP request").map(call => call.arguments[1]);
}

describe("VacuumstreamerWebServer", () => {
    describe("frontendAssets", () => {
        async function app(t) {
            const {build, bundle} = temporaryBuild(t);
            const app = express();
            VacuumstreamerWebServer.frontendAssets(app, build);
            // Upstream's own handler, which WebServer.js registers right after.
            app.use(express.static(build));
            const server = app.listen(0, "127.0.0.1");
            return {base: await listening(t, server), bundle: bundle};
        }

        it("serves a hashed bundle's sidecar with immutable caching", async (t) => {
            const {base, bundle} = await app(t);

            for (const [accept, encoding] of [["br", "br"], ["gzip", "gzip"], ["br;q=0, gzip", "gzip"]]) {
                const res = await fetch(`${base}/static/js/main.abc12345.js`, {headers: {"Accept-Encoding": accept}});

                assert.equal(res.status, 200, accept);
                assert.equal(res.headers.get("content-encoding"), encoding, accept);
                assert.match(res.headers.get("content-type"), /javascript/, accept);
                assert.equal(res.headers.get("cache-control"), "public, max-age=31536000, immutable", accept);
                assert.match(res.headers.get("vary"), /Accept-Encoding/, accept);
                assert.deepEqual(Buffer.from(await res.arrayBuffer()), bundle, accept);
            }
        });

        it("falls back to the uncompressed file, still immutable", async (t) => {
            const {base, bundle} = await app(t);

            const identity = await fetch(`${base}/static/js/main.abc12345.js`, {headers: {"Accept-Encoding": "identity"}});
            assert.equal(identity.headers.get("content-encoding"), null);
            assert.equal(identity.headers.get("cache-control"), "public, max-age=31536000, immutable");
            assert.deepEqual(Buffer.from(await identity.arrayBuffer()), bundle);

            const plain = await fetch(`${base}/static/js/plain.def67890.js`, {headers: {"Accept-Encoding": "br"}});
            assert.equal(plain.headers.get("content-encoding"), null);
            assert.equal(plain.headers.get("cache-control"), "public, max-age=31536000, immutable");
            assert.equal(await plain.text(), "plain");
        });

        it("leaves everything outside /static/ to upstream's handler", async (t) => {
            const {base} = await app(t);

            const res = await fetch(`${base}/`);

            assert.equal(res.status, 200);
            assert.equal(res.headers.get("cache-control"), "public, max-age=0");
            assert.ok(res.headers.get("etag"));
            assert.equal(await res.text(), "<!doctype html>");
        });

        it("refuses the 121st /static/ request within 10 s", async (t) => {
            const {base} = await app(t);

            for (let i = 0; i < 120; i++) {
                const res = await fetch(`${base}/static/js/plain.def67890.js`);
                assert.equal(res.status, 200, `request ${i + 1}`);
                await res.arrayBuffer();
            }
            assert.equal((await fetch(`${base}/static/js/plain.def67890.js`)).status, 429);
            assert.equal((await fetch(`${base}/`)).status, 200);
        });
    });

    describe("through the real WebServer", () => {
        it("reports a slow request but not a long-lived stream", async (t) => {
            const warnings = slowRequestWarnings(t);
            const base = await webServer(t);

            assert.equal(await (await fetch(`${base}/test/slow`)).text(), "slow");
            assert.equal(await (await fetch(`${base}/test/stream`)).text(), "stream");

            assert.deepEqual(warnings().map(warning => warning.path), ["/test/slow"]);
            assert.equal(warnings()[0].status, 200);
        });

        it("serves the frontend build with upstream's and the plugin's headers", async (t) => {
            const bundle = builtBundle();
            if (!bundle) {
                t.skip("frontend/build is missing; run npm run build --workspace=frontend (CI builds it before the tests)");
                return;
            }
            slowRequestWarnings(t);
            const base = await webServer(t);

            const asset = await fetch(base + bundle.url, {headers: {"Accept-Encoding": "br"}});
            assert.equal(asset.status, 200);
            assert.equal(asset.headers.get("content-encoding"), "br");
            assert.match(asset.headers.get("content-type"), /javascript/);
            assert.match(asset.headers.get("cache-control"), /immutable/);
            assert.deepEqual(Buffer.from(await asset.arrayBuffer()), fs.readFileSync(bundle.file));

            const index = await fetch(`${base}/`);
            assert.equal(index.status, 200);
            assert.ok(index.headers.get("etag"));
            assert.equal(index.headers.get("cache-control"), "public, max-age=0");
            await index.arrayBuffer();

            for (let i = 1; i < 120; i++) {
                await (await fetch(base + bundle.url)).arrayBuffer();
            }
            assert.equal((await fetch(base + bundle.url)).status, 429);
        });
    });
});
