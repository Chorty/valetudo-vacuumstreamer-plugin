const CapabilityRouter = require("../../../backend/lib/webserver/capabilityRouters/CapabilityRouter");
const Logger = require("../../../backend/lib/Logger");

const MAX_IMPORT_BYTES = 100 * 1024 * 1024; // 100 MB

function readRawBody(req, res, next) {
    if (req.headers["content-type"] !== "application/octet-stream") {
        return next();
    }
    const chunks = [];
    let size = 0;
    req.on("data", chunk => {
        size += chunk.length;
        if (size > MAX_IMPORT_BYTES) {
            req.destroy(new Error("Request body too large"));
            return;
        }
        chunks.push(chunk);
    });
    req.on("end", () => {
        req.body = Buffer.concat(chunks);
        next();
    });
    req.on("error", next);
}

class MapManagementCapabilityRouter extends CapabilityRouter {
    initRoutes() {
        // GET / — List all saved maps
        this.router.get("/", async (req, res) => {
            try {
                const maps = await this.capability.getMapList();
                res.json(maps);
            } catch (e) {
                this.sendErrorResponse(req, res, e);
            }
        });

        // PUT / — Actions: save, load, delete, rename
        this.router.put("/", this.validator, async (req, res) => {
            switch (req.body.action) {
                case "save":
                    if (typeof req.body.name !== "string" || req.body.name.trim().length === 0) {
                        res.status(400).json({error: "Missing or empty 'name' parameter"});
                        return;
                    }
                    try {
                        const result = await this.capability.saveMap(req.body.name.trim());
                        res.json(result);
                    } catch (e) {
                        this.sendErrorResponse(req, res, e);
                    }
                    break;

                case "load":
                    if (typeof req.body.id !== "string") {
                        res.status(400).json({error: "Missing 'id' parameter"});
                        return;
                    }
                    try {
                        await this.capability.loadMap(req.body.id);
                        res.sendStatus(200);
                    } catch (e) {
                        this.sendErrorResponse(req, res, e);
                    }
                    break;

                case "delete":
                    if (typeof req.body.id !== "string") {
                        res.status(400).json({error: "Missing 'id' parameter"});
                        return;
                    }
                    try {
                        await this.capability.deleteMap(req.body.id);
                        res.sendStatus(200);
                    } catch (e) {
                        this.sendErrorResponse(req, res, e);
                    }
                    break;

                case "rename":
                    if (typeof req.body.id !== "string" || typeof req.body.name !== "string") {
                        res.status(400).json({error: "Missing 'id' or 'name' parameter"});
                        return;
                    }
                    try {
                        await this.capability.renameMap(req.body.id, req.body.name.trim());
                        res.sendStatus(200);
                    } catch (e) {
                        this.sendErrorResponse(req, res, e);
                    }
                    break;

                default:
                    res.sendStatus(400);
            }
        });

        // GET /export/:id — Download a map archive
        this.router.get("/export/:id", async (req, res) => {
            try {
                const {filePath, fileName} = await this.capability.exportMap(req.params.id);
                res.download(filePath, fileName, (err) => {
                    if (err) {
                        Logger.error("Error sending map export:", err.message);
                    }
                    // Clean up temp file after sending
                    try {
                        require("fs").unlinkSync(filePath);
                    } catch (_) {
                        // ignore
                    }
                });
            } catch (e) {
                this.sendErrorResponse(req, res, e);
            }
        });

        // POST /import — Upload a map archive
        // readRawBody parses application/octet-stream since the global middleware is JSON-only
        this.router.post("/import",
            readRawBody,
            async (req, res) => {
                const name = req.query.name || `Imported Map ${new Date().toISOString().split("T")[0]}`;

                if (!req.body || req.body.length === 0) {
                    res.status(400).json({error: "No file data received. Send tar.gz with Content-Type: application/octet-stream"});
                    return;
                }

                try {
                    const result = await this.capability.importMap(req.body, name);
                    res.json(result);
                } catch (e) {
                    this.sendErrorResponse(req, res, e);
                }
            }
        );
    }
}

module.exports = MapManagementCapabilityRouter;
