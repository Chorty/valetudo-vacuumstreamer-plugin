const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const DreameRecorderQualityCapability = require("../backend/dreame-capabilities/DreameRecorderQualityCapability");
const RecorderQualityCapability = require("../backend/core-capabilities/RecorderQualityCapability");

function tempDirectory(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vacuumstreamer-recorder-quality-"));
    t.after(() => fs.rmSync(directory, {recursive: true, force: true}));

    return directory;
}

function writeScript(t, body) {
    const scriptPath = path.join(tempDirectory(t), "recorder_quality_ctl.sh");
    fs.writeFileSync(scriptPath, `#!/bin/sh\n${body}\n`, {mode: 0o755});

    return scriptPath;
}

function capabilityWithScript(t, body) {
    return new DreameRecorderQualityCapability({
        robot: {},
        scriptConfig: {
            recorderQualityCtlPath: writeScript(t, body),
        },
    });
}

test("uses the deployed script path by default", () => {
    const capability = new DreameRecorderQualityCapability({robot: {}});

    assert.equal(capability.scriptConfig.recorderQualityCtlPath, "/data/vacuumstreamer/recorder_quality_ctl.sh");
});

test("getQuality returns the script's parsed JSON", async t => {
    const capability = capabilityWithScript(t, [
        "[ \"$1\" = get ] || exit 2",
        "echo '{\"profile\":\"low\",\"width\":864,\"height\":480,\"framerate\":15,\"bitrate\":600000}'",
    ].join("\n"));

    assert.deepEqual(await capability.getQuality(), {
        profile: "low", width: 864, height: 480, framerate: 15, bitrate: 600000,
    });
});

test("setQuality calls the script with set and the profile", async t => {
    const capability = capabilityWithScript(t, [
        "[ \"$1\" = set ] || exit 2",
        "[ \"$2\" = high ] || exit 3",
        "echo '{\"profile\":\"high\",\"width\":640,\"height\":480,\"framerate\":25,\"bitrate\":2000000}'",
    ].join("\n"));

    assert.deepEqual(await capability.setQuality("high"), {
        profile: "high", width: 640, height: 480, framerate: 25, bitrate: 2000000,
    });
});

test("setQuality rejects an unsupported profile without invoking the script", async t => {
    const capability = capabilityWithScript(t, "echo should-not-run; exit 1");

    await assert.rejects(capability.setQuality("ultra"), /Unsupported recorder quality profile/);
});

test("a script failure reports its stderr", async t => {
    const capability = capabilityWithScript(t, "echo 'recorder_quality_ctl: not writable' >&2; exit 66");

    await assert.rejects(capability.getQuality(), {
        message: "recorder_quality_ctl get failed: recorder_quality_ctl: not writable",
    });
});

test("invalid JSON from the script is reported, not thrown as a parse crash", async t => {
    const capability = capabilityWithScript(t, "echo 'not json'");

    await assert.rejects(capability.getQuality(), /returned invalid JSON/);
});

test("a missing script rejects without an unhandled child error", async () => {
    const capability = new DreameRecorderQualityCapability({
        robot: {},
        scriptConfig: {recorderQualityCtlPath: "/definitely/missing/recorder_quality_ctl.sh"},
    });

    await assert.rejects(capability.getQuality(), error => error.code === "ENOENT");
});

test("getProperties advertises the supported profiles", () => {
    const capability = new DreameRecorderQualityCapability({robot: {}});

    assert.deepEqual(capability.getProperties(), {supportedProfiles: ["low", "high"]});
});

test("getType returns the capability type", () => {
    const capability = new DreameRecorderQualityCapability({robot: {}});

    assert.equal(capability.getType(), RecorderQualityCapability.TYPE);
});
