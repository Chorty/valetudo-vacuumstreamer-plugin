const CapabilityRouter = require("../../../backend/lib/webserver/capabilityRouters/CapabilityRouter");

class VideoStreamCapabilityRouter extends CapabilityRouter {
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

        this.router.get("/quality", async (req, res) => {
            try {
                const quality = await this.capability.getVideoQuality();
                res.json({quality: quality});
            } catch (e) {
                this.sendErrorResponse(req, res, e);
            }
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
                case "set_quality":
                    if (typeof req.body.value !== "string") {
                        res.sendStatus(400);
                        return;
                    }
                    try {
                        await this.capability.setVideoQuality(req.body.value);
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
}

module.exports = VideoStreamCapabilityRouter;
