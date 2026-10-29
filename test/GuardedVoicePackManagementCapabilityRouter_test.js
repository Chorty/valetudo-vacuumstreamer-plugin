const assert = require("node:assert/strict");
const http = require("node:http");
const { describe, it } = require("node:test");
// The plugin has no package.json; its tests run in the backend workspace, which provides express.
// eslint-disable-next-line node/no-unpublished-require
const express = require("express");

const CapabilitiesRouter = require("../../backend/lib/webserver/CapabilitiesRouter");
const GuardedVoicePackManagementCapabilityRouter = require("../backend/capability-routers/GuardedVoicePackManagementCapabilityRouter");
const VoicePackManagementCapability = require("../../backend/lib/core/capabilities/VoicePackManagementCapability");

const isAllowed = GuardedVoicePackManagementCapabilityRouter.IS_ALLOWED_VOICE_PACK_URL;

/**
 * Mounts the robot's capability routers the way Valetudo does, through
 * CapabilitiesRouter and so through the plugin's router mapping, for a robot
 * whose only capability is a fake voice-pack capability.
 *
 * @param {any} t
 */
async function setup(t) {
    const downloads = [];
    const capability = {
        getType: () => VoicePackManagementCapability.TYPE,
        getProperties: () => ({}),
        getCurrentVoiceLanguage: async () => "EN",
        getVoicePackOperationStatus: async () => ({type: "idle"}),
        downloadVoicePack: async (options) => {
            downloads.push(options);
        },
    };
    const router = new CapabilitiesRouter({
        robot: {capabilities: {[VoicePackManagementCapability.TYPE]: capability}},
        validator: (req, res, next) => next(),
    });
    const app = express();
    app.use(express.json());
    app.use("/capabilities", router.getRouter());
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));

    t.after(() => {
        server.closeAllConnections();
        server.close();
    });
    return {base: `http://127.0.0.1:${server.address().port}/capabilities/${VoicePackManagementCapability.TYPE}`, downloads: downloads};
}

function put(url, body) {
    return fetch(url, {method: "PUT", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)});
}

describe("GuardedVoicePackManagementCapabilityRouter", () => {
    describe("IS_ALLOWED_VOICE_PACK_URL", () => {
        it("allows http(s) packs on the LAN and the internet", () => {
            for (const url of [
                "http://host_or_ip/custom.tar.gz",
                "http://192.168.1.50:8000/voice.tar.gz",
                "http://10.0.0.2/voice.tar.gz",
                "https://example.com/packs/voice.tar.gz",
                "http://nas.local/voice.tar.gz",
                "http://[2001:db8::1]/voice.tar.gz",
            ]) {
                assert.equal(isAllowed(url), true, url);
            }
        });

        it("refuses the robot's own loopback in every spelling the parser accepts", () => {
            for (const url of [
                "http://127.0.0.1:1984/api/streams",
                "http://127.1/",
                "http://2130706433/",
                "http://0x7f.0.0.1/",
                "http://localhost/",
                "http://LOCALHOST./",
                "http://go2rtc.localhost/",
                "http://0.0.0.0/",
                "http://[::1]/",
                "http://[::]/",
                "http://[::ffff:127.0.0.1]/",
            ]) {
                assert.equal(isAllowed(url), false, url);
            }
        });

        it("refuses link-local addresses", () => {
            for (const url of ["http://169.254.169.254/latest/meta-data", "http://[fe80::1]/"]) {
                assert.equal(isAllowed(url), false, url);
            }
        });

        it("refuses other schemes, embedded credentials and unparsable input", () => {
            for (const url of [
                "file:///data/valetudo_config.json",
                "ftp://192.168.1.50/voice.tar.gz",
                "http://user:pass@192.168.1.50/voice.tar.gz",
                "not a url",
                "",
            ]) {
                assert.equal(isAllowed(url), false, url);
            }
        });
    });

    describe("through CapabilitiesRouter", () => {
        it("refuses a refused URL with 400 before the capability sees it", async (t) => {
            const {base, downloads} = await setup(t);

            for (const url of ["http://127.0.0.1:1984/api/streams", "http://[fe80::1]/", "http://user:pass@192.168.1.50/v.tar.gz", "file:///etc/passwd"]) {
                const res = await put(base, {action: "download", url: url, language: "EN", hash: "abc"});

                assert.equal(res.status, 400, url);
                assert.match((await res.json()).message, /must not target the robot itself/, url);
            }
            assert.deepEqual(downloads, []);
        });

        it("passes an allowed URL on to upstream's route", async (t) => {
            const {base, downloads} = await setup(t);

            const res = await put(base, {action: "download", url: "http://192.168.1.50:8000/voice.tar.gz", language: "EN", hash: "abc"});

            assert.equal(res.status, 200);
            assert.deepEqual(downloads, [{url: "http://192.168.1.50:8000/voice.tar.gz", language: "EN", hash: "abc"}]);
        });

        it("leaves upstream's handling of other requests unchanged", async (t) => {
            const {base, downloads} = await setup(t);

            assert.equal((await put(base, {action: "download"})).status, 400);
            assert.equal((await put(base, {action: "something_else", url: "http://127.0.0.1/"})).status, 400);

            const res = await fetch(base);
            assert.equal(res.status, 200);
            assert.deepEqual(await res.json(), {currentLanguage: "EN", operationStatus: {type: "idle"}});
            assert.deepEqual(downloads, []);
        });
    });
});
