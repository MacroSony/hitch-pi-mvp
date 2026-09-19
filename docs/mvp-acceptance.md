# MVP acceptance record

> Historical initial-MVP checkpoint. Later personal-WeChat formatting and
> host-local notification dogfood is recorded in the
> [2026-09-19 follow-up acceptance](ux-local-acceptance-20260919.md#subsequent-attended-personal-wechat-dogfood-2026-09-19);
> it does not retroactively change this checkpoint's test matrix.

Date: 2026-08-13 (Asia/Shanghai)

This record distinguishes deterministic/host evidence from credentialed live
acceptance. Unavailable live integrations are not reported as successful.

## Automated release evidence

| Check | Command | Result |
| --- | --- | --- |
| Clean pinned install | `npm ci --ignore-scripts` | pass; 150 packages installed, audit reported 0 vulnerabilities |
| Deterministic suite | `npm run acceptance:deterministic` | pass; 40 tests passed and 2 credential/host-opt-in tests skipped as designed |
| Host sandbox boundary | `npm run acceptance:host` | pass; 4 of 4 tests, including native startup attestation and publication |
| Service-constrained sandbox boundary | `npm run acceptance:service` | pass; 4 of 4 tests inside the compatible production unit restrictions |
| User unit syntax | `systemd-analyze --user verify systemd/hitch-pi-mvp.service` | pass |
| Patch hygiene | `git diff --check` | pass |

The deterministic suite covers:

- exact Telegram and WeChat private identity before content/media access;
- two-owner isolation and cross-owner foreign-key/artifact rejection;
- duplicate/conflicting intake and cursor ordering without Turn replay;
- restart quarantine, explicit recovery, cancellation, and timeout projection;
- queue, text, media byte/count/dimension, storage, and delivery bounds;
- private topology, state-file, profile, and database validation;
- pinned Pi/sandbox publication, attestation inputs, and fail-closed startup;
- immutable inbound/outbound artifacts and owner-bound channel delivery; and
- current/legacy WeChat upload shapes plus validated response results.

The host suite exercises the real systemd/Bubblewrap startup attestation and
descriptor-confined publication helper with no provider or channel credential.

## Credentialed attended evidence

| Integration | Result | Reason / next action |
| --- | --- | --- |
| Native Pi provider Turn | not run | no designated operator Pi profile or live provider credential was supplied to this implementation session |
| Telegram receive/send/media | not run | no designated bot token/private account was supplied |
| WeChat QR receive/send/media | not run | no designated authenticated state/private peer was supplied |

The release is therefore deterministic- and host-ready, but the operator must
complete the short attended checklist in `docs/operator-guide.md` for whichever
provider and channels are actually available. One authenticated provider and
one intended channel are sufficient to begin concept testing; unavailable
integrations remain plainly recorded rather than blocking the trusted-personal
MVP setup.
