const assert = require("node:assert/strict");
const os = require("node:os");
const test = require("node:test");

const DreameVideoStreamCapability = require("../backend/dreame-capabilities/DreameVideoStreamCapability");
const VideoStreamCapability = require("../backend/core-capabilities/VideoStreamCapability");

function createCapability() {
    const capability = new DreameVideoStreamCapability({robot: {}});

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
