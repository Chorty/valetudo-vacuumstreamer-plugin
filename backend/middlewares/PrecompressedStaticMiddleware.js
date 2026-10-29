const fs = require("fs");
const path = require("path");

/**
 * Serves precompressed variants of immutable, content-hashed frontend assets.
 *
 * @param {object} options
 * @param {string} options.root
 * @param {Map<string, object>} options.assets
 * @returns {(function(*, *, *): void)}
 */
module.exports = function(options) {
    const root = path.resolve(options.root);
    if (!(options.assets instanceof Map)) {
        throw new TypeError("A prebuilt static asset index is required");
    }
    const assets = options.assets;

    return function precompressedStaticMiddleware(req, res, next) {
        if (req.method !== "GET" && req.method !== "HEAD") {
            next();
            return;
        }

        const originalPath = resolveAssetPath(root, req.path);
        if (!originalPath) {
            res.sendStatus(400);
            return;
        }

        const encoding = selectEncoding(req.headers["accept-encoding"]);
        const asset = assets.get(originalPath);
        const encodedPath = asset && encoding ? asset[encoding] : null;
        if (!encodedPath) {
            if (asset?.br || asset?.gzip) {
                res.vary("Accept-Encoding");
            }
            next();
            return;
        }

        res.type(path.extname(originalPath));
        res.set("Content-Encoding", encoding);
        res.vary("Accept-Encoding");
        res.set("Cache-Control", "public, max-age=31536000, immutable");
        res.sendFile(encodedPath);
    };
};

function resolveAssetPath(root, requestPath) {
    let decoded;
    try {
        decoded = decodeURIComponent(requestPath);
    } catch {
        return null;
    }
    if (decoded.includes("\\") || decoded.includes("\0")) {
        return null;
    }
    const segments = decoded.split("/").filter(Boolean);
    if (segments.some(segment => segment === "." || segment === "..")) {
        return null;
    }
    const resolved = path.resolve(root, ...segments);
    return resolved === root || resolved.startsWith(root + path.sep) ? resolved : null;
}

function selectEncoding(header) {
    if (!header) {
        return null;
    }
    const encodings = String(header).split(",").map(item => {
        const [name, ...parameters] = item.trim().toLowerCase().split(";");
        let quality = 1;
        for (const parameter of parameters) {
            const match = /^q=(0(?:\.\d+)?|1(?:\.0+)?)$/.exec(parameter.trim());
            if (match) {
                quality = Number(match[1]);
            }
        }
        return {name: name, quality: quality};
    });
    const acceptable = name => encodings.some(value => value.name === name && value.quality > 0);
    if (acceptable("br")) {
        return "br";
    }
    if (acceptable("gzip")) {
        return "gzip";
    }
    return null;
}

function buildAssetIndex(root) {
    const assets = new Map();
    const directories = [root];

    while (directories.length > 0) {
        const directory = directories.pop();
        let entries;
        try {
            entries = fs.readdirSync(directory, {withFileTypes: true});
        } catch {
            continue;
        }

        for (const entry of entries) {
            const entryPath = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                directories.push(entryPath);
                continue;
            }
            if (!entry.isFile()) {
                continue;
            }

            let originalPath = entryPath;
            let representation = "original";
            if (entryPath.endsWith(".br")) {
                originalPath = entryPath.slice(0, -3);
                representation = "br";
            } else if (entryPath.endsWith(".gz")) {
                originalPath = entryPath.slice(0, -3);
                representation = "gzip";
            }
            const asset = assets.get(originalPath) || {};
            asset[representation] = entryPath;
            assets.set(originalPath, asset);
        }
    }

    for (const [originalPath, asset] of assets) {
        if (!asset.original) {
            assets.delete(originalPath);
        } else {
            assets.set(originalPath, Object.freeze(asset));
        }
    }
    return assets;
}

module.exports.buildAssetIndex = buildAssetIndex;
module.exports.resolveAssetPath = resolveAssetPath;
module.exports.selectEncoding = selectEncoding;
