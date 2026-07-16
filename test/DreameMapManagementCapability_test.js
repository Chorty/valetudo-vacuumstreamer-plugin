const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const tar = require("tar-stream");
const test = require("node:test");
const {createGzip} = require("node:zlib");
const {pipeline} = require("node:stream/promises");
const {Writable} = require("node:stream");

const DreameMapManagementCapability = require("../backend/dreame-capabilities/DreameMapManagementCapability");

function createFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "valetudo-map-management-test-"));
    const storagePath = path.join(root, "maploader");
    const activeDataPath = path.join(root, "active");
    const robot = {
        clearValetudoMap: () => undefined,
        pollMap: () => undefined,
    };
    const capability = new DreameMapManagementCapability({
        robot: robot,
        mapConfig: {
            storagePath: storagePath,
            mapDirs: [path.join(activeDataPath, "ri")],
            multMapConfig: path.join(activeDataPath, "config", "mult_map.json"),
        },
    });

    return {
        capability: capability,
        root: root,
        storagePath: storagePath,
        cleanup: () => fs.rmSync(root, {recursive: true, force: true}),
    };
}

async function createArchive(entries) {
    const pack = tar.pack();
    const chunks = [];
    const sink = new Writable({
        write: function(chunk, encoding, callback) {
            chunks.push(chunk);
            callback();
        },
    });
    const completion = pipeline(pack, createGzip(), sink);

    for (const entry of entries) {
        await new Promise((resolve, reject) => {
            pack.entry(entry.header, entry.body, error => error ? reject(error) : resolve());
        });
    }
    pack.finalize();
    await completion;

    return Buffer.concat(chunks);
}

test("rejects traversal IDs before recursive filesystem operations", async () => {
    const fixture = createFixture();
    const outside = path.join(fixture.root, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "marker"), "preserve me");

    try {
        await assert.rejects(
            fixture.capability.deleteMap("../outside"),
            /Invalid map id/
        );
        assert.equal(fs.readFileSync(path.join(outside, "marker"), "utf8"), "preserve me");
    } finally {
        fixture.cleanup();
    }
});

test("rejects invalid IDs across every map lookup operation", async () => {
    const fixture = createFixture();
    const calls = [
        () => fixture.capability.loadMap("../outside"),
        () => fixture.capability.deleteMap("/tmp/outside"),
        () => fixture.capability.renameMap("linked/map", "renamed"),
        () => fixture.capability.exportMap("map;touch_pwned"),
    ];

    try {
        for (const call of calls) {
            await assert.rejects(call(), /Invalid map id/);
        }
    } finally {
        fixture.cleanup();
    }
});

test("rejects saved-map symlinks that escape the storage root", async () => {
    const fixture = createFixture();
    const outside = path.join(fixture.root, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "metadata.json"), JSON.stringify({name: "unchanged"}));
    fs.symlinkSync(outside, path.join(fixture.storagePath, "linked_map"));

    try {
        await assert.rejects(
            fixture.capability.renameMap("linked_map", "attacker controlled"),
            /symbolic link|outside map storage/
        );
        const metadata = JSON.parse(fs.readFileSync(path.join(outside, "metadata.json"), "utf8"));
        assert.equal(metadata.name, "unchanged");
    } finally {
        fixture.cleanup();
    }
});

test("rejects a legacy metadata symlink inside an otherwise valid map directory", async () => {
    const fixture = createFixture();
    const outsideMetadata = path.join(fixture.root, "outside-metadata.json");
    const savedMap = path.join(fixture.storagePath, "legacy_map");
    fs.mkdirSync(savedMap);
    fs.writeFileSync(outsideMetadata, JSON.stringify({name: "unchanged"}));
    fs.symlinkSync(outsideMetadata, path.join(savedMap, "metadata.json"));

    try {
        await assert.rejects(
            fixture.capability.renameMap("legacy_map", "attacker controlled"),
            /metadata.*symbolic link|Unsafe saved map/
        );
        const metadata = JSON.parse(fs.readFileSync(outsideMetadata, "utf8"));
        assert.equal(metadata.name, "unchanged");
    } finally {
        fixture.cleanup();
    }
});

test("rejects legacy saved maps containing nested symlinks before loading", async () => {
    const fixture = createFixture();
    const savedMap = path.join(fixture.storagePath, "legacy_map");
    const outside = path.join(fixture.root, "outside");
    const activeRi = fixture.capability.mapConfig.mapDirs[0];
    fs.mkdirSync(path.join(savedMap, "ri"), {recursive: true});
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "marker"), "outside");
    fs.symlinkSync(outside, path.join(savedMap, "ri", "escape"));
    fs.mkdirSync(activeRi, {recursive: true});
    fs.writeFileSync(path.join(activeRi, "marker"), "active");
    fixture.capability._restartServices = async () => undefined;

    try {
        await assert.rejects(
            fixture.capability.loadMap("legacy_map"),
            /Unsafe saved map.*symbolic link/
        );
        assert.equal(fs.readFileSync(path.join(activeRi, "marker"), "utf8"), "active");
    } finally {
        fixture.cleanup();
    }
});

test("rejects imported archives containing symbolic links", async () => {
    const fixture = createFixture();
    const archive = await createArchive([
        {header: {name: "saved-map/", type: "directory"}},
        {header: {name: "saved-map/ri/", type: "directory"}},
        {header: {name: "saved-map/ri/escape", type: "symlink", linkname: "../../../outside"}},
    ]);

    try {
        await assert.rejects(
            fixture.capability.importMap(archive, "Unsafe link"),
            /Unsupported archive entry type.*symlink/
        );
        assert.deepEqual(fs.readdirSync(fixture.storagePath), []);
    } finally {
        fixture.cleanup();
    }
});

test("rejects imported archives containing hardlinks", async () => {
    const fixture = createFixture();
    const archive = await createArchive([
        {header: {name: "saved-map/", type: "directory"}},
        {header: {name: "saved-map/ri/", type: "directory"}},
        {header: {name: "saved-map/ri/map.bin", type: "file"}, body: Buffer.from("map")},
        {header: {name: "saved-map/ri/linked", type: "link", linkname: "saved-map/ri/map.bin"}},
    ]);

    try {
        await assert.rejects(
            fixture.capability.importMap(archive, "Unsafe hardlink"),
            /Unsupported archive entry type.*link/
        );
        assert.deepEqual(fs.readdirSync(fixture.storagePath), []);
    } finally {
        fixture.cleanup();
    }
});

test("rejects parent-relative and absolute archive paths", async () => {
    for (const unsafeName of ["../outside/owned", "/tmp/outside/owned", "saved-map/ri/../../outside"]) {
        const fixture = createFixture();
        const archive = await createArchive([
            {header: {name: "saved-map/", type: "directory"}},
            {header: {name: "saved-map/ri/", type: "directory"}},
            {header: {name: unsafeName, type: "file"}, body: Buffer.from("owned")},
        ]);

        try {
            await assert.rejects(
                fixture.capability.importMap(archive, "Unsafe path"),
                /unsafe entry path|outside extraction directory/
            );
            assert.deepEqual(fs.readdirSync(fixture.storagePath), []);
        } finally {
            fixture.cleanup();
        }
    }
});

test("rejects imported archives with multiple top-level directories", async () => {
    const fixture = createFixture();
    const archive = await createArchive([
        {header: {name: "saved-map/", type: "directory"}},
        {header: {name: "saved-map/ri/", type: "directory"}},
        {header: {name: "saved-map/ri/map.bin", type: "file"}, body: Buffer.from("map")},
        {header: {name: "unexpected/", type: "directory"}},
        {header: {name: "unexpected/file", type: "file"}, body: Buffer.from("unexpected")},
    ]);

    try {
        await assert.rejects(
            fixture.capability.importMap(archive, "Multiple roots"),
            /exactly one top-level directory/
        );
        assert.deepEqual(fs.readdirSync(fixture.storagePath), []);
    } finally {
        fixture.cleanup();
    }
});

test("imports a valid single-root map archive", async () => {
    const fixture = createFixture();
    const archive = await createArchive([
        {header: {name: "saved-map/", type: "directory"}},
        {header: {name: "saved-map/ri/", type: "directory"}},
        {header: {name: "saved-map/ri/map.bin", type: "file", mode: 0o640}, body: Buffer.from("valid map")},
    ]);

    try {
        const result = await fixture.capability.importMap(archive, "Valid Map");
        assert.match(result.id, /^valid_map_[a-z0-9]+$/);
        assert.equal(
            fs.readFileSync(path.join(fixture.storagePath, result.id, "ri", "map.bin"), "utf8"),
            "valid map"
        );
        const metadata = JSON.parse(
            fs.readFileSync(path.join(fixture.storagePath, result.id, "metadata.json"), "utf8")
        );
        assert.equal(metadata.name, "Valid Map");
        assert.equal(metadata.imported, true);
    } finally {
        fixture.cleanup();
    }
});

test("exports and re-imports an existing valid map", async () => {
    const fixture = createFixture();
    const existingId = "existing_map_abc123";
    const existingMap = path.join(fixture.storagePath, existingId);
    fs.mkdirSync(path.join(existingMap, "ri"), {recursive: true});
    fs.writeFileSync(path.join(existingMap, "ri", "map.bin"), "round trip");
    fs.writeFileSync(
        path.join(existingMap, "metadata.json"),
        JSON.stringify({id: existingId, name: "Existing Map", timestamp: Date.now()})
    );
    let exported;

    try {
        exported = await fixture.capability.exportMap(existingId);
        const result = await fixture.capability.importMap(fs.readFileSync(exported.filePath), "Imported Copy");
        assert.equal(
            fs.readFileSync(path.join(fixture.storagePath, result.id, "ri", "map.bin"), "utf8"),
            "round trip"
        );
    } finally {
        if (exported) {
            fs.rmSync(exported.filePath, {force: true});
        }
        fixture.cleanup();
    }
});
