const CapabilityRouter = require("../../../backend/lib/webserver/capabilityRouters/CapabilityRouter");

class RecorderQualityCapabilityRouter extends CapabilityRouter {
    initRoutes() {
        this.router.get("/", async (req, res) => {
            try {
                res.json(await this.capability.getQuality());
            } catch (e) {
                this.sendErrorResponse(req, res, e);
            }
        });

        this.router.put("/", this.validator, async (req, res) => {
            switch (req.body.action) {
                case "set_quality":
                    if (typeof req.body.profile !== "string") {
                        res.sendStatus(400);
                        return;
                    }

                    try {
                        res.json(await this.capability.setQuality(req.body.profile));
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

module.exports = RecorderQualityCapabilityRouter;
