const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

const Logger = require("../../backend/lib/Logger");
const MapManagementCapability = require("../backend/core-capabilities/MapManagementCapability");
const registerVacuumstreamerCapabilities = require("../backend/VacuumstreamerExtensions");
const TextToSpeechCapability = require("../backend/core-capabilities/TextToSpeechCapability");
const VideoStreamCapability = require("../backend/core-capabilities/VideoStreamCapability");

function register(t, options = {}) {
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
            }, options.switches),
            settings: Object.assign({CAMERA_MODE: "on_demand"}, options.settings),
            warnings: options.warnings ?? [],
        }),
    });

    return registered;
}

function types(capabilities) {
    return capabilities.map(capability => capability.getType());
}

test("registers every capability when all switches are on", t => {
    assert.deepEqual(types(register(t)), [
        VideoStreamCapability.TYPE,
        TextToSpeechCapability.TYPE,
        MapManagementCapability.TYPE,
    ]);
});

test("does not register the camera when it is switched off", t => {
    assert.deepEqual(types(register(t, {switches: {CAMERA: false}})), [
        TextToSpeechCapability.TYPE,
        MapManagementCapability.TYPE,
    ]);
});

test("does not register TTS or floor management when they are switched off", t => {
    assert.deepEqual(types(register(t, {switches: {TTS: false, MAP_MANAGEMENT: false}})), [
        VideoStreamCapability.TYPE,
    ]);
});

test("the camera capability uses camera_ctl.sh and the configured mode", t => {
    const [video] = register(t, {
        switches: {TTS: false, MAP_MANAGEMENT: false},
        settings: {CAMERA_MODE: "always"},
    });

    assert.equal(video.streamConfig.cameraCtlPath, "/data/vacuumstreamer/camera_ctl.sh");
    assert.equal(video.streamConfig.pausedFlagPath, "/tmp/vacuumstreamer/camera_paused");
    assert.equal(video.streamConfig.cameraMode, "always");
});

test("config warnings are logged", t => {
    const warn = t.mock.method(Logger, "warn", () => undefined);

    register(t, {warnings: ["invalid value for CAMERA in /test/vacuumstreamer.conf; using on"]});

    assert.deepEqual(warn.mock.calls.map(call => call.arguments), [
        ["VacuumStreamer: invalid value for CAMERA in /test/vacuumstreamer.conf; using on"],
    ]);
});
