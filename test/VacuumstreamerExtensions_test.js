const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

const Logger = require("../../backend/lib/Logger");
const MapManagementCapability = require("../backend/core-capabilities/MapManagementCapability");
const registerVacuumstreamerCapabilities = require("../backend/VacuumstreamerExtensions");
const TextToSpeechCapability = require("../backend/core-capabilities/TextToSpeechCapability");
const VideoStreamCapability = require("../backend/core-capabilities/VideoStreamCapability");

function register(t, switches, warnings = []) {
    // Floor management creates its storage directory on construction
    t.mock.method(fs, "mkdirSync", () => undefined);

    const registered = [];
    const robot = {
        registerCapability: capability => registered.push(capability),
    };

    registerVacuumstreamerCapabilities(robot, {
        loadConfig: () => ({
            path: "/test/vacuumstreamer.conf",
            found: true,
            switches: Object.assign({
                CAMERA: true,
                CAMERA_LOGIN: false,
                TTS: true,
                MAP_MANAGEMENT: true,
                HTTP_BRIDGE: true,
            }, switches),
            warnings: warnings,
        }),
    });

    return registered;
}

function types(capabilities) {
    return capabilities.map(capability => capability.getType());
}

test("registers every capability when all switches are on", t => {
    assert.deepEqual(types(register(t, {})), [
        VideoStreamCapability.TYPE,
        TextToSpeechCapability.TYPE,
        MapManagementCapability.TYPE,
    ]);
});

test("does not register the camera when it is switched off", t => {
    assert.deepEqual(types(register(t, {CAMERA: false})), [
        TextToSpeechCapability.TYPE,
        MapManagementCapability.TYPE,
    ]);
});

test("does not register TTS or floor management when they are switched off", t => {
    assert.deepEqual(types(register(t, {TTS: false, MAP_MANAGEMENT: false})), [
        VideoStreamCapability.TYPE,
    ]);
});

test("the camera capability starts through the launch scripts", t => {
    const [video] = register(t, {TTS: false, MAP_MANAGEMENT: false});

    assert.equal(video.streamConfig.go2rtcLauncherPath, "/data/vacuumstreamer/go2rtc_launch.sh");
    assert.equal(video.streamConfig.videoMonitorLauncherPath, "/data/vacuumstreamer/video_monitor_launch.sh");
});

test("config warnings are logged", t => {
    const warn = t.mock.method(Logger, "warn", () => undefined);

    register(t, {}, ["invalid value for CAMERA in /test/vacuumstreamer.conf; using on"]);

    assert.deepEqual(warn.mock.calls.map(call => call.arguments), [
        ["VacuumStreamer: invalid value for CAMERA in /test/vacuumstreamer.conf; using on"],
    ]);
});
