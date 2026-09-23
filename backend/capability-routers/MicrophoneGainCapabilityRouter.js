const CapabilityRouter = require("../../../backend/lib/webserver/capabilityRouters/CapabilityRouter");

class MicrophoneGainCapabilityRouter extends CapabilityRouter {
    initRoutes() {
        this.router.get("/", async (req, res) => {
            try {
                res.json({
                    gain: await this.capability.getGain()
                });
            } catch (e) {
                this.sendErrorResponse(req, res, e);
            }
        });

        this.router.put("/", this.validator, async (req, res) => {
            switch (req.body.action) {
                case "set_gain":
                    if (typeof req.body.value !== "number") {
                        res.sendStatus(400);
                        return;
                    }

                    try {
                        await this.capability.setGain(req.body.value);
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

module.exports = MicrophoneGainCapabilityRouter;
