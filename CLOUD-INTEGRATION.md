# Cloudflare device relay contract

The deployed Council dashboard currently has no device relay (`/api/clipboard/validate` returns 501). This repository's working integration is a loopback-only HTTP relay. The cloud owner can implement the same routes behind a **separate device-scoped Cloudflare Access service policy** and a verified binding from each Access service identity to exactly one device ID. Cloudflare documents the `CF-Access-Client-Id` and `CF-Access-Client-Secret` [service token headers](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/) for automated clients and recommends validating the [Access JWT assertion](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/) at the Worker. `HttpRelayClient` accepts externally supplied `{clientId,clientSecret}` and sends those headers. The existing owner-email browser JWT check is not a substitute for per-device identity.

## Wire routes

- `GET /health`: requires a valid device identity. Returns `{ok:true}`.
- `POST /frames`: device identity comes from verified Access identity, never the untrusted `x-device-id` header alone. Body `{to,payload,expiresAt}`. `payload` is an opaque AEAD frame. Enforce paired destination, active scope, expiry no more than 30 seconds, maximum 256 KiB request, per-device rate and queue limits. Return `{seq}` on enqueue.
- `GET /frames?after=N`: returns at most 100 `{seq,from,payload,expiresAt}` entries for the authenticated recipient only. `from` must be set by the relay from verified source identity. Expired frames must not be returned. Preserve cursor order across reconnects.

Only the paired endpoint can decrypt `payload`. The reference `PairwiseAeadCodec` uses AES-256-GCM with a fresh nonce per frame and authenticates source and target IDs in associated data. Keys must be unique per pair and provisioned through an approved, revocable enrollment flow into native credential stores. A real deployment needs key rotation and replay review before handling sensitive clipboard data. The loopback test uses fixed **test-only** keys and tokens; they are never suitable for a live relay.

The Worker should expose **status metadata only** to the owner dashboard: device connected/last-seen, paused, capability, transfer ID, attempts, and `received`/`applied`/`verified` state. It must not log or add plaintext, ciphertext, short-content hashes, device service tokens, or pair keys to room events. Cloud queue success is not proof of recipient write. A target must issue authenticated `verified` only after its native clipboard readback matches the expected revision, byte length, and SHA-256.

## Activation gates

1. Complete owner-approved device enrollment and a separate Cloudflare Access service policy; map every service identity to one device and verify revocation.
2. Bind the relay to the approved Council hostname or a separate approved hostname without weakening the existing browser Access rule. Apply queue expiry and limits before enabling any device.
3. Provide pair keys through an approved native credential-store flow. Never put them in this repository, browser storage, a URL, or dashboard D1 room records.
4. Verify one actual Mac-to-Mac pair with explicit clipboard permission, short/multiline/Unicode/64 KiB values, disconnect/reconnect, stale revision, permission denial, and recipient readback. Then assess Windows and Linux adapters separately.

No Cloudflare resource, service token, pair key, OS permission, or real clipboard has been created or accessed by this repository's tests.
