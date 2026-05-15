package com.workstationoffice.workcrm.deals

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.workstationoffice.workcrm.designsystem.Eyebrow
import com.workstationoffice.workcrm.designsystem.PrimaryButton
import com.workstationoffice.workcrm.designsystem.Tokens
import com.workstationoffice.workcrm.designsystem.WorkCard
import com.workstationoffice.workcrm.models.Deal
import com.workstationoffice.workcrm.models.DealProgressUpdate
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@androidx.compose.runtime.Composable
fun DealDetailScreen(dealId: String) {
    var deal by remember(dealId) { mutableStateOf<Deal?>(null) }
    var updates by remember(dealId) { mutableStateOf<List<DealProgressUpdate>>(emptyList()) }
    var showSheet by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(dealId) {
        scope.launch {
            deal = try { DealsRepository.detail(dealId) } catch (e: Exception) { null }
            updates = try { DealsRepository.progressUpdates(dealId) } catch (e: Exception) { emptyList() }
        }
    }

    Box(modifier = Modifier.fillMaxSize().background(Tokens.backgroundPrimary)) {
        if (deal == null) {
            CircularProgressIndicator(modifier = Modifier.align(Alignment.Center), color = Tokens.accent)
            return
        }
        val d = deal!!
        Column(
            modifier = Modifier.fillMaxSize().padding(20.dp).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            WorkCard {
                Eyebrow(d.dealNo)
                Spacer(Modifier.height(8.dp))
                Text(d.dealName, color = Tokens.textPrimary, style = MaterialTheme.typography.headlineSmall)
                Spacer(Modifier.height(12.dp))
                Text(formatBaht(d.estimatedValue), color = Tokens.accent)
            }

            PrimaryButton(text = "Quick Update") { showSheet = true }

            Eyebrow("Progress")
            if (updates.isEmpty()) {
                Text("No updates yet", color = Tokens.textSecondary)
            } else {
                updates.forEach { update ->
                    WorkCard {
                        Text(update.note, color = Tokens.textPrimary)
                        Spacer(Modifier.height(8.dp))
                        Text(update.createdBy?.fullName ?: "—", color = Tokens.textSecondary, style = MaterialTheme.typography.bodyMedium)
                    }
                }
            }
        }

        if (showSheet) {
            QuickUpdateSheet(
                deal = d,
                onDismiss = { showSheet = false },
                onSaved = { saved ->
                    showSheet = false
                    deal = saved
                    scope.launch {
                        updates = try { DealsRepository.progressUpdates(dealId) } catch (e: Exception) { updates }
                    }
                }
            )
        }
    }
}

private fun formatBaht(value: Double): String = when {
    value >= 1_000_000 -> "฿%.1fM".format(value / 1_000_000)
    value >= 1_000     -> "฿%.0fK".format(value / 1_000)
    else               -> "฿%.0f".format(value)
}
