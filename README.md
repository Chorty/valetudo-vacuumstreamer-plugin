# valetudo-vacuumstreamer-plugin
VacuumStreamer plugin capabilities for Valetudo (Dreame L10S Pro Ultra Heat) — video streaming, TTS, floor management

## Runtime Switches

At Valetudo startup the plugin reads `/data/vacuumstreamer/vacuumstreamer.conf`, the same file the native VacuumStreamer boot scripts use. A capability that is switched off is not registered, so its REST routes, MQTT topics and Home Assistant entities are absent. Restart Valetudo after changing a switch.

| Switch | Capability |
|---|---|
| `CAMERA` | `VideoStreamCapability`, `MicrophoneGainCapability`, and `RecorderQualityCapability` |
| `TTS` | `TextToSpeechCapability` |
| `MAP_MANAGEMENT` | `MapManagementCapability` |

A missing file, empty value or invalid value keeps the capability on. Invalid values are logged as warnings. See the native VacuumStreamer README for the file format, `CAMERA_LOGIN` and `HTTP_BRIDGE`.

Video start and stop go through the native `camera_ctl.sh`, which applies the switches and camera login and captures on demand. A refused start reports the script's reason. Stop pauses the camera until the next start or robot reboot, even if a viewer keeps retrying.

With `camera_ctl.sh`, the stream status reports:

- `active` when the stream can be watched: go2rtc is running and the camera is not paused
- `capturing` while `video_monitor` runs; in `on_demand` mode this stays false until someone watches
- `paused` and `mode`

Installs without `camera_ctl.sh` start and stop the binaries directly, without switch or login checks, and report `active` only while both processes run.

## Fork Changes Outside the Switches

The plugin also carries fork changes that are not VacuumStreamer features. No switch turns them off.

- `backend/RobotOverrides.js`, for this robot's firmware 1574: re-adds the `VACUUM_THEN_MOP` operation mode (preset 3), uses the V1 mop extension control instead of upstream's V2, and reports the edge-extension-frequency quirk as `null` when the firmware omits `ExtrFreq`, where upstream's getter would throw and the quirk would drop out of the list.
- `GuardedVoicePackManagementCapabilityRouter` replaces upstream's voice-pack router. A download URL must be http(s) without credentials and must not target the robot's own loopback or a link-local address; otherwise the request gets 400 and never reaches the firmware. Hostnames are not resolved, and the firmware may follow redirects.
- `backend/VacuumstreamerWebServer.js`, called at two points in `WebServer.js`:
  - `beforeRoutes` installs privacy-safe slow-request logging. It is off unless `VALETUDO_SLOW_REQUEST_MS` is set to an integer from 100 through 60000. It never logs SSE, log-content routes, or responses that set `res.locals.longLivedStream`, such as the camera's `live.mp4`.
  - `frontendAssets` serves the content-hashed files under `/static/` with one-year immutable caching, sends the `.br`/`.gz` copies the frontend build makes when the client accepts them, and limits `/static/` to 120 requests per 10 s. Everything else, `index.html` included, is left to upstream's handler.

## Home Assistant and MQTT

When both MQTT and Home Assistant autodiscovery are enabled in Valetudo, this plugin adds the following entities to the robot device:

- A `notify` entity that speaks its message through the robot speaker
- A diagnostic binary sensor reporting whether speech or audio is playing
- A button that stops current speech or audio playback
- A switch that resumes or pauses the camera; with on-demand capture it stays on while the camera waits for a viewer
- A microphone-gain number entity backed by the native `mic_gain_ctl.sh`
- A recorder-quality select entity backed by `recorder_quality_ctl.sh`, with low and high 864×480/15 fps profiles
- Disabled-by-default diagnostic sensors containing the RTSP and WebRTC stream URLs

The live camera stream itself remains on go2rtc/RTSP rather than being transported over MQTT.

### Optional robot quirks

`QuirksCapability` may be enabled as an optional MQTT capability. Individual quirks that are unsafe for unattended
automation are intentionally omitted from MQTT and Home Assistant discovery even when the capability is enabled.
Broker authentication and least-privilege topic ACLs should still be used for every robot command topic.

The Quirks MQTT handle is registered only when `QuirksCapability` is included in Valetudo's MQTT
`optionalExposedCapabilities` setting. Its presence in the robot's REST capability list does not enable MQTT exposure.

Speech and local audio playback are single-flight operations. If audio is already active, the HTTP API responds with
`409` and overlapping MQTT commands are rejected. TTS downloads use a 10-second timeout and can be cancelled with the
existing stop action. Video start and stop commands are serialized so that rapid commands are applied in order.

The retired `VideoQualityCapability` only changed an in-memory label. The current `RecorderQualityCapability` is a separate control: its Home Assistant select entity changes the native recorder profile and encoder bitrate. The low profile uses 600 kbps and high uses 2 Mbps at the camera's native 864×480 and 15 fps.
