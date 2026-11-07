# BrownHub Haul reliability, Studio palette, email and airport media design

## Goal

Correct the silent login path, make the whole application inherit BrownHub Studio's palette, preserve traveller records on durable hosting, send booking receipts by email, and add licensed airport motion without weakening accessibility or the existing booking/tracking flows.

## Approved decisions

- Mount account controls before booking configuration is fetched. A booking-engine outage may disable booking, but it must not make Login or Sign up inert. Account API failures remain visible in the existing account status region.
- Extend `appTokens()` to every semantic colour ramp and replace independent navy, blue and gold literals with Studio-derived dark brown, ivory, red and bronze tokens. Preserve Poppins, the cinematic layout, liquid glass, editorial motion and the lighter booking section.
- Keep accounts and bookings in the existing atomic JSON stores. Use the already-approved Render Starter blueprint and its 1 GB disk at `/data`; add explicit account and secret-key paths. Back up accessible production data before changing infrastructure. Do not claim durability until the paid disk is active and a restart/redeploy check passes.
- Add a server-only email module using Resend. Send only after a booking is persisted. The message contains a receipt, route, collection window, total and absolute tracking link, never the handover PIN. No recipient address means no send. Missing configuration or provider failure produces a non-blocking delivery warning; the booking remains successful.
- Use locally hosted, licensed real airport footage with attribution/source records. Hero media may load eagerly; below-fold video loads near the viewport. All video is muted, inline, looped and slowed, with a poster and static fallback for reduced motion, save-data or constrained devices. Existing CSS tilt supplies subtle perspective; no WebGL dependency.
- Bump the service-worker shell version after all shell changes. Static media remains network-first and API/photo requests remain uncached.

## Interfaces

### Email

`core/email.mjs` exports `createBookingMailer(options)` and `bookingReceipt(shipment, trackingUrl)`. The mailer returns `{ attempted, delivered, message }` and never throws provider failures into booking creation. Configuration uses `RESEND_API_KEY`, `RESEND_FROM`, and optional `PUBLIC_BASE_URL`; local verification uses a loopback stub and an injectable fetch implementation.

The booking response gains `email: { attempted, delivered, message }`. The confirmation dialog displays that status without exposing provider internals.

### Media

Airport `<video>` elements carry `data-airport-video`, `muted`, `loop`, `playsinline`, `preload="none"`, a poster, width and height. The motion module observes them, attaches sources only near the viewport, sets `playbackRate = 0.65`, and pauses offscreen/hidden video. Reduced-motion and save-data clients retain the poster without attaching video sources.

## Verification

- New regression tests fail before each production change and pass afterward.
- Existing auth, account UI, brand, journey, motion, PWA and WebKit suites run fresh.
- Email tests use only a local HTTP stub; no live mutation or email endpoint is probed.
- Real Chrome checks cover offline-engine login, desktop/mobile palette, booking success with email delivered and failed, reduced-motion/save-data posters, video playback and layout overflow.
- Persistence claims require evidence from the actual Render Starter disk; local restart tests alone do not prove production durability.
- L3 deep review is required before any push or deployment. Secrets are never printed or committed.
