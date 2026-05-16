package com.workstationoffice.workcrm.visits

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.workstationoffice.workcrm.designsystem.Eyebrow
import com.workstationoffice.workcrm.designsystem.L10n
import com.workstationoffice.workcrm.designsystem.PrimaryButton
import com.workstationoffice.workcrm.designsystem.Tokens
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
fun CheckOutScreen(visitId: String, onDone: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var result by remember { mutableStateOf("") }
    var submitting by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    Column(
        modifier = Modifier.fillMaxSize().background(Tokens.backgroundPrimary).padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        Eyebrow("Check-out result")
        OutlinedTextField(
            value = result,
            onValueChange = { result = it },
            modifier = Modifier.fillMaxWidth().height(180.dp),
            placeholder = { Text("ส่งใบเสนอราคาแล้ว / Sent quotation") }
        )
        error?.let { Text(it, color = Tokens.danger) }
        Spacer(modifier = Modifier.weight(1f))
        PrimaryButton(
            text = t(L10n.VisitCheckOut),
            enabled = !submitting && result.isNotBlank()
        ) {
            submitting = true
            scope.launch {
                try {
                    val location = LocationService.currentLocation(context)
                    val actionId = UUID.randomUUID().toString()
                    val payload = CheckOutPayload(
                        lat        = location.latitude,
                        lng        = location.longitude,
                        capturedAt = Instant.now().toString(),
                        result     = result.trim()
                    )
                    val entity = PendingActionEntity(
                        id             = actionId,
                        kind           = PendingActionKind.VISIT_CHECKOUT,
                        visitId        = visitId,
                        payloadJson    = Json.encodeToString(payload),
                        createdAt      = System.currentTimeMillis(),
                        nextEligibleAt = System.currentTimeMillis()
                    )
                    OfflineDatabase.get().pendingActionDao().insert(entity)
                    SyncEngine.scheduleNow(context)
                    onDone()
                } catch (e: Exception) {
                    error = e.message ?: "Check-out failed"
                    submitting = false
                }
            }
        }
    }
}
