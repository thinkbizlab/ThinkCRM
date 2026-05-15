# WorkCRM iOS (SwiftUI)

The iOS client for the WorkCRM workspace (internal app for ~100+ employees in
the Workstation Office org).

This folder holds the **source files only**. The `WorkCRM.xcodeproj` is
generated on-demand by [XcodeGen](https://github.com/yonaskolb/XcodeGen) from
`project.yml`, so we never commit Xcode's binary `.pbxproj` blob.

## First-time setup

```bash
# 1. Install XcodeGen (once per machine)
brew install xcodegen

# 2. Generate the Xcode project
cd ios
xcodegen generate

# 3. Open it
open WorkCRM.xcodeproj
```

Sign in with the Apple Developer account holding Team ID `8G83Q2867K` (the same
team that owns Bundle ID `com.workstationoffice.workcrm`).

## Configuration

The API base URL is read from the build's Info.plist `WorkCRMAPIBaseURL` key.
Two `.xcconfig` files set it per scheme:

| Scheme       | API Base URL                                  |
| ------------ | --------------------------------------------- |
| `Debug`      | `http://localhost:3000/api/v1` (local dev)    |
| `Release`    | `https://app.thinkbizcrm.com/api/v1`          |

To point a debug build at the preview / staging environment, edit
`Configs/Debug.xcconfig` locally — it's gitignored under `*.local.xcconfig`.

## Architecture

```
WorkCRM/
  App/          @main, scene delegate, root router
  DesignSystem/ Colors, Typography, Buttons — workselected.com aesthetic
  Auth/         LoginView, KeychainStore, BiometricGate
  Networking/   APIClient (URLSession), TokenStore, refresh interceptor
  Push/         APNs registration → POST /auth/devices
  Visits/       List, detail, check-in, check-out
  Deals/        Kanban, detail, Quick Update sheet
  MasterData/   Customer / Item / Payment-term read-only browsers
  KPI/          Personal + Team KPI progress
  Offline/      GRDB-backed sync queue + reachability + BGTask scheduler
  Camera/       SelfieCaptureView (AVFoundation)
  Location/     LocationService (CLLocationManager)
  Models/       Codable structs matching the Fastify API shapes
```

## Distribution

- **TestFlight** (internal beta — no Apple review): Xcode → Product → Archive
  → upload to App Store Connect → add testers in the WorkCRM TestFlight group.
- **Production** (eventual ABM Custom App): once Apple Business Manager
  enrollment finishes with D-U-N-S `662073062`, the same archive is published
  as a Custom App scoped to the org.

## Verification (Smoke test)

1. Run a backend locally: `cd .. && npm run dev`.
2. Generate Xcode project: `xcodegen generate`.
3. Run on Simulator → login with `tenantSlug=workcrm`, an admin email and
   password.
4. The Today screen should load with paginated visits.
5. Plug in a physical iPhone → APNs token registers on first sign-in →
   trigger a KPI alert from Settings → Scheduled Jobs → notification arrives.
