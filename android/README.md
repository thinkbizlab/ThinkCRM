# WorkCRM Android (Kotlin + Jetpack Compose)

The Android client for the WorkCRM workspace. Mirrors the iOS app's module
structure 1:1 so changes to the API contract land in two predictable places.

## First-time setup

```bash
# 1. Open in Android Studio (Hedgehog or newer)
# 2. Sync Gradle
# 3. Drop `google-services.json` into android/app/ from
#    Firebase Console → Project Settings → Your Apps → workcrm-android
# 4. Run on emulator or physical device
```

Application ID: `com.workstationoffice.workcrm`  ·  minSdk 26  ·  targetSdk 35.

The API base URL is read from BuildConfig:
| Build type | API base URL                                     |
| ---------- | ------------------------------------------------ |
| `debug`    | `http://10.0.2.2:3000/api/v1` (host Fastify dev) |
| `release`  | `https://app.thinkbizcrm.com/api/v1`             |

Override `WORK_CRM_API_BASE_URL` in `local.properties` to point a debug build
at staging.

## Architecture

Same layout as the iOS app under `ios/WorkCRM/`:

```
app/src/main/java/com/workstationoffice/workcrm/
  app/          Application class, MainActivity, NavGraph
  designsystem/ Material 3 theme overrides (black + gold accent), buttons,
                bilingual Thai/English strings
  models/       @Serializable data classes mirroring the Fastify API
  networking/   Retrofit + OkHttp interceptors, EncryptedSharedPreferences token store
  auth/         LoginScreen, BiometricGate, AuthViewModel
  push/         FirebaseMessagingService + POST /auth/devices on token refresh
  visits/       List, detail, check-in, check-out
  deals/        Kanban, detail, Quick Update sheet
  masterdata/   Customer / Item read-only browsers
  kpi/          Personal + Team KPI screens
  offline/      Room-backed pending_action queue + WorkManager drain worker
  camera/       CameraX selfie capture
  location/     FusedLocationProviderClient single-fix wrapper
```

## Distribution

- **Internal Testing track** on Play Console — generate a signed AAB and
  upload. Reviewers are invited by Google account.
- **Closed Testing** once the org is comfortable. Production listing
  remains a separate decision tied to the iOS ABM Custom App rollout.

## Verification

1. Backend running locally: `cd .. && npm run dev` (binds 0.0.0.0:3000).
2. Sync Gradle, run on emulator.
3. Login as a `workcrm` rep, see today's visits, navigate to a visit, check
   in offline (airplane mode toggle), confirm the row drains when airplane
   mode flips off.
4. With FCM configured on the backend, push a KPI alert from Settings →
   Scheduled Jobs and confirm the notification lands.
