package com.workstationoffice.workcrm.kpi

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.workstationoffice.workcrm.designsystem.Eyebrow
import com.workstationoffice.workcrm.designsystem.L10n
import com.workstationoffice.workcrm.designsystem.Tokens
import com.workstationoffice.workcrm.designsystem.WorkCard
import com.workstationoffice.workcrm.designsystem.t
import com.workstationoffice.workcrm.models.TeamPerformanceRow
import kotlinx.coroutines.launch

@androidx.compose.runtime.Composable
fun TeamKpiScreen() {
    var rows by remember { mutableStateOf<List<TeamPerformanceRow>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) {
        scope.launch {
            try {
                rows = DashboardRepository.overview().teamPerformance.orEmpty()
            } catch (_: Exception) {}
            loading = false
        }
    }

    Column(modifier = Modifier.fillMaxSize().background(Tokens.backgroundPrimary).padding(20.dp).verticalScroll(rememberScrollState()),
           verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Eyebrow(t(L10n.KpiTeamTitle))
        when {
            loading -> CircularProgressIndicator(color = Tokens.accent)
            rows.isEmpty() -> Text("No team data yet", color = Tokens.textSecondary)
            else -> rows.forEach { row -> TeamRow(row) }
        }
    }
}

@androidx.compose.runtime.Composable
private fun TeamRow(row: TeamPerformanceRow) {
    WorkCard {
        Row {
            Text(row.teamName, color = Tokens.textPrimary, style = MaterialTheme.typography.titleLarge,
                 modifier = Modifier.weight(1f))
            Eyebrow("${row.memberCount} members")
        }
        Spacer(Modifier.height(12.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Cell("Active", row.activeDeals.toString(), Modifier.weight(1f))
            Cell("Pipeline", shortBaht(row.pipelineValue), Modifier.weight(1f))
            Cell("Won", shortBaht(row.wonValue), Modifier.weight(1f))
            Cell("Visit %", "${row.visitCompletionRate.toInt()}%", Modifier.weight(1f))
        }
    }
}

@androidx.compose.runtime.Composable
private fun Cell(label: String, value: String, modifier: Modifier = Modifier) {
    Column(modifier = modifier) {
        Eyebrow(label)
        Text(value, color = Tokens.textPrimary, style = MaterialTheme.typography.bodyLarge)
    }
}

private fun shortBaht(value: Double): String = when {
    value >= 1_000_000 -> "฿%.1fM".format(value / 1_000_000)
    value >= 1_000     -> "฿%.0fK".format(value / 1_000)
    else               -> "฿%.0f".format(value)
}
