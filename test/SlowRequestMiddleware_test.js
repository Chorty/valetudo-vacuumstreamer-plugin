const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const test = require("node:test");

const SlowRequestMiddleware = require("../backend/middlewares/SlowRequestMiddleware");

test("slow request configuration validates its bounded integer", () => {
    assert.deepEqual(SlowRequestMiddleware.parseThreshold(undefined), {error: false, value: 0});
    assert.deepEqual(SlowRequestMiddleware.parseThreshold("0"), {error: false, value: 0});
    assert.deepEqual(SlowRequestMiddleware.parseThreshold("500"), {error: false, value: 500});
    assert.deepEqual(SlowRequestMiddleware.parseThreshold("99"), {error: true, value: 0});
    assert.deepEqual(SlowRequestMiddleware.parseThreshold("60001"), {error: true, value: 0});
    assert.deepEqual(SlowRequestMiddleware.parseThreshold("500.5"), {error: true, value: 0});
});

test("invalid configuration warns once and leaves telemetry disabled", () => {
    const logger = createLogger();
    const middleware = SlowRequestMiddleware({logger: logger, rawThreshold: "secret"});
    let nextCalls = 0;
    middleware({}, {}, () => {
        nextCalls += 1;
    });
    middleware({}, {}, () => {
        nextCalls += 1;
    });
    assert.equal(nextCalls, 2);
    assert.equal(logger.warnCalls.length, 1);
    assert.equal(JSON.stringify(logger.warnCalls).includes("secret"), false);
});

test("slow requests log only safe bounded metadata", () => {
    let now = 0n;
    const logger = createLogger();
    const middleware = SlowRequestMiddleware({logger: logger, now: () => now, rawThreshold: "500"});
    const response = createResponse({"Content-Length": "123"});
    middleware({method: "GET\nInjected", path: "/api/robot?token=secret\nInjected"}, response, () => undefined);
    now = 600000000n;
    response.writableFinished = true;
    response.emit("finish");

    assert.equal(logger.warnCalls.length, 1);
    assert.deepEqual(logger.warnCalls[0][1], {
        aborted: false,
        durationMs: 600,
        method: "UNKNOWN",
        path: "/api/robot",
        responseBytes: 123,
        status: 200,
        suppressed: 0
    });
    assert.equal(JSON.stringify(logger.warnCalls).includes("headers"), false);
    assert.equal(JSON.stringify(logger.warnCalls).includes("secret"), false);
});

test("query values from originalUrl are never used", () => {
    let now = 0n;
    const logger = createLogger();
    const middleware = SlowRequestMiddleware({logger: logger, now: () => now, rawThreshold: 100});
    const response = createResponse();
    middleware({method: "GET", originalUrl: "/safe?token=secret", path: "/safe"}, response, () => undefined);
    now = 200000000n;
    response.writableFinished = true;
    response.emit("finish");
    assert.equal(logger.warnCalls[0][1].path, "/safe");
    assert.equal(JSON.stringify(logger.warnCalls).includes("secret"), false);
});

test("fast, SSE, log-content and long-lived stream responses are excluded", () => {
    let now = 0n;
    const logger = createLogger();
    const middleware = SlowRequestMiddleware({logger: logger, now: () => now, rawThreshold: 100});
    for (const scenario of [
        {duration: 50n, headers: {}, path: "/fast"},
        {duration: 200n, headers: {"Content-Type": "text/event-stream"}, path: "/events"},
        {duration: 200n, headers: {}, path: "/api/v2/valetudo/log/content/sse"},
        {duration: 200n, headers: {"Content-Type": "video/mp4"}, path: "/live.mp4", longLivedStream: true}
    ]) {
        const response = createResponse(scenario.headers);
        if (scenario.longLivedStream) {
            response.locals = {longLivedStream: true};
        }
        middleware({method: "GET", path: scenario.path}, response, () => undefined);
        now += scenario.duration * 1000000n;
        response.writableFinished = true;
        response.emit("finish");
    }
    assert.equal(logger.warnCalls.length, 0);
});

test("disconnects are recorded and repeated paths are rate limited", () => {
    let now = 0n;
    const logger = createLogger();
    const middleware = SlowRequestMiddleware({logger: logger, now: () => now, rateLimitMs: 30000, rawThreshold: 100});

    completeRequest(false);
    now += 1000000000n;
    completeRequest(false);
    assert.equal(logger.warnCalls.length, 1);
    now += 31000000000n;
    completeRequest(true);
    assert.equal(logger.warnCalls.length, 2);
    assert.equal(logger.warnCalls[1][1].aborted, true);
    assert.equal(logger.warnCalls[1][1].suppressed, 1);

    function completeRequest(aborted) {
        const response = createResponse();
        middleware({method: "GET", path: "/same"}, response, () => undefined);
        now += 200000000n;
        response.writableFinished = !aborted;
        response.emit(aborted ? "close" : "finish");
    }
});

function createResponse(headers = {}) {
    const response = new EventEmitter();
    response.statusCode = 200;
    response.writableFinished = false;
    response.getHeader = name => headers[name];
    return response;
}

function createLogger() {
    const calls = [];
    return {
        warn: (...args) => calls.push(args),
        warnCalls: calls
    };
}
