package com.workstationoffice.workcrm.visits

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.workstationoffice.workcrm.designsystem.Eyebrow
import com.workstationoffice.workcrm.designsystem.L10n
import com.workstationoffice.workcrm.designsystem.PrimaryButton
import com.workstationoffice.workcrm.designsystem.Tokens
import com.workstationoffice.workcrm.designsystem.WorkCard
import com.workstationoffice.workcrm.designsystem.t
import com.workstationoffice.workcrm.models.Visit
import com.workstationoffice.workcrm.offline.OfflineDatabase
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@androidx.compose.runtime.Composable
fun VisitDetailScreen(
    visitId: String,
    onCheckIn: (String) -> Unit,
    onCheckOut: (String) -> Unit
) {
    var visit by remember(visitId) { mutableStateOf<Visit?>(null) }
    var pendingForVisit by remember(visitId) { mutableStateOf(0) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(visitId) {
        scope.launch {
            visit = try { VisitsRepository.detail(visitId) } catch (e: Exception) { null }
            pendingForVisit = OfflineDatabase.get().pendingActionDao().forVisit(visitId).size
        }
    }

    Box(modifier = Modifier.fillMaxSize().background(Tokens.backgroundPrimary)) {
        if (visit == null) {
            CircularProgressIndicator(modifier = Modifier.align(Alignment.Center), color = Tokens.accent)
            return
        }
        val v = visit!!
        Column(modifier = Modifier.fillMaxSize().padding(20.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
            WorkCard {
                v.visitNo?.let { Eyebrow(it) }
                Spacer(modifier = Modifier.height(8.dp))
                Text(v.customer?.name ?: "—", color = Tokens.textPrimary, style = MaterialTheme.typography.headlineSmall)
            }

            if (pendingForVisit > 0) {
                WorkCard {
                    Text(t(L10n.VisitPendingSync), color = Tokens.accent)
                }
            }

            v.objective?.takeIf { it.isNotBlank() }?.let {
                WorkCard {
                    Eyebrow("Objective")
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(it, color = Tokens.textPrimary)
                }
            }

            when {
                v.status == "PLANNED" && pendingForVisit == 0 ->
                    PrimaryButton(text = t(L10n.VisitCheckIn)) { onCheckIn(v.id) }
                v.status == "CHECKED_IN" && pendingForVisit == 0 ->
                    PrimaryButton(text = t(L10n.VisitCheckOut)) { onCheckOut(v.id) }
                else -> {}
            }

            v.result?.takeIf { it.isNotBlank() }?.let {
                WorkCard {
                    Eyebrow("Result")
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(it, color = Tokens.textPrimary)
                }
            }
        }
    }
}
