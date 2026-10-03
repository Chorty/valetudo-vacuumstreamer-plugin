const http = require("http");

const CapabilityRouter = require("../../../backend/lib/webserver/capabilityRouters/CapabilityRouter");

// go2rtc.yaml publishes the camera under this stream name.
const STREAM_NAME = "vacuum";
// Every viewer is piped through Valetudo's own event loop; keep that bounded.
const MAX_LIVE_STREAMS = 2;
const UPSTREAM_IDLE_TIMEOUT_MS = 15000;
// go2rtc's HLS files and the query parameters each one needs.
const HLS_FILES = {
    "playlist.m3u8": ["id"],
    "init.mp4": ["id"],
    "segment.m4s": ["id", "n"],
    "segment.ts": ["id", "n"],
};
const HLS_PARAMETER = /^[A-Za-z0-9]{1,32}$/;

class VideoStreamCapabilityRouter extends CapabilityRouter {
    preInit() {
        this.activeLiveStreams = 0;
    }

    initRoutes() {
        this.router.get("/", async (req, res) => {
            try {
                const status = await this.capability.getStreamStatus();
                res.json(status);
            } catch (e) {
                this.sendErrorResponse(req, res, e);
            }
        });

        this.router.get("/urls", async (req, res) => {
            try {
                const urls = await this.capability.getStreamURLs();
                res.json(urls);
            } catch (e) {
                this.sendErrorResponse(req, res, e);
            }
        });

        // Browser playback through Valetudo's own login. go2rtc does not challenge
        // robot-local clients, so the browser never needs the camera credentials.
        // Video only: neither format includes the microphone track.
        this.router.get("/live.mp4", (req, res) => {
            if (this.activeLiveStreams >= MAX_LIVE_STREAMS) {
                res.status(429).json({message: "Too many live camera viewers"});
                return;
            }
            this.activeLiveStreams++;
            res.once("close", () => {
                this.activeLiveStreams--;
            });
            // Lets the slow-request telemetry skip a response that is meant to last.
            res.locals.longLivedStream = true;
            this.proxyGo2rtc(req, res, `/api/stream.mp4?src=${STREAM_NAME}`);
        });

        this.router.get("/live.m3u8", (req, res) => {
            this.proxyGo2rtc(req, res, `/api/stream.m3u8?src=${STREAM_NAME}&mp4`);
        });

        this.router.get("/hls/:file", (req, res) => {
            const parameters = HLS_FILES[req.params.file];
            if (!parameters) {
                res.sendStatus(404);
                return;
            }
            const query = new URLSearchParams();
            for (const name of parameters) {
                const value = req.query[name];
                if (typeof value !== "string" || !HLS_PARAMETER.test(value)) {
                    res.sendStatus(400);
                    return;
                }
                query.set(name, value);
            }
            this.proxyGo2rtc(req, res, `/api/hls/${req.params.file}?${query}`);
        });

        this.router.put("/", this.validator, async (req, res) => {
            switch (req.body.action) {
                case "start":
                    try {
                        await this.capability.startStream();
                        res.sendStatus(200);
                    } catch (e) {
                        this.sendErrorResponse(req, res, e);
                    }
                    break;
                case "stop":
                    try {
                        await this.capability.stopStream();
                        res.sendStatus(200);
                    } catch (e) {
                        this.sendErrorResponse(req, res, e);
                    }
                    break;
                default:
                    res.sendStatus(400);
            }
        });
    }

    /**
     * Pipes one go2rtc response to the client. Only fixed paths built by the
     * routes above reach here; client input is limited to validated HLS ids.
     *
     * @private
     * @param {any} req
     * @param {any} res
     * @param {string} path
     */
    proxyGo2rtc(req, res, path) {
        const upstream = http.get({
            host: "127.0.0.1",
            port: this.capability.streamConfig?.go2rtcApiPort ?? 1984,
            path: path,
            timeout: UPSTREAM_IDLE_TIMEOUT_MS,
        }, (incoming) => {
            if (incoming.statusCode !== 200) {
                incoming.resume();
                if (!res.headersSent) {
                    res.status(incoming.statusCode === 404 ? 404 : 502).json({message: "Camera stream unavailable"});
                }
                return;
            }
            res.status(200).set({
                "Content-Type": incoming.headers["content-type"] || "application/octet-stream",
                // no-transform keeps the compression middleware from buffering video.
                "Cache-Control": "no-store, no-transform",
                "X-Content-Type-Options": "nosniff",
            });
            incoming.pipe(res);
        });

        upstream.on("timeout", () => {
            upstream.destroy(new Error("go2rtc did not respond"));
        });
        upstream.on("error", () => {
            if (!res.headersSent) {
                res.status(502).json({message: "Camera stream unavailable"});
            } else {
                res.destroy();
            }
        });
        // A viewer leaving must stop the upstream pull at once.
        res.once("close", () => {
            upstream.destroy();
        });
    }
}

VideoStreamCapabilityRouter.MAX_LIVE_STREAMS = MAX_LIVE_STREAMS;

module.exports = VideoStreamCapabilityRouter;
