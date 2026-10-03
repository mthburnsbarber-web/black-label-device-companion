# Version 1 integration contract (proposal)

## Trust and topology

Cloudflare hosts the dashboard and a durable, bounded relay/coordination service so status remains available when the Mac mini is offline. Each approved native companion establishes an **outbound** authenticated TLS connection to the relay; no inbound home or office port is required. Device-to-device payloads require application-layer authenticated encryption to the destination device key, with authenticated source/destination IDs and a bound sequence, expiry, MIME, length, and hash. TLS protects the hops; end-to-end encryption keeps plaintext away from the cloud relay. Use an established protocol/library (for example, reviewed HPKE or Noise implementation), not bespoke cryptography. No keys or sessions are provisioned here.

Pairing must be a user-confirmed exchange of device public keys/fingerprints and scopes, bound to the signed-in Black Label account. The dashboard may request pairing, but neither a browser click nor possession of an unverified device ID establishes trust. Store private keys in each OS credential store; provide revocation, key rotation, and a short-lived pairing challenge. A recipient rejects unknown, revoked, expired, wrong-target, and replayed envelopes. Do not allow cloud administration to forge `verified` receipts.

## Dashboard API

The following is an interface proposal, not a running HTTP service. The existing dashboard uses `device-mini` style IDs and a local `/api/clipboard/validate` preview. It should map those records to durable paired identities only after the native enrollment flow exists.

| Method | Path | Result |
| --- | --- | --- |
| GET | `/v1/devices` | `{id,label,pairingState,connectionState,lastSeenAt,optedIn,paused,capabilities}`. `connectionState` is heartbeat based, with explicit stale/offline state. |
| POST | `/v1/transfers` | Request `{requestId,sourceDeviceId,targetDeviceId,contentType:"text/plain;charset=utf-8",sourceRevision,consentGrant}`. Requires dashboard session authorization and on-device source consent. Return `{transferId,state:"queued",expiresAt}`; queue is not delivery. Plaintext must be supplied by an approved companion, never scraped from the browser's global clipboard. |
| GET | `/v1/transfers/{id}` | `{transferId,sourceDeviceId,targetDeviceId,state,attempts,byteLength,createdAt,expiresAt,updatedAt,errorCode}`. No clipboard content or key material. |
| POST | `/v1/devices/{id}/pause` | Authenticated owner action; companion also enforces local pause. Resume is a separate explicit action. |

Companion/relay envelope: `{version:1,id,sequence,sourceDeviceId,targetDeviceId,sourceRevision,targetRevision,expiresAt,mime,byteLength,sha256,ciphertext}` plus authenticated key IDs and signature/AEAD context. Limits: text only, 1–65536 UTF-8 bytes, 30-second expiry in this prototype, maximum three send attempts. The assembled companion first sends `prepare`, receives `prepared` with a target revision, then sends `transfer`. Its `receipt` messages carry `received`, `applied`, or a terminal state. Sequence advances per source; duplicate ID with identical metadata returns the persisted terminal receipt, while same ID with different metadata is an error. Reordered old sequence is rejected. Do not log `ciphertext`, plaintext, SHA-256 of short content, pairing tokens, or secrets.

Recipient messages are separate authenticated ACKs: `received` after integrity/type/expiry/replay validation; `applied` after revision-checked native write; `verified` after recipient readback of the same revision and hash. `verification_failed`, `concurrent_change`, `permission_denied`, `expired`, and `offline` are distinct. The cloud may relay ACKs but cannot upgrade a state itself. If the connection drops after apply, query the recipient by ID on reconnect rather than creating a new transfer. If it remains offline past expiry, show `expired_unverified` and never auto-apply later. A dashboard can remain online while every target device is offline.

## Stages

1. Current: disabled native adapter/client, assembled companion, persistent metadata, in-process relay, and deterministic tests. No real device or Cloudflare connection.
2. Cloudflare coordination/relay, outbound companions, device pairing, encryption, revocation, and security review; verify exact wire format and authenticated peer identity.
3. Approved Mac trial with live permission, race, restart, and readback tests on one device pair.
4. Dashboard Devices UI, then additional desktop OS adapters. Consider input control through reviewed native components only after separate opt-in and OS permissions.
5. Mobile app capabilities assessed individually. A mobile browser is a status/control surface, not an always-on OS companion.
