# Media expansion — isolated acceptance

## Status and boundary

Development: `feat/comfyui-media`, separate from the running `comfyui-m3` checkout. Result access, Qwen editing and bounded generated-video routing are implemented and tested in isolation. **Not deployed to LunaTest, not user-accepted in natural Discord conversation, not pushed.** Production bot remains untouched.

The current live LunaTest is still Anima-only at `c347c72`. Read-only final verification found its original PID <redacted>/cwd unchanged and production service active at PID <redacted>. No new live stop, configuration change, schema migration or credential copy was performed.

## Implemented

- Fifth attested optional tool `paint_result(job_id, preview?)`: owner-scoped completed artifact lookup, exact read-only original under `/inbox/results`, explicit sandbox copy into workspace. Native image preview is an actual image tool-result block. No automatic claim of seeing a completed image; videos return a file, not video vision.
- Two result originals per Turn, <=10MiB each; at most two previews, each <=512KiB/1024 pixels per side. Existing inbound limits remain separate.
- `paint.input_files`: configured slot plus either captured `input_id` or own completed image `job_id`. Current/recent same-session inbound originals have explicitly labelled, Turn-local handles. No host/workspace path, arbitrary artifact/backend name, graph, origin or identity from the model.
- PNG/JPEG/WebP inputs only, <=8/40MiB combined, <=20MiB each. Verify owner, immutable metadata/bytes and MIME before upload. Planned upload paths are owner-content-addressed. Fresh collision-checked multipart delimiters and immutable operator origin/headers. Failed upload never submits generation; ambiguous generation is not automatically replayed.
- Policy file slots, exact literal dotted input keys, optional disconnect/pruning, finite number bindings and bounded public usage guidance. Registry cap8, fixed operator graphs/models/backend. Unprovided file inputs never reuse desktop defaults.
- MP4 output: declared video nodes only, native `images`/`animated` history, <=10MiB, structural MP4 checks and isolated FFprobe + full codec decode. H.264 plus AAC, finite dimensions/fps/duration, private FD-only input, resource/output/deadline bounds and cleanup. This is **not** a normalizer for untrusted reference movies.
- Durable same-Turn video caption/artifact publication and grouped delivery. Video originals can be retrieved later. Existing schema10 suffices; do not roll an older image-only worker onto pending video jobs merely because the schema number matches.

## Automated verification

- `npm run check`: **449 total / 421 passed / 28 skipped / 0 failed**.
- `npm run acceptance:host`: **15/15 passed**.
- Opt-in generated-video inspector and delivery suites: **7/7 passed**, including real isolated codec decode and real Store/MediaStore.
- Real SQLite reopen and owner/result isolation; actual binary multipart/graph substitution; bad/missing/foreign inputs and abort/upload/CAS failures; readonly originals, preview/mount budgets, symlink rejection and bridge caps.
- Fake Discord transport proves one video caption plus one exact-byte MP4 in a rich group, no standalone completion caption, both durable rows sent/attempt1 and persistence after reopen.
- Independent read-only image and video reviews found no remaining evidence-backed blocker. The reviewer did not execute tests; parent executed the checks above.

## Actual native/GPU probes

All operate in `<test-data-root>/media-result-probe-1asrKF`, never the live DB. Prompts were written by Mika. No actual Discord message was sent.

1. **View + workspace copy:** actual pinned Pi, 6 Luna/medium, calls `paint_result` on an owned completed-output fixture reusing the previously generated image. Model described cat ears, black/white maid outfit, green screen and keyboard from the native preview, then copied the 1,096,224-byte original into workspace. Independently checked SHA equality. No new GPU generation. Receipt: `<test-data-root>/media-result-native-receipt.json`.
2. **Cross-turn own-result Qwen edit:** actual 6 Luna/medium submits exactly one Qwen Lightning4 edit using the previous job ID, no raw path. Monitor/lighting changed green→amber; identity, outfit and composition retained on parent visual inspection. Output PNG **1,243,000 bytes**, backend and immutable original SHA identical. Receipt: `<test-data-root>/media-edit-native-receipt.json`.
3. **H3 text2va:** actual 6 Luna/medium submits one background job. **512×512, 24fps, 22 frames/~0.917s, H.264 + AAC**, 105,335 bytes.
4. **H3 fl2va:** explicit operator service call (not a second natural model test), Qwen result as required first image; optional last omitted. Same dimensions/rate/duration/codecs, 109,442 bytes.
5. **H3 image-ref2va:** explicit operator service call, Qwen result as picture_1. Same dimensions/rate/duration/codecs, 106,134 bytes. This policy adapts the existing local **hybrid** Ref2VA graph; it is not a claim of pure-checkpoint equivalence.

Each H3 job was submitted once. Required models and empty queue were checked; no global interrupt or other-job cancellation. Every output was fully decoded and compared byte-for-byte to backend download, then all three actual clips passed the dry Discord grouped-delivery path. Receipt: `<test-data-root>/media-h3-native-receipt.json`; individual `media-h3-{text,fl,ref}-receipt.json` adjacent.

Parent reviewed three-frame contact sheets; FL/Ref show eye/pose changes while preserving the reference character. Audio-energy checks (not semantic listening) found text mean/max -51.4/-30.8dB, FL -34.6/-14.9dB, **Ref -91.0/-80.8dB: effectively silent**. Ref has a valid AAC stream but its requested audible ambience is **not quality-accepted**. Do not equate stream presence with correct sound generation.

## Operator policies and remaining gaps

Private test policies: `<test-data-root>/media-policies-P2TqRY/`; builder `<test-data-root>/build-media-operator-policies.mjs`; paths receipt `<test-data-root>/media-operator-policy-receipt.json`. No directory scan/automatic exposure. The FL graph explicitly adds audio VAE/decode/mux; the original desktop FL graph remains unchanged and silent.

Current bounded first slice:
- `h3-text`: no references.
- `h3-fl`: required first image, optional last; last-only is not exposed.
- `h3-ref`: required picture_1, optional picture_2/3, **image references only**. User video/audio reference inputs are not enabled; they need isolated canonical normalization, not just MIME checks. Thus this is **not full multimodal Ref2VA input coverage**.
- Configured requested duration0.5..5s, snapped to 17k+5 frames at24fps; only ~0.92s samples tested here. No long-clip/large-output/quality matrix, no actual new-bundle Discord CDN upload acceptance and no natural DM/server acceptance yet.
- Ref audible sound needs further investigation or an explicitly accepted beta limitation. Do not start a broad research sweep or silently swap checkpoint policy.
- A new attended LunaTest enablement/backup/rollout decision is still required. Drain/preserve outstanding jobs, retain the accepted configuration, never restore an older DB over new history, never roll back rotating authentication. Production/push remain unauthorized.
