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
import com.workstationoffice.workcrm.models.DashboardOverview
import com.workstationoffice.workcrm.models.KpiSummary
import com.workstationoffice.workcrm.models.TargetVsActual
import kotlinx.coroutines.launch

@androidx.compose.runtime.Composable
fun PersonalKpiScreen(repId: String?) {
    var overview by remember(repId) { mutableStateOf<DashboardOverview?>(null) }
    var loading by remember { mutableStateOf(true) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(repId) {
        if (repId == null) { loading = false; return@LaunchedEffect }
        scope.launch {
            overview = try { DashboardRepository.overview(repId = repId) } catch (e: Exception) { null }
            loading = false
        }
    }

    Column(
        modifier = Modifier.fillMaxSize().background(Tokens.backgroundPrimary).padding(20.dp)
            .verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        Eyebrow(t(L10n.KpiPersonalTitle))
        Text(overview?.period?.month ?: DashboardRepository.currentMonthKey(),
             color = Tokens.textPrimary, style = MaterialTheme.typography.headlineSmall)

        if (DashboardRepository.daysLeftInMonth() <= 5) {
            WorkCard {
                Text("${DashboardRepository.daysLeftInMonth()} ${t(L10n.KpiDaysLeft)}", color = Tokens.accent)
            }
        }

        when {
            loading -> CircularProgressIndicator(color = Tokens.accent)
            overview == null || repId == null -> Text("No KPI target set", color = Tokens.textSecondary)
            else -> {
                val mine = overview!!.targetVsActual.firstOrNull { it.userId == repId }
                if (mine != null) {
                    Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                        KpiRing(
                            progress      = mine.progress.visits / 100.0,
                            label         = t(L10n.KpiVisits),
                            primaryText   = mine.actual.visits.toInt().toString(),
                            secondaryText = "/ ${mine.target.visits.toInt()}"
                        )
                        KpiRing(
                            progress      = mine.progress.revenue / 100.0,
                            label         = t(L10n.KpiRevenue),
                            primaryText   = shortBaht(mine.actual.revenue),
                            secondaryText = shortBaht(mine.target.revenue)
                        )
                        KpiRing(
                            progress      = mine.progress.newDealValue / 100.0,
                            label         = "Pipeline",
                            primaryText   = shortBaht(mine.actual.newDealValue),
                            secondaryText = shortBaht(mine.target.newDealValue)
                        )
                    }
                }
                SummaryGrid(kpi = overview!!.kpis)
            }
        }
    }
}

@androidx.compose.runtime.Composable
private fun SummaryGrid(kpi: KpiSummary) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Eyebrow("This month")
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            SummaryCell(title = "Active deals", value = kpi.activeDeals.toString(), modifier = Modifier.weight(1f))
            SummaryCell(title = t(L10n.KpiVisits), value = kpi.visitsPlannedInPeriod.toString(), modifier = Modifier.weight(1f))
        }
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            SummaryCell(title = "Won", value = shortBaht(kpi.wonValue), modifier = Modifier.weight(1f))
            SummaryCell(title = "Pipeline", value = shortBaht(kpi.pipelineValue), modifier = Modifier.weight(1f))
        }
    }
}

@androidx.compose.runtime.Composable
private fun SummaryCell(title: String, value: String, modifier: Modifier = Modifier) {
    Box(modifier = modifier) {
        WorkCard {
            Eyebrow(title)
            Spacer(modifier = Modifier.height(4.dp))
            Text(value, color = Tokens.textPrimary, style = MaterialTheme.typography.titleLarge)
        }
    }
}

private fun shortBaht(value: Double): String = when {
    value >= 1_000_000 -> "฿%.1fM".format(value / 1_000_000)
    value >= 1_000     -> "฿%.0fK".format(value / 1_000)
    else               -> "฿%.0f".format(value)
}
