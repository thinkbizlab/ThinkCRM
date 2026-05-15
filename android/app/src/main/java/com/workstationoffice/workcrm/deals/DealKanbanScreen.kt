package com.workstationoffice.workcrm.deals

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.workstationoffice.workcrm.designsystem.Eyebrow
import com.workstationoffice.workcrm.designsystem.Tokens
import com.workstationoffice.workcrm.designsystem.WorkCard
import com.workstationoffice.workcrm.models.Deal
import com.workstationoffice.workcrm.models.DealStage
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

class DealKanbanViewModel : ViewModel() {
    data class State(
        val stages: List<DealStage> = emptyList(),
        val deals: List<Deal> = emptyList(),
        val isLoading: Boolean = false,
        val error: String? = null
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    init { refresh() }

    fun refresh() {
        _state.update { it.copy(isLoading = true, error = null) }
        viewModelScope.launch {
            try {
                val stages = DealsRepository.stages()
                val deals = DealsRepository.deals(limit = 200).rows
                _state.update { it.copy(stages = stages, deals = deals, isLoading = false) }
            } catch (e: Exception) {
                _state.update { it.copy(isLoading = false, error = e.message) }
            }
        }
    }
}

@androidx.compose.runtime.Composable
fun DealKanbanScreen(onOpenDeal: (String) -> Unit) {
    val viewModel: DealKanbanViewModel = viewModel()
    val state by viewModel.state.collectAsState()

    Box(modifier = Modifier.fillMaxSize().background(Tokens.backgroundPrimary)) {
        if (state.isLoading && state.stages.isEmpty()) {
            CircularProgressIndicator(color = Tokens.accent, modifier = Modifier.padding(40.dp))
        } else {
            Row(
                modifier = Modifier.fillMaxSize().horizontalScroll(rememberScrollState()).padding(20.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                state.stages.forEach { stage ->
                    val deals = state.deals.filter { it.stageId == stage.id && it.status == "OPEN" }
                    KanbanColumn(stage = stage, deals = deals, onOpenDeal = onOpenDeal)
                }
            }
        }
    }
}

@androidx.compose.runtime.Composable
private fun KanbanColumn(stage: DealStage, deals: List<Deal>, onOpenDeal: (String) -> Unit) {
    Column(
        modifier = Modifier.width(280.dp).fillMaxHeight(),
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Row {
            Eyebrow(stage.stageName)
            Spacer(modifier = Modifier.weight(1f))
            Text(deals.size.toString(), color = Tokens.textSecondary, style = MaterialTheme.typography.bodyMedium)
        }
        LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(deals, key = { it.id }) { deal ->
                Surface(
                    color = Tokens.backgroundElevated,
                    onClick = { onOpenDeal(deal.id) },
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Eyebrow(deal.dealNo)
                        Text(deal.dealName, color = Tokens.textPrimary, style = MaterialTheme.typography.bodyLarge)
                        Text(formatBaht(deal.estimatedValue), color = Tokens.accent, style = MaterialTheme.typography.bodyMedium)
                    }
                }
            }
        }
    }
}

private fun formatBaht(value: Double): String = when {
    value >= 1_000_000 -> "฿%.1fM".format(value / 1_000_000)
    value >= 1_000     -> "฿%.0fK".format(value / 1_000)
    else               -> "฿%.0f".format(value)
}
