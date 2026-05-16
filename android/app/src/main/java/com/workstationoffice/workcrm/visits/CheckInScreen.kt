package com.workstationoffice.workcrm.visits

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.workstationoffice.workcrm.camera.SelfieCameraScreen
import com.workstationoffice.workcrm.designsystem.PrimaryButton
import com.workstationoffice.workcrm.designsystem.Tokens
import com.workstationoffice.workcrm.designsystem.L10n
import com.workstationoffice.workcrm.designsystem.t
import com.workstationoffice.workcrm.location.LocationService
import com.workstationoffice.workcrm.offline.*
import kotlinx.coroutines.launch
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.time.Instant
import java.util.UUID

@OptIn(ExperimentalMaterial3Api::class)
@androidx.compose.runtime.Composable
fun CheckInScreen(visitId: String, onDone: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var captured by remember { mutableStateOf<ByteArray?>(null) }
    var submitting by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    if (captured == null) {
        SelfieCameraScreen(
            onCapture = { bytes -> captured = bytes },
            onCancel = onDone
        )
        return
    }

    // Once we have a JPEG, fetch GPS and enqueue. The view never sends the
    // check-in directly — the queue is the single code path, same as iOS.
    Box(modifier = Modifier.fillMaxSize().background(Tokens.backgroundPrimary)) {
        Column(
            modifier = Modifier.fillMaxSize().padding(32.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Text("Selfie captured (${captured!!.size / 1024} KB)", color = Tokens.textPrimary)
            error?.let { Text(it, color = Tokens.danger) }
            PrimaryButton(text = t(L10n.VisitCheckIn), enabled = !submitting) {
                submitting = true
                scope.launch {
                    try {
                        val location = LocationService.currentLocation(context)
                        val actionId = UUID.randomUUID().toString()
                        val filename = SelfieStore.save(context, actionId, captured!!)
                        val payload = CheckInPayload(
                            lat            = location.latitude,
                            lng            = location.longitude,
                            capturedAt     = Instant.now().toString(),
                            selfieFilename = filename
                        )
                        val entity = PendingActionEntity(
                            id              = actionId,
                            kind            = PendingActionKind.VISIT_CHECKIN,
                            visitId         = visitId,
                            payloadJson     = Json.encodeToString(payload),
                            selfieFilename  = filename,
                            createdAt       = System.currentTimeMillis(),
                            nextEligibleAt  = System.currentTimeMillis()
                        )
                        OfflineDatabase.get().pendingActionDao().insert(entity)
                        SyncEngine.scheduleNow(context)
                        onDone()
                    } catch (e: Exception) {
                        error = e.message ?: "Check-in failed"
                        submitting = false
                    }
                }
            }
        }
    }
}
