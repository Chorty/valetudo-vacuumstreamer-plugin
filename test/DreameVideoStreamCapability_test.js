const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const DreameVideoStreamCapability = require("../backend/dreame-capabilities/DreameVideoStreamCapability");
const VideoStreamCapability = require("../backend/core-capabilities/VideoStreamCapability");

function createCapability() {
    const capability = new DreameVideoStreamCapability({robot: {}});
    capability._launchersAvailable = () => false;

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
    capability._launchersAvailable = () => false;
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
    capability._launchersAvailable = () => false;
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
    capability._launchersAvailable = () => false;
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
    capability._launchersAvailable = () => false;
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

function createLauncherCapability() {
    const capability = new DreameVideoStreamCapability({robot: {}});
    const running = new Set();
    const spawns = [];
    const checks = [];
    const killed = [];

    capability._launchersAvailable = () => true;
    capability._runLauncherCheck = async launcherPath => {
        checks.push(launcherPath);
    };
    capability._getPidOf = processName => running.has(processName) ? 101 : null;
    capability._killProcess = processName => {
        killed.push(processName);
        running.delete(processName);
    };
    capability._spawnDetached = async (command, args, options, label) => {
        spawns.push({command: command, args: args, label: label, env: options.env});
        running.add(label);
        return {kill: () => running.delete(label)};
    };
    capability._sleep = async () => undefined;

    return {
        capability: capability,
        running: running,
        spawns: spawns,
        checks: checks,
        killed: killed,
    };
}

test("checks and then starts the pipeline through the launch scripts", async () => {
    const {capability, spawns, checks} = createLauncherCapability();

    await capability.startStream();

    assert.deepEqual(checks, [
        "/data/vacuumstreamer/go2rtc_launch.sh",
        "/data/vacuumstreamer/video_monitor_launch.sh",
    ]);
    assert.deepEqual(spawns.map(spawn => [spawn.label, spawn.command, spawn.args]), [
        ["go2rtc", "/data/vacuumstreamer/go2rtc_launch.sh", []],
        ["video_monitor", "/data/vacuumstreamer/video_monitor_launch.sh", []],
    ]);
});

test("launch scripts do not inherit preload or credential settings", async () => {
    const names = ["LD_PRELOAD", "CREDENTIALS_DIRECTORY", "GO2RTC_USERNAME", "GO2RTC_PASSWORD"];
    const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));

    for (const name of names) {
        process.env[name] = "inherited";
    }

    try {
        const {capability, spawns} = createLauncherCapability();

        await capability.startStream();

        for (const spawn of spawns) {
            for (const name of names) {
                assert.equal(Object.hasOwn(spawn.env, name), false, `${spawn.label} inherited ${name}`);
            }
        }
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

test("a refused launch check leaves running processes untouched", async () => {
    const {capability, running, spawns, killed} = createLauncherCapability();

    running.add("go2rtc");
    capability._runLauncherCheck = async () => {
        throw new Error("Video stream start refused: go2rtc_launch: CAMERA_LOGIN=on requires the directory");
    };

    await assert.rejects(capability.startStream(), /CAMERA_LOGIN=on requires the directory/);
    assert.deepEqual(killed, []);
    assert.deepEqual(spawns, []);
    assert.equal(running.has("go2rtc"), true);
});

test("without launch scripts the binaries start directly", async () => {
    const {capability, spawns} = createLauncherCapability();

    capability._launchersAvailable = () => false;
    await capability.startStream();

    assert.deepEqual(spawns.map(spawn => [spawn.label, spawn.command, spawn.args]), [
        ["go2rtc", "/data/vacuumstreamer/go2rtc", ["-config", "/data/vacuumstreamer/go2rtc.yaml"]],
        ["video_monitor", "/data/vacuumstreamer/video_monitor", []],
    ]);
    assert.equal(spawns[1].env.LD_PRELOAD, "/data/vacuumstreamer/vacuumstreamer.so");
});

test("the launch check passes a script's success and reports its refusal reason", async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vacuumstreamer-launcher-"));
    t.after(() => fs.rmSync(directory, {recursive: true, force: true}));

    const accepting = path.join(directory, "accept.sh");
    const refusing = path.join(directory, "refuse.sh");
    fs.writeFileSync(accepting, "#!/bin/sh\n[ \"$1\" = --check ] || exit 1\nexit 0\n", {mode: 0o755});
    fs.writeFileSync(refusing, "#!/bin/sh\necho \"go2rtc_launch: CAMERA=off in /data/vacuumstreamer/vacuumstreamer.conf\" >&2\nexit 75\n", {mode: 0o755});

    const capability = new DreameVideoStreamCapability({robot: {}});

    await capability._runLauncherCheck(accepting);
    await assert.rejects(
        capability._runLauncherCheck(refusing),
        {message: "Video stream start refused: go2rtc_launch: CAMERA=off in /data/vacuumstreamer/vacuumstreamer.conf"}
    );
});
