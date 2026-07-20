const CapabilityRouter = require("../../../backend/lib/webserver/capabilityRouters/CapabilityRouter");
const TextToSpeechCapabilityBusyError = require("../core-capabilities/TextToSpeechCapabilityBusyError");

class TextToSpeechCapabilityRouter extends CapabilityRouter {
    initRoutes() {
        this.router.get("/", async (req, res) => {
            try {
                const status = await this.capability.getStatus();
                res.json(status);
            } catch (e) {
                this.sendErrorResponse(req, res, e);
            }
        });

        this.router.put("/", this.validator, async (req, res) => {
            switch (req.body.action) {
                case "speak":
                    if (typeof req.body.text !== "string" || req.body.text.trim().length === 0) {
                        res.sendStatus(400);
                        return;
                    }
                    try {
                        await this.capability.speak(req.body.text, req.body.language);
                        res.sendStatus(200);
                    } catch (e) {
                        this.sendAudioErrorResponse(req, res, e);
                    }
                    break;
                case "play_file":
                    if (typeof req.body.filePath !== "string") {
                        res.sendStatus(400);
                        return;
                    }
                    try {
                        await this.capability.playAudioFile(req.body.filePath);
                        res.sendStatus(200);
                    } catch (e) {
                        this.sendAudioErrorResponse(req, res, e);
                    }
                    break;
                case "stop":
                    try {
                        await this.capability.stopAudio();
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
     * @private
     * @param {import("express").Request} req
     * @param {import("express").Response} res
     * @param {Error} err
     */
    sendAudioErrorResponse(req, res, err) {
        if (err instanceof TextToSpeechCapabilityBusyError) {
            res.status(409).json(err.message);
        } else {
            this.sendErrorResponse(req, res, err);
        }
    }
}

module.exports = TextToSpeechCapabilityRouter;
