const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const DreameMicrophoneGainCapability = require("../backend/dreame-capabilities/DreameMicrophoneGainCapability");
const MicrophoneGainCapability = require("../backend/core-capabilities/MicrophoneGainCapability");

function tempDirectory(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vacuumstreamer-mic-gain-"));
    t.after(() => fs.rmSync(directory, {recursive: true, force: true}));

    return directory;
}

function writeScript(t, body) {
    const scriptPath = path.join(tempDirectory(t), "mic_gain_ctl.sh");
    fs.writeFileSync(scriptPath, `#!/bin/sh\n${body}\n`, {mode: 0o755});

    return scriptPath;
}

function capabilityWithScript(t, body) {
    return new DreameMicrophoneGainCapability({
        robot: {},
        scriptConfig: {
            micGainCtlPath: writeScript(t, body),
        },
    });
}

test("uses the deployed script path by default", () => {
    const capability = new DreameMicrophoneGainCapability({robot: {}});

    assert.equal(capability.scriptConfig.micGainCtlPath, "/data/vacuumstreamer/mic_gain_ctl.sh");
});

test("getGain returns the mic_volume field from the script's JSON", async t => {
    const capability = capabilityWithScript(t, [
        "[ \"$1\" = get ] || exit 2",
        "echo '{\"mic_volume\":61,\"raw\":19}'",
    ].join("\n"));

    assert.equal(await capability.getGain(), 61);
});

test("setGain calls the script with set and the integer value as a plain argument", async t => {
    const capability = capabilityWithScript(t, [
        "[ \"$1\" = set ] || exit 2",
        "[ \"$2\" = 75 ] || exit 3",
        "echo '{\"mic_volume\":74,\"raw\":23}'",
    ].join("\n"));

    await capability.setGain(75);
});

test("setGain rejects a non-integer without invoking the script", async t => {
    const capability = capabilityWithScript(t, "echo should-not-run; exit 1");

    await assert.rejects(capability.setGain(50.5), /integer/);
});

test("setGain rejects an out-of-range value without invoking the script", async t => {
    const capability = capabilityWithScript(t, "echo should-not-run; exit 1");

    await assert.rejects(capability.setGain(101), /0 and 100/);
    await assert.rejects(capability.setGain(-1), /0 and 100/);
});

test("a script failure reports its stderr", async t => {
    const capability = capabilityWithScript(t, "echo 'mic_gain_ctl: invalid percentage: nope' >&2; exit 65");

    await assert.rejects(capability.getGain(), {
        message: "mic_gain_ctl get failed: mic_gain_ctl: invalid percentage: nope",
    });
});

test("invalid JSON from the script is reported, not thrown as a parse crash", async t => {
    const capability = capabilityWithScript(t, "echo 'not json'");

    await assert.rejects(capability.getGain(), /returned invalid JSON/);
});

test("a missing script rejects without an unhandled child error", async () => {
    const capability = new DreameMicrophoneGainCapability({
        robot: {},
        scriptConfig: {micGainCtlPath: "/definitely/missing/mic_gain_ctl.sh"},
    });

    await assert.rejects(capability.getGain(), error => error.code === "ENOENT");
});

test("getProperties advertises the 0-100 range", () => {
    const capability = new DreameMicrophoneGainCapability({robot: {}});

    assert.deepEqual(capability.getProperties(), {min: 0, max: 100});
});

test("setGain validates against the advertised range, not a hardcoded one", async t => {
    const capability = capabilityWithScript(t, "echo should-not-run; exit 1");

    capability.getProperties = () => ({min: 10, max: 20});

    await assert.rejects(capability.setGain(9), /between 10 and 20/);
    await assert.rejects(capability.setGain(21), /between 10 and 20/);
});

test("mic_gain_ctl.sh receives the action without inherited preload or credential settings", async t => {
    const names = ["LD_PRELOAD", "CREDENTIALS_DIRECTORY", "GO2RTC_USERNAME", "GO2RTC_PASSWORD"];
    const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));

    for (const name of names) {
        process.env[name] = "inherited";
    }

    try {
        const capability = capabilityWithScript(t, [
            "[ \"$1\" = get ] || exit 2",
            ...names.map(name => `[ -z "\${${name}+set}" ] || exit 3`),
            "echo '{\"mic_volume\":0,\"raw\":0}'",
        ].join("\n"));

        await capability.getGain();
    } finally {
        for (const name of names) {
            if (saved[name] === undefined) {
                delete process.env[name];
            } else {
                process.env[name] = saved[name];
            }
        }
    }
});

test("getType returns the capability type", () => {
    const capability = new DreameMicrophoneGainCapability({robot: {}});

    assert.equal(capability.getType(), MicrophoneGainCapability.TYPE);
});
