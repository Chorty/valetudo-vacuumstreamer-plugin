const assert = require("node:assert/strict");
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
