const VoicePackManagementCapabilityRouter = require("../../../backend/lib/webserver/capabilityRouters/VoicePackManagementCapabilityRouter");

/**
 * Upstream's voice-pack router with a URL check in front of its download
 * route. The mapping in VacuumstreamerCapabilityRouterMappings.js replaces
 * upstream's router for every robot. It is fork behavior, not a VacuumStreamer
 * feature, so no vacuumstreamer.conf switch turns it off.
 */
class GuardedVoicePackManagementCapabilityRouter extends VoicePackManagementCapabilityRouter {
    initRoutes() {
        // Registered first, so it runs before upstream's PUT "/" and passes everything else on to it.
        this.router.put("/", this.validator, (req, res, next) => {
            if (req.body.action === "download" && req.body.url && !GuardedVoicePackManagementCapabilityRouter.IS_ALLOWED_VOICE_PACK_URL(req.body.url)) {
                res.status(400).json({message: "Voice pack URL must be http(s) without credentials and must not target the robot itself or a link-local address"});
                return;
            }
            next();
        });

        super.initRoutes();
    }

    /**
     * The robot firmware downloads the voice pack itself, so the URL is a
     * request the robot makes on the caller's behalf. LAN hosts stay allowed
     * because serving a pack from a local machine is the documented use. What
     * is refused is the reach only the robot has: its own loopback services
     * (which trust local clients) and link-local addresses. Hostnames are not
     * resolved here, and the firmware may follow redirects, so this blocks
     * direct targeting rather than every indirect path.
     *
     * @param {string} url
     * @returns {boolean}
     */
    static IS_ALLOWED_VOICE_PACK_URL(url) {
        let parsed;
        try {
            parsed = new URL(url);
        } catch {
            return false;
        }
        if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
            return false;
        }
        // The WHATWG parser already canonicalises numeric IPv4 forms
        // (2130706433, 0x7f.1, 127.1) to dotted quads.
        const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
        if (host === "localhost" || host.endsWith(".localhost")) {
            return false;
        }
        const ipv4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/) ?? host.match(/^::ffff:(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
        if (ipv4) {
            const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
            return !(a === 127 || a === 0 || (a === 169 && b === 254));
        }
        if (host.includes(":")) {
            return !(host === "::1" || host === "::" || /^fe[89ab][0-9a-f]:/.test(host) || host.startsWith("::ffff:"));
        }
        return true;
    }
}

module.exports = GuardedVoicePackManagementCapabilityRouter;
