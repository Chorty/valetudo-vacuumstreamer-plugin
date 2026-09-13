const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const DreameVideoStreamCapability = require("../backend/dreame-capabilities/DreameVideoStreamCapability");
const VideoStreamCapability = require("../backend/core-capabilities/VideoStreamCapability");

function createCapability() {
    const capability = new DreameVideoStreamCapability({robot: {}});
    capability._cameraCtlAvailable = () => false;

    capability._getPidOf = processName => processName === "video_monitor" ? 101 : 202;

    return capability;
}

test("video stream status reports process state without a fake quality value", async () => {
    const status = await createCapability().getStreamStatus();

    assert.deepEqual(status, {
        active: true,
        pid: 101,
        go2rtcPid: 202,
    });
    assert.equal(Object.hasOwn(status, "quality"), false);
});

test("video capabilities no longer advertise ineffective quality methods", () => {
    assert.equal(typeof VideoStreamCapability.prototype.setVideoQuality, "undefined");
    assert.equal(typeof VideoStreamCapability.prototype.getVideoQuality, "undefined");
    assert.deepEqual(createCapability().getProperties(), {});
});

test("uses the deployed video_monitor path by default", () => {
    assert.equal(createCapability().streamConfig.videoMonitorPath, "/data/vacuumstreamer/video_monitor");
});

test("a missing video_monitor rejects without an unhandled child error", async () => {
    const capability = new DreameVideoStreamCapability({
        robot: {},
        streamConfig: {
            videoMonitorPath: "/definitely/missing/video_monitor",
        },
    });
    capability._cameraCtlAvailable = () => false;
    capability._getPidOf = processName => processName === "go2rtc" ? 202 : null;
    capability._killProcess = () => undefined;

    await assert.rejects(capability.startStream(), error => error.code === "ENOENT");
});

test("stream URLs advertise the private-LAN address", async t => {
    t.mock.method(os, "networkInterfaces", () => ({
        lo: [{address: "127.0.0.1", family: "IPv4", internal: true}],
        wlan0: [{address: "192.168.1.31", family: "IPv4", internal: false}],
    }));

    assert.deepEqual(await createCapability().getStreamURLs(), {
        rtsp: "rtsp://192.168.1.31:8554/vacuum",
        webrtc: "http://192.168.1.31:1984/api/webrtc?src=vacuum",
        hls: "http://192.168.1.31:1984/api/stream.m3u8?src=vacuum",
        go2rtcApi: "http://192.168.1.31:1984/api/",
    });
});

test("serializes concurrent starts into one process pipeline", async () => {
    const capability = new DreameVideoStreamCapability({robot: {}});
    capability._cameraCtlAvailable = () => false;
    const running = new Set();
    const spawns = [];
    let releaseStartup;
    const startupGate = new Promise(resolve => {
        releaseStartup = resolve;
    });

    capability._getPidOf = processName => running.has(processName) ? 101 : null;
    capability._killProcess = processName => running.delete(processName);
    capability._spawnDetached = async (command, args, options, label) => {
        spawns.push(label);
        running.add(label);
        return {kill: () => running.delete(label)};
    };
    capability._sleep = async () => startupGate;

    const first = capability.startStream();
    const second = capability.startStream();
    await new Promise(resolve => setImmediate(resolve));
    releaseStartup();
    await Promise.all([first, second]);

    assert.deepEqual(spawns, ["go2rtc", "video_monitor"]);
});

test("preserves start then stop command order", async () => {
    const capability = new DreameVideoStreamCapability({robot: {}});
    capability._cameraCtlAvailable = () => false;
    const running = new Set();
    let releaseStartup;
    const startupGate = new Promise(resolve => {
        releaseStartup = resolve;
    });

    capability._getPidOf = processName => running.has(processName) ? 101 : null;
    capability._killProcess = processName => running.delete(processName);
    capability._spawnDetached = async (command, args, options, label) => {
        running.add(label);
        return {kill: () => running.delete(label)};
    };
    capability._sleep = async () => startupGate;

    const start = capability.startStream();
    const stop = capability.stopStream();
    await new Promise(resolve => setImmediate(resolve));
    releaseStartup();
    await Promise.all([start, stop]);

    assert.deepEqual([...running], []);
});

test("continues processing lifecycle commands after a failed start", async () => {
    const capability = new DreameVideoStreamCapability({robot: {}});
    capability._cameraCtlAvailable = () => false;
    const running = new Set();
    let shouldFail = true;

    capability._getPidOf = processName => running.has(processName) ? 101 : null;
    capability._killProcess = processName => running.delete(processName);
    capability._spawnDetached = async (command, args, options, label) => {
        if (shouldFail) {
            shouldFail = false;
            throw new Error("spawn failed");
        }
        running.add(label);
        return {kill: () => running.delete(label)};
    };
    capability._sleep = async () => undefined;

    await assert.rejects(capability.startStream(), /spawn failed/);
    await capability.startStream();

    assert.equal(running.has("video_monitor"), true);
});

function tempDirectory(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vacuumstreamer-camera-"));
    t.after(() => fs.rmSync(directory, {recursive: true, force: true}));

    return directory;
}

function writeScript(t, body) {
    const scriptPath = path.join(tempDirectory(t), "camera_ctl.sh");
    fs.writeFileSync(scriptPath, `#!/bin/sh\n${body}\n`, {mode: 0o755});

    return scriptPath;
}

test("delegates start and stop to camera_ctl.sh without touching processes itself", async () => {
    const capability = new DreameVideoStreamCapability({robot: {}});
    const actions = [];
    const touched = [];

    capability._cameraCtlAvailable = () => true;
    capability._runCameraCtl = async action => {
        actions.push(action);
    };
    capability._killProcess = processName => touched.push(`kill ${processName}`);
    capability._spawnDetached = async (command, args, options, label) => {
        touched.push(`spawn ${label}`);
        return {kill: () => undefined};
    };

    await capability.startStream();
    await capability.stopStream();

    assert.deepEqual(actions, ["start", "stop"]);
    assert.deepEqual(touched, []);
});

test("serializes camera_ctl.sh start and stop in arrival order", async () => {
    const capability = new DreameVideoStreamCapability({robot: {}});
    const actions = [];
    let releaseStart;
    const startGate = new Promise(resolve => {
        releaseStart = resolve;
    });

    capability._cameraCtlAvailable = () => true;
    capability._runCameraCtl = async action => {
        if (action === "start") {
            await startGate;
        }
        actions.push(action);
    };

    const start = capability.startStream();
    const stop = capability.stopStream();
    await new Promise(resolve => setImmediate(resolve));
    releaseStart();
    await Promise.all([start, stop]);

    assert.deepEqual(actions, ["start", "stop"]);
});

test("camera_ctl.sh receives the action without inherited preload or credential settings", async t => {
    const names = ["LD_PRELOAD", "CREDENTIALS_DIRECTORY", "GO2RTC_USERNAME", "GO2RTC_PASSWORD"];
    const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));

    for (const name of names) {
        process.env[name] = "inherited";
    }

    try {
        const capability = new DreameVideoStreamCapability({
            robot: {},
            streamConfig: {
                cameraCtlPath: writeScript(t, [
                    "[ \"$1\" = start ] || exit 2",
                    ...names.map(name => `[ -z "\${${name}+set}" ] || exit 3`),
                ].join("\n")),
            },
        });

        await capability._runCameraCtl("start");
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

test("a refused camera_ctl.sh start reports its reason", async t => {
    const capability = new DreameVideoStreamCapability({
        robot: {},
        streamConfig: {
            cameraCtlPath: writeScript(t, "echo \"camera_ctl: CAMERA_LOGIN=on requires the directory /data/vacuumstreamer/credentials\" >&2\nexit 78"),
        },
    });

    await assert.rejects(capability._runCameraCtl("start"), {
        message: "Video stream start failed: camera_ctl: CAMERA_LOGIN=on requires the directory /data/vacuumstreamer/credentials",
    });
});

test("status with camera_ctl.sh separates availability, capture and pause", async t => {
    const pausedFlagPath = path.join(tempDirectory(t), "camera_paused");
    const capability = new DreameVideoStreamCapability({
        robot: {},
        streamConfig: {
            pausedFlagPath: pausedFlagPath,
            cameraMode: "on_demand",
        },
    });

    capability._cameraCtlAvailable = () => true;
    capability._getPidOf = processName => processName === "go2rtc" ? 202 : null;

    assert.deepEqual(await capability.getStreamStatus(), {
        active: true,
        capturing: false,
        paused: false,
        mode: "on_demand",
        pid: null,
        go2rtcPid: 202,
    });

    fs.writeFileSync(pausedFlagPath, "");
    capability._statusCache = null;

    assert.deepEqual(await capability.getStreamStatus(), {
        active: false,
        capturing: false,
        paused: true,
        mode: "on_demand",
        pid: null,
        go2rtcPid: 202,
    });
});

test("without camera_ctl.sh the binaries start directly", async () => {
    const capability = new DreameVideoStreamCapability({robot: {}});
    const running = new Set();
    const spawns = [];

    capability._cameraCtlAvailable = () => false;
    capability._getPidOf = processName => running.has(processName) ? 101 : null;
    capability._killProcess = processName => running.delete(processName);
    capability._spawnDetached = async (command, args, options, label) => {
        spawns.push({command: command, args: args, label: label, env: options.env});
        running.add(label);
        return {kill: () => running.delete(label)};
    };
    capability._sleep = async () => undefined;

    await capability.startStream();

    assert.deepEqual(spawns.map(spawn => [spawn.label, spawn.command, spawn.args]), [
        ["go2rtc", "/data/vacuumstreamer/go2rtc", ["-config", "/data/vacuumstreamer/go2rtc.yaml"]],
        ["video_monitor", "/data/vacuumstreamer/video_monitor", []],
    ]);
    assert.equal(spawns[1].env.LD_PRELOAD, "/data/vacuumstreamer/vacuumstreamer.so");
});
