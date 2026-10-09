# Native Assistant calls

Authenticated outgoing audio calls for the LegalWork iOS client. The device uses CallKit and WebRTC, with an ActivityKit extension for Lock Screen and Dynamic Island status. This service reuses the existing OpenAI Realtime provider configuration. A funded API account is required.

## API

All routes require an active client token with collaborator scope and a writable server. Call ownership is bound to the authenticated token hash. Clients cannot choose a workspace or session.

- `GET /assistant/calls/capability`: existing voice-provider capability.
- `POST /assistant/calls`: `{ id: UUID, sdp: string }`; idempotently creates a dedicated call session and returns the WebRTC answer.
- `GET /assistant/calls/:id`: refreshes the call lease and returns completed coordinator text, request receipts, and working state. The client polls every two seconds while audio is active.
- `POST /assistant/calls/:id/work`: `{ id: toolCallID, request: string }`; accepts the caller's request into the persistent Assistant session queue. An ID cannot be reused for different instructions.
- `DELETE /assistant/calls/:id`: ends voice access and provider audio. Accepted work continues.

The dedicated coordinator has the normal Assistant tools, can query projects and metadata, and delegates substantial tasks. While the call is active, project results return to the call coordinator. After hang-up, the existing persistent delegation pipeline returns results to the main Assistant. A phone call is not blanket approval for unrelated actions. Existing approvals remain required.

The registry and SDP answers are ephemeral; audio does not resume after a server restart. Accepted requests and delegation tracking are persistent. A lost heartbeat expires voice access after 60 seconds, and calls have a two-hour upper bound. Expiration, explicit hang-up, and orderly shutdown request provider hang-up. Microphone transport closes immediately in the app. Upstream voice-service limits may end a call sooner.

Only outgoing calls are implemented. Incoming callbacks would additionally require PushKit device registration, a VoIP APNs topic, a call invitation lifecycle, and immediate CallKit reporting when a VoIP push arrives. Existing reply notifications remain ordinary APNs alerts and must not be sent as VoIP pushes.

## Validation

```sh
pnpm --filter legalwork-server exec bun test src/calls/service.test.ts src/assistant-session-queue.test.ts src/assistant-delegations.test.ts
pnpm --filter legalwork-server build
```

Checks cover caller isolation, concurrent setup, duplicate work, cancellation during setup, expiry, provider hang-up, hidden control text, and durable work after hang-up. The iOS repository contains the fixture UI and opt-in live project-query tests. The live attempt on 9 October 2026 reached OpenAI but returned HTTP 429 because the configured account had no API credits; live voice and delegated project lookup remain unverified.

References: [CallKit](https://developer.apple.com/documentation/callkit/making-and-receiving-voip-calls), [ActivityKit](https://developer.apple.com/documentation/activitykit/displaying-live-data-with-live-activities), [Realtime WebRTC](https://developers.openai.com/api/docs/guides/realtime-webrtc), [server-side Realtime controls](https://developers.openai.com/api/docs/guides/voice-server-controls).
