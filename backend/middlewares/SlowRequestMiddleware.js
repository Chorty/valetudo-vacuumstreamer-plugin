const Logger = require("../../../backend/lib/Logger");

// Named here rather than in backend/lib/res/env.js, which stays upstream's.
const SLOW_REQUEST_MS_ENV = "VALETUDO_SLOW_REQUEST_MS";
const MAX_TRACKED_PATHS = 100;
const RATE_LIMIT_MS = 30 * 1000;

/**
 * Creates privacy-safe slow HTTP request telemetry.
 *
 * @param {object} [options]
 * @param {object} [options.logger]
 * @param {function(): bigint} [options.now]
 * @param {string|number} [options.rawThreshold]
 * @param {number} [options.rateLimitMs]
 * @returns {(function(*, *, *): void)}
 */
module.exports = function(options = {}) {
    const logger = options.logger || Logger;
    const now = options.now || (() => process.hrtime.bigint());
    const rateLimitMs = options.rateLimitMs || RATE_LIMIT_MS;
    const threshold = parseThreshold(options.rawThreshold ?? process.env[SLOW_REQUEST_MS_ENV]);
    const rateLimits = new Map();

    if (threshold.error) {
        logger.warn(`${SLOW_REQUEST_MS_ENV} must be 0 or an integer from 100 through 60000; slow-request telemetry is disabled.`);
    }

    if (!threshold.value) {
        return function disabledSlowRequestMiddleware(req, res, next) {
            next();
        };
    }

    return function slowRequestMiddleware(req, res, next) {
        const started = now();
        let completed = false;

        res.once("finish", () => complete(false));
        res.once("close", () => complete(!res.writableFinished));
        next();

        function complete(aborted) {
            if (completed) {
                return;
            }
            completed = true;

            const durationMs = Number(now() - started) / 1e6;
            const contentType = String(res.getHeader?.("Content-Type") || "").toLowerCase();
            const requestPath = safePath(req.path);
            // A route sets res.locals.longLivedStream for responses meant to stay open (live video).
            if (durationMs < threshold.value || contentType.startsWith("text/event-stream") || res.locals?.longLivedStream === true || isLogContentPath(requestPath)) {
                return;
            }

            const key = `${req.method} ${requestPath}`;
            const currentMs = Number(now()) / 1e6;
            const existing = rateLimits.get(key);
            if (existing && currentMs - existing.lastLoggedMs < rateLimitMs) {
                existing.suppressed += 1;
                return;
            }

            const suppressed = existing?.suppressed || 0;
            rateLimits.delete(key);
            rateLimits.set(key, {lastLoggedMs: currentMs, suppressed: 0});
            while (rateLimits.size > MAX_TRACKED_PATHS) {
                rateLimits.delete(rateLimits.keys().next().value);
            }

            logger.warn("Slow HTTP request", {
                aborted: Boolean(aborted),
                durationMs: Math.round(durationMs),
                method: safeMethod(req.method),
                path: requestPath,
                responseBytes: parseResponseBytes(res.getHeader?.("Content-Length")),
                status: Number(res.statusCode) || null,
                suppressed: suppressed
            });
        }
    };
};

function parseThreshold(rawValue) {
    if (rawValue === undefined || rawValue === null || rawValue === "" || rawValue === 0 || rawValue === "0") {
        return {error: false, value: 0};
    }
    if (!/^\d+$/.test(String(rawValue))) {
        return {error: true, value: 0};
    }
    const value = Number(rawValue);
    if (!Number.isSafeInteger(value) || value < 100 || value > 60000) {
        return {error: true, value: 0};
    }
    return {error: false, value: value};
}

function safePath(value) {
    const path = typeof value === "string" ? value.split("?", 1)[0] : "/unknown";
    return [...path].map(character => {
        const code = character.charCodeAt(0);
        return code <= 31 || code === 127 ? "?" : character;
    }).join("").slice(0, 256) || "/";
}

function safeMethod(value) {
    return typeof value === "string" && /^[A-Z]{1,16}$/.test(value) ? value : "UNKNOWN";
}

function isLogContentPath(requestPath) {
    return requestPath === "/api/v2/valetudo/log/content" || requestPath.startsWith("/api/v2/valetudo/log/content/");
}

function parseResponseBytes(value) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

module.exports.isLogContentPath = isLogContentPath;
module.exports.parseThreshold = parseThreshold;
module.exports.safeMethod = safeMethod;
module.exports.safePath = safePath;
