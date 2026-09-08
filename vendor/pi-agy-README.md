# pi-agy local compatibility artifact

Upstream npm `pi-agy@0.6.1` does **not** include Gemini 3.8. The desktop installation has two local source changes adding it. This artifact applies those model/stream changes, with one Hitch difference: an explicit 3.8 selection never falls back to 3.7. No OAuth/account-store implementation is changed. Availability on the real service is unverified until operator login and a real request.

- Base: npm pi-agy 0.6.1, MIT (LICENSE included).
- Local version: 0.6.1-hitch.1; Pi peers fixed at 0.84.1.
- Source delta from npm: `pi-agy-gemini-3.8.patch`; additionally change package version and the two peer ranges as above.
- Reproduce: unpack the upstream npm tarball, apply this patch with `patch -p1`, set package metadata, then `npm pack --ignore-scripts`.
- SHA-256: `18e808d0c332f60f919846a9cd878b5ff9baf358595780b784f51186f14a6334`
- npm SHA-512 and dependency closure are pinned in the lockfile. Do not publish this as unmodified upstream 0.6.1 or change the desktop installation.
