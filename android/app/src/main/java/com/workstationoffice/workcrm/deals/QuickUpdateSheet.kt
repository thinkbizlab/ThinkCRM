package com.workstationoffice.workcrm.deals

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.workstationoffice.workcrm.designsystem.PrimaryButton
import com.workstationoffice.workcrm.designsystem.SecondaryButton
import com.workstationoffice.workcrm.designsystem.Tokens
import com.workstationoffice.workcrm.models.Deal
import com.workstationoffice.workcrm.models.DealUpdateRequest
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId

@OptIn(ExperimentalMaterial3Api::class)
@androidx.compose.runtime.Composable
fun QuickUpdateSheet(
    deal: Deal,
    onDismiss: () -> Unit,
    onSaved: (Deal) -> Unit
) {
    val scope = rememberCoroutineScope()
    var estimatedValue by remember { mutableStateOf(deal.estimatedValue.toLong().toString()) }
    var followUpAt by remember { mutableStateOf(deal.followUpAt) }       // ISO-8601 string
    var note by remember { mutableStateOf("") }
    var submitting by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(20.dp).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Text("Quick Update", style = MaterialTheme.typography.titleLarge, color = Tokens.textPrimary)
            Text("${deal.dealNo} · ${deal.dealName}", color = Tokens.textSecondary)

            OutlinedTextField(
                value = estimatedValue,
                onValueChange = { estimatedValue = it.filter(Char::isDigit) },
                label = { Text("Estimated value (THB)") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                modifier = Modifier.fillMaxWidth()
            )

            OutlinedTextField(
                value = followUpAt,
                onValueChange = { followUpAt = it },
                label = { Text("Next follow-up (YYYY-MM-DD)") },
                modifier = Modifier.fillMaxWidth()
            )

            OutlinedTextField(
                value = note,
                onValueChange = { note = it },
                label = { Text("Progress note (optional)") },
                modifier = Modifier.fillMaxWidth().height(120.dp)
            )

            error?.let { Text(it, color = Tokens.danger) }

            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                SecondaryButton(text = "Cancel", onClick = onDismiss)
                PrimaryButton(text = "Save", enabled = !submitting) {
                    submitting = true
                    scope.launch {
                        try {
                            val patch = buildPatch(deal, estimatedValue, followUpAt)
                            val updated = if (patch.hasAnyField()) DealsRepository.update(deal.id, patch) else deal
                            if (note.isNotBlank()) DealsRepository.postProgress(deal.id, note.trim())
                            onSaved(updated)
                        } catch (e: Exception) {
                            error = e.message ?: "Update failed"
                            submitting = false
                        }
                    }
                }
            }
        }
    }
}

private fun buildPatch(deal: Deal, estimatedRaw: String, followUpRaw: String): DealUpdateRequest {
    val nextValue = estimatedRaw.toDoubleOrNull()?.takeIf { it >= 0 && it != deal.estimatedValue }
    val nextFollowUp = followUpRaw.takeIf { it.isNotBlank() && it != deal.followUpAt }?.let { raw ->
        // Accept either YYYY-MM-DD or full ISO-8601 — the backend's PATCH /deals/:id parses with `new Date(string)`.
        if (raw.length == 10) "${raw}T00:00:00Z" else raw
    }
    return DealUpdateRequest(
        estimatedValue = nextValue,
        followUpAt     = nextFollowUp,
        closedAt       = null,
        stageId        = null
    )
}

private fun DealUpdateRequest.hasAnyField(): Boolean =
    estimatedValue != null || followUpAt != null || closedAt != null || stageId != null
