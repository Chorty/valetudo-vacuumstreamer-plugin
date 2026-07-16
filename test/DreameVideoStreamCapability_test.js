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
