package com.workstationoffice.workcrm.push

import android.os.Build
import com.google.firebase.messaging.FirebaseMessaging
import com.workstationoffice.workcrm.models.DeviceRegistrationRequest
import com.workstationoffice.workcrm.networking.ApiClient
import com.workstationoffice.workcrm.networking.TokenStore
import kotlinx.coroutines.tasks.await

/**
 * POSTs the current FCM device token to `/auth/devices` so the backend can
 * fan out push notifications to this Android device.
 *
 * Called from:
 *   - AuthViewModel.signIn (best-effort, right after the user authorizes)
 *   - FcmService.onNewToken (when FCM rotates the token)
 *
 * Both call sites tolerate failure — the next sign-in or token rotation will
 * retry. We only attempt registration when a session exists, since /auth/devices
 * is an authenticated endpoint.
 */
object DeviceRegistrar {
    suspend fun registerIfPossible() {
        if (TokenStore.load() == null) return
        try {
            val token = FirebaseMessaging.getInstance().token.await()
            ApiClient.api.registerDevice(
                DeviceRegistrationRequest(
                    platform    = "ANDROID",
                    deviceToken = token,
                    deviceName  = "${Build.MANUFACTURER} ${Build.MODEL}"
                )
            )
        } catch (e: Exception) {
            // Non-fatal — log and move on.
            android.util.Log.w("DeviceRegistrar", "FCM token registration failed: ${e.message}")
        }
    }
}
