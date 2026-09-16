# pi-agy local compatibility artifact

Upstream npm `pi-agy@0.6.1` does **not** include Gemini 3.8. The desktop installation has two local source changes adding it. This artifact applies those model/stream changes, with one Hitch difference: an explicit 3.8 selection never falls back to 3.7. No OAuth/account-store implementation is changed. Availability on the real service is unverified until operator login and a real request.

- Base: npm pi-agy 0.6.1, MIT (LICENSE included).
- Local version: 0.6.1-hitch.2; Pi peers fixed at exact 0.85.1.
- Source delta from npm: `pi-agy-gemini-3.8.patch`; `.hitch.2` changes only the package version and those two peer ranges from `.hitch.1`.
- Reproduce: unpack the upstream npm tarball, apply this patch with `patch -p1`, set package metadata, then `npm pack --ignore-scripts`.
- SHA-256: `8c559863247a8943a16c7017cdb9425bdcc120a5989203b495bd853dab801094`
- npm SHA-512 and dependency closure are pinned in the lockfile. Do not publish this as unmodified upstream 0.6.1 or change the desktop installation.
