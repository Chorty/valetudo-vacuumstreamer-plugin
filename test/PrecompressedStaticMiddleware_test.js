const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const zlib = require("node:zlib");

const PrecompressedStaticMiddleware = require("../backend/middlewares/PrecompressedStaticMiddleware");

test("encoding negotiation prefers Brotli and respects disabled encodings", () => {
    assert.equal(PrecompressedStaticMiddleware.selectEncoding("gzip, br"), "br");
    assert.equal(PrecompressedStaticMiddleware.selectEncoding("br;q=0, gzip;q=0.8"), "gzip");
    assert.equal(PrecompressedStaticMiddleware.selectEncoding("br;q=0, gzip;q=0"), null);
});

test("asset resolution rejects traversal, backslashes, nulls, and invalid encoding", () => {
    const root = path.resolve("/tmp/static-root");
    assert.equal(PrecompressedStaticMiddleware.resolveAssetPath(root, "/js/main.abc12345.js"), path.join(root, "js", "main.abc12345.js"));
    assert.equal(PrecompressedStaticMiddleware.resolveAssetPath(root, "/../secret"), null);
    assert.equal(PrecompressedStaticMiddleware.resolveAssetPath(root, "/%2e%2e/secret"), null);
    assert.equal(PrecompressedStaticMiddleware.resolveAssetPath(root, "/js%5csecret"), null);
    assert.equal(PrecompressedStaticMiddleware.resolveAssetPath(root, "/%E0%A4%A"), null);
});

test("middleware serves matching compressed bytes with immutable cache headers", async t => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "valetudo-static-"));
    const root = path.join(temporary, "static");
    const file = path.join(root, "js", "main.abc12345.js");
    const contents = Buffer.from("console.log('compressed');".repeat(100));
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, contents);
    fs.writeFileSync(`${file}.br`, zlib.brotliCompressSync(contents));
    fs.writeFileSync(`${file}.gz`, zlib.gzipSync(contents));

    const assets = PrecompressedStaticMiddleware.buildAssetIndex(root);
    const middleware = PrecompressedStaticMiddleware({assets: assets, root: root});
    t.after(() => {
        fs.rmSync(temporary, {force: true, recursive: true});
    });

    const brotli = createResponse();
    middleware({headers: {"accept-encoding": "gzip, br"}, method: "GET", path: "/js/main.abc12345.js"}, brotli, () => assert.fail("should serve Brotli"));
    assert.equal(brotli.headers["Content-Encoding"], "br");
    assert.equal(brotli.headers.Vary, "Accept-Encoding");
    assert.equal(brotli.headers["Cache-Control"], "public, max-age=31536000, immutable");
    assert.equal(brotli.contentType, ".js");
    assert.deepEqual(zlib.brotliDecompressSync(brotli.body), contents);

    const identity = createResponse();
    let nextCalled = false;
    middleware({headers: {"accept-encoding": "identity"}, method: "GET", path: "/js/main.abc12345.js"}, identity, () => {
        nextCalled = true;
    });
    assert.equal(nextCalled, true);
    assert.equal(identity.headers.Vary, "Accept-Encoding");
});

test("middleware uses a prebuilt index without request-time filesystem discovery", t => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "valetudo-static-index-"));
    const root = path.join(temporary, "static");
    const file = path.join(root, "js", "main.abc12345.js");
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, "original");
    fs.writeFileSync(`${file}.br`, "brotli");
    const assets = PrecompressedStaticMiddleware.buildAssetIndex(root);
    const originalStatSync = fs.statSync;
    const originalReaddirSync = fs.readdirSync;
    t.after(() => {
        fs.statSync = originalStatSync;
        fs.readdirSync = originalReaddirSync;
        fs.rmSync(temporary, {force: true, recursive: true});
    });

    fs.statSync = () => assert.fail("request handling must not call fs.statSync");
    fs.readdirSync = () => assert.fail("middleware construction and request handling must not scan the filesystem");
    const middleware = PrecompressedStaticMiddleware({assets: assets, root: root});
    const response = createResponse();
    middleware({headers: {"accept-encoding": "br"}, method: "GET", path: "/js/main.abc12345.js"}, response, () => {
        assert.fail("indexed Brotli asset should be served");
    });
    assert.equal(response.headers["Content-Encoding"], "br");
    assert.equal(response.body.toString(), "brotli");

    let nextCalled = false;
    middleware({headers: {"accept-encoding": "br"}, method: "GET", path: "/js/missing.abc12345.js"}, createResponse(), () => {
        nextCalled = true;
    });
    assert.equal(nextCalled, true);
});

function createResponse() {
    return {
        headers: {},
        sendFile: function(filePath, options) {
            this.body = fs.readFileSync(path.resolve(options.root, filePath));
        },
        set: function(name, value) {
            this.headers[name] = value;
        },
        type: function(filePath) {
            this.contentType = filePath;
        },
        vary: function(value) {
            this.headers.Vary = value;
        }
    };
}
