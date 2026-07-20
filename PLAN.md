# Resolve Security Review Findings

## Priority and Fix Types

| Issue | Classification | Severity | Importance | Disposition |
| --- | --- | --- | --- | --- |
| Unbounded TTS concurrency | Security/resource exhaustion | Low / P3 | High—release blocker | Fix immediately across MQTT and HTTP audio entry points |
| Video lifecycle race | Reliability/state consistency | Not a security vulnerability | Medium | Fix in the same plugin release |
| Cliff-sensor quirk exposure | Safety and authorization hardening | Not currently reachable through normal configuration; potential physical impact is High | High before enabling MQTT quirks | Block dangerous quirks, then safely enable the capability |
| Missing regression/operational evidence | Verification and observability | Supporting control | High | Add automated tests and perform guarded live acceptance |

## Implementation Changes

### 1. Plugin: bound TTS and audio work

- Add one capability-level exclusive audio-job gate covering both `speak()` and `playAudioFile()`. A second request is rejected immediately rather than queued.
- Add a private busy error and map it to HTTP `409` with a stable `"TTS is busy"` response. MQTT commands propagate the rejection to the existing error logger.
- Keep `stopAudio()` available while busy. It aborts any active download, prevents later conversion/playback stages, terminates tracked audio/conversion processes, resets status, and releases the gate.
- Add an internal `downloadTimeoutMs` setting defaulting to `10000`, validated as an integer from 100–120000 ms.
- Apply one deadline across the initial HTTPS request and redirect. Abort the request on timeout and return a credential- and URL-free error.
- Give every speech operation its own temporary directory and remove it in `finally`, including failures, timeouts, and cancellation.
- Preserve input validation, successful HTTP/MQTT behavior, TTS status fields, supported languages, and the existing stop action.

### 2. Plugin: serialize video lifecycle

- Put `startStream()` and `stopStream()` behind one per-capability promise chain.
- Execute commands in arrival order so concurrent `ON/ON` produces one start and `ON/OFF` reliably ends stopped.
- Ensure a failed start or stop does not poison the queue; later commands must still execute.
- Keep status and URL reads available during transitions and invalidate the status cache after every completed or failed mutation.
- Preserve current MQTT topics, HTTP actions, stream URLs, and process launch configuration.

### 3. Parent repository: make quirk exposure safe

- Add a non-serialized `mqttExposed` property to `Quirk`, defaulting to `true` for compatibility with existing quirks.
- Mark the Midea cliff-sensor quirk `mqttExposed: false`.
- Have `QuirksCapabilityMqttHandle` register only quirks whose policy allows MQTT exposure. Blocked quirks must produce no Homie property, command subscription, or Home Assistant entity.
- Leave the cliff-sensor control available through the existing local REST/UI path with its danger warning; do not change its vendor command.
- After the filter is enforced, add `QuirksCapability` to the validated `optionalExposedCapabilities` enum and regenerate the checked-in OpenAPI/configuration schema.
- Document that MQTT quirks are optional, dangerous quirks may be intentionally excluded, and broker ACLs should restrict robot command topics.

## Verification and Delivery

- Add focused tests proving:
  - 25 concurrent TTS requests result in one active job and 24 busy rejections.
  - HTTP overlap returns `409`; MQTT overlap rejects without crashing the controller.
  - Sequential speech still works after success, failure, timeout, and cancellation.
  - The same gate covers `playAudioFile()`, while `stopAudio()` remains usable.
  - Redirects share the 10-second deadline and partial files are removed.
  - Concurrent video starts create one pipeline; ordered start/stop ends stopped; queue processing recovers after failure.
  - Safe quirks are advertised, the cliff-sensor quirk is absent, invalid enum values remain rejected, and configuration accepts the optional quirks capability.
- Rerun the original offline security probe and require peak TTS concurrency of one. Do not stress the live vacuum.
- Run backend/plugin/MCP tests, lint, type checks, frontend production build, generated-schema consistency, ARM64 packaging, dependency checks, CodeQL, and Socket Security.
- Publish in dependency order:
  1. Create a plugin fix branch from `515d4bb`, commit TTS/video fixes and tests, push, review, and merge into plugin `main`.
  2. Create a parent fix branch from `ce472c11`, commit quirk policy/schema/docs plus the exact plugin merge pointer, push, review, and merge into fork `master`.
  3. Build the exact parent merge SHA and confirm the workflow artifact reports that SHA.
- Before deployment, verify the ARM64 ELF and SHA-256, create and integrity-check a fresh local backup of `/data`, `/mnt/private`, and `/mnt/misc`, retain the active device binary, upload under a candidate name, and use the established 60-second health gate with automatic rollback.
- Live acceptance, while docked and idle:
  - Confirm root/API health, MQTT/Home Assistant availability, MCP capability reads, and watchdog stability.
  - Perform one user-observed TTS request; do not run a live concurrency stress test.
  - Start and stop video, verify one stream URL, and confirm no duplicate processes remain.
  - Confirm safe quirks appear in Home Assistant and the cliff-sensor entity/topic does not; never disable the cliff sensors.
- Preserve the sealed original report. Produce a follow-up verification record for finding `csf_331005a31e8379305693ccc3`, including the fixed commit, test results, deployed checksum, backup path, and remaining deployment assumptions.

## Public Interfaces and Defaults

- HTTP TTS/audio requests made while another audio job is active now return `409`.
- MQTT speech commands retain their existing topic and payload; overlapping commands are rejected and logged.
- Internal TTS configuration gains `downloadTimeoutMs`, default `10000`.
- `Quirk` gains internal `mqttExposed`; it is not added to serialized REST responses.
- `QuirksCapability` becomes a valid optional MQTT capability, but blocked quirks are not advertised or writable.
- Defaults selected because no preference response was supplied: reject overlapping TTS work, address all three report items, and carry delivery through backup-protected deployment.
