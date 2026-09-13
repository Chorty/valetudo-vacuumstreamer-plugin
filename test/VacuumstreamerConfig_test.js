const assert = require("node:assert/strict");
const test = require("node:test");

const {loadVacuumstreamerConfig, parseConfigText} = require("../backend/VacuumstreamerConfig");

function load(text) {
    return loadVacuumstreamerConfig({
        path: "/test/vacuumstreamer.conf",
        readFile: () => text,
    });
}

const DEFAULT_SWITCHES = Object.freeze({
    CAMERA: true,
    CAMERA_LOGIN: false,
    TTS: true,
    MAP_MANAGEMENT: true,
    HTTP_BRIDGE: true,
});

test("a missing config file uses the defaults without warnings", () => {
    const config = loadVacuumstreamerConfig({
        path: "/test/missing.conf",
        readFile: () => {
            throw Object.assign(new Error("missing"), {code: "ENOENT"});
        },
    });

    assert.equal(config.found, false);
    assert.deepEqual(config.switches, DEFAULT_SWITCHES);
    assert.deepEqual(config.settings, {CAMERA_MODE: "on_demand"});
    assert.deepEqual(config.warnings, []);
});

test("an unreadable config file uses the defaults and warns", () => {
    const config = loadVacuumstreamerConfig({
        path: "/test/locked.conf",
        readFile: () => {
            throw Object.assign(new Error("denied"), {code: "EACCES"});
        },
    });

    assert.deepEqual(config.switches, DEFAULT_SWITCHES);
    assert.deepEqual(config.warnings, ["could not read /test/locked.conf (EACCES); using defaults"]);
});

test("switches can be turned off and on", () => {
    const config = load("CAMERA=off\nCAMERA_LOGIN=on\nTTS=off\nMAP_MANAGEMENT=off\nHTTP_BRIDGE=off\n");

    assert.equal(config.found, true);
    assert.deepEqual(config.switches, {
        CAMERA: false,
        CAMERA_LOGIN: true,
        TTS: false,
        MAP_MANAGEMENT: false,
        HTTP_BRIDGE: false,
    });
    assert.deepEqual(config.warnings, []);
});

test("parsing matches the shell reader for whitespace, comments and repeats", () => {
    assert.deepEqual(parseConfigText([
        "# comment",
        "  CAMERA = off   # trailing comment",
        "TTS=off",
        "TTS=on",
        "MAP_MANAGEMENT=off",
        "MAP_MANAGEMENT=",
        "HTTP_BRIDGE=off\r",
        "camera=off",
    ].join("\n")), {
        CAMERA: "off",
        TTS: "on",
        MAP_MANAGEMENT: "",
        HTTP_BRIDGE: "off",
    });
});

test("an empty last value falls back to the default", () => {
    assert.equal(load("MAP_MANAGEMENT=off\nMAP_MANAGEMENT=\n").switches.MAP_MANAGEMENT, true);
});

test("an invalid value falls back to the default and warns", () => {
    const config = load("CAMERA=maybe\nCAMERA_LOGIN=yes\n");

    assert.equal(config.switches.CAMERA, true);
    assert.equal(config.switches.CAMERA_LOGIN, false);
    assert.deepEqual(config.warnings, [
        "invalid value for CAMERA in /test/vacuumstreamer.conf; using on",
        "invalid value for CAMERA_LOGIN in /test/vacuumstreamer.conf; using off",
    ]);
});

test("the camera mode can be always", () => {
    assert.deepEqual(load("CAMERA_MODE=always\n").settings, {CAMERA_MODE: "always"});
});

test("an invalid camera mode falls back to on_demand and warns", () => {
    const config = load("CAMERA_MODE=sometimes\n");

    assert.deepEqual(config.settings, {CAMERA_MODE: "on_demand"});
    assert.deepEqual(config.warnings, ["invalid value for CAMERA_MODE in /test/vacuumstreamer.conf; using on_demand"]);
});

test("settings only the native scripts use are ignored", () => {
    const config = load("CAMERA_IDLE_SECONDS=180\nCAMERA_STALL_SECONDS=20\n");

    assert.deepEqual(config.switches, DEFAULT_SWITCHES);
    assert.deepEqual(config.warnings, []);
});
