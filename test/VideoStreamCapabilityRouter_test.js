const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
// The plugin has no package.json; its tests run in the backend workspace, which provides express.
// eslint-disable-next-line node/no-unpublished-require
const express = require("express");

const VideoStreamCapabilityRouter = require("../backend/capability-routers/VideoStreamCapabilityRouter");

/**
 * Starts a fake go2rtc and Valetudo in front of it. The fake records every
 * request path and keeps live.mp4 responses open until the client leaves.
 *
 * @param {any} t
 */
async function setup(t) {
    const seen = [];
    const closed = [];
    const go2rtc = http.createServer((req, res) => {
        seen.push(req.url);
        if (req.url.startsWith("/api/stream.mp4")) {
            res.writeHead(200, {"Content-Type": "video/mp4; codecs=\"avc1.4D001F\""});
            res.write(Buffer.from("ftypiso5"));
            req.socket.once("close", () => closed.push(req.url));
            return;
        }
        if (req.url.startsWith("/api/stream.m3u8")) {
            res.writeHead(200, {"Content-Type": "application/vnd.apple.mpegurl"});
            res.end("#EXTM3U\nhls/playlist.m3u8?id=Abc123\n");
            return;
        }
        if (req.url.startsWith("/api/hls/segment.m4s")) {
            res.writeHead(200, {"Content-Type": "video/iso.segment"});
            res.end("segment");
            return;
        }
        res.writeHead(404);
        res.end("404 page not found");
    });
    await new Promise(resolve => go2rtc.listen(0, "127.0.0.1", resolve));

    const router = new VideoStreamCapabilityRouter({
        capability: {streamConfig: {go2rtcApiPort: go2rtc.address().port}, getProperties: () => ({})},
        validator: (req, res, next) => next(),
    });
    const app = express();
    app.use("/VideoStreamCapability", router.router);
    const valetudo = http.createServer(app);
    await new Promise(resolve => valetudo.listen(0, "127.0.0.1", resolve));

    t.after(() => {
        valetudo.closeAllConnections();
        go2rtc.closeAllConnections();
        valetudo.close();
        go2rtc.close();
    });
    return {base: `http://127.0.0.1:${valetudo.address().port}/VideoStreamCapability`, seen: seen, closed: closed, router: router};
}

function get(url) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, res => {
            const chunks = [];
            res.on("data", chunk => chunks.push(chunk));
            res.on("end", () => resolve({status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString()}));
        });
        req.on("error", reject);
    });
}

/**
 * Opens a live stream and resolves once the first bytes arrive; the request stays open.
 *
 * @param {string} url
 */
function openLive(url) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, res => {
            if (res.statusCode !== 200) {
                res.resume();
                resolve({status: res.statusCode, req: req});
                return;
            }
            res.once("data", () => resolve({status: res.statusCode, headers: res.headers, req: req}));
        });
        req.on("error", reject);
    });
}

const waitFor = async (predicate) => {
    for (let i = 0; i < 100 && !predicate(); i++) {
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(predicate());
};

test("live.mp4 pipes go2rtc's video stream with no-transform and the fixed stream name", async (t) => {
    const {base, seen} = await setup(t);
    const live = await openLive(`${base}/live.mp4?src=other`);

    assert.equal(live.status, 200);
    assert.match(live.headers["content-type"], /^video\/mp4/);
    assert.equal(live.headers["cache-control"], "no-store, no-transform");
    assert.deepEqual(seen, ["/api/stream.mp4?src=vacuum"]);
    live.req.destroy();
});

test("a viewer leaving closes the upstream pull and frees its slot", async (t) => {
    const {base, closed, router} = await setup(t);
    const live = await openLive(`${base}/live.mp4`);
    assert.equal(router.activeLiveStreams, 1);

    live.req.destroy();
    await waitFor(() => closed.length === 1 && router.activeLiveStreams === 0);
});

test("live viewers are capped", async (t) => {
    const {base} = await setup(t);
    const open = [];
    for (let i = 0; i < VideoStreamCapabilityRouter.MAX_LIVE_STREAMS; i++) {
        open.push(await openLive(`${base}/live.mp4`));
    }
    const refused = await openLive(`${base}/live.mp4`);

    assert.equal(refused.status, 429);
    open.forEach(live => live.req.destroy());
});

test("HLS uses go2rtc's video-only fMP4 playlist and relative session paths", async (t) => {
    const {base, seen} = await setup(t);
    const playlist = await get(`${base}/live.m3u8`);
    const segment = await get(`${base}/hls/segment.m4s?id=Abc123&n=7&extra=1`);

    assert.equal(playlist.status, 200);
    assert.match(playlist.body, /hls\/playlist\.m3u8\?id=Abc123/);
    assert.equal(segment.status, 200);
    assert.deepEqual(seen, ["/api/stream.m3u8?src=vacuum&mp4", "/api/hls/segment.m4s?id=Abc123&n=7"]);
});

test("only go2rtc's HLS files with plain ids are forwarded", async (t) => {
    const {base, seen} = await setup(t);
    for (const [path, status] of [
        ["/hls/streams?id=Abc", 404],
        ["/hls/..%2F..%2Fconfig?id=Abc", 404],
        ["/hls/playlist.m3u8", 400],
        ["/hls/playlist.m3u8?id=a%26src%3Dx", 400],
        ["/hls/segment.m4s?id=Abc123", 400],
        ["/hls/segment.m4s?id=Abc123&n=1&n=2", 400],
    ]) {
        assert.equal((await get(base + path)).status, status, path);
    }
    assert.deepEqual(seen, []);
});

test("go2rtc errors become 404 or 502 without leaking its body", async (t) => {
    const {base} = await setup(t);
    const expired = await get(`${base}/hls/playlist.m3u8?id=Gone1`);

    assert.equal(expired.status, 404);
    assert.equal(expired.body.includes("page not found"), false);
});

test("an unreachable go2rtc answers 502", async () => {
    const router = new VideoStreamCapabilityRouter({
        capability: {streamConfig: {go2rtcApiPort: 1}, getProperties: () => ({})},
        validator: (req, res, next) => next(),
    });
    const app = express();
    app.use("/v", router.router);
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
        const response = await get(`http://127.0.0.1:${server.address().port}/v/live.m3u8`);
        assert.equal(response.status, 502);
    } finally {
        server.close();
    }
});
