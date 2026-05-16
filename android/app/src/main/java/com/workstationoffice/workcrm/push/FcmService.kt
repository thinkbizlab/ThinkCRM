package com.workstationoffice.workcrm.push

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * Receives FCM tokens + push payloads.
 *
 * The Notification builder used by the system to display incoming pushes
 * runs automatically when the payload has a `notification` block. Our
 * backend's `sendFcmPush` sends both `notification` (title/body for the
 * system tray) and `data` (the routing metadata, so foreground handlers
 * can deep-link). Custom in-foreground handling can be added in
 * `onMessageReceived` later.
 */
class FcmService : FirebaseMessagingService() {
    private val scope = CoroutineScope(Dispatchers.IO)

    override fun onNewToken(token: String) {
        super.onNewToken(token)
        // FCM rotated us a new token (reinstall, restore, or scheduled rotation).
        // Push it to the backend so /auth/devices stays current.
        scope.launch { DeviceRegistrar.registerIfPossible() }
    }

    override fun onMessageReceived(message: RemoteMessage) {
        // Most of our pushes are display-only (KPI alerts, visit reminders).
        // We could add custom handling here for e.g. a `data.type=visit_assigned`
        // payload that deep-links to /visits/:id, but for the MVP we let the
        // system handle rendering and rely on the user tapping into the app
        // manually.
    }
}
