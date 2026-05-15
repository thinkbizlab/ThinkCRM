package com.workstationoffice.workcrm.masterdata

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
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
import com.workstationoffice.workcrm.models.Item
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

class ItemListViewModel : ViewModel() {
    data class State(val rows: List<Item> = emptyList(), val loading: Boolean = false)
    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    private var offset = 0
    private var total = 0
    private val pageSize = 50

    init { refresh() }
    fun refresh() { offset = 0; total = 0; load(reset = true) }
    fun loadMore(lastId: String?) {
        if (lastId == null || lastId != _state.value.rows.lastOrNull()?.id) return
        if (_state.value.loading || _state.value.rows.size >= total) return
        load(reset = false)
    }

    private fun load(reset: Boolean) {
        _state.update { it.copy(loading = true) }
        viewModelScope.launch {
            try {
                val page = MasterDataRepository.items(limit = pageSize, offset = offset)
                total = page.total
                offset += page.rows.size
                _state.update {
                    it.copy(
                        rows = if (reset) page.rows else it.rows + page.rows,
                        loading = false
                    )
                }
            } catch (e: Exception) {
                _state.update { it.copy(loading = false) }
            }
        }
    }
}

@androidx.compose.runtime.Composable
fun ItemListScreen() {
    val vm: ItemListViewModel = viewModel()
    val state by vm.state.collectAsState()
    LazyColumn(
        modifier = Modifier.fillMaxSize().background(Tokens.backgroundPrimary),
        contentPadding = PaddingValues(20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        items(state.rows, key = { it.id }) { item ->
            WorkCard {
                Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                    Column(modifier = Modifier.weight(1f)) {
                        Eyebrow(item.itemCode)
                        Spacer(Modifier.height(4.dp))
                        Text(item.name, color = Tokens.textPrimary, style = MaterialTheme.typography.bodyLarge)
                    }
                    Text(formatBaht(item.unitPrice), color = Tokens.accent)
                }
            }
            LaunchedEffect(item.id) { vm.loadMore(item.id) }
        }
        if (state.loading) item { CircularProgressIndicator(color = Tokens.accent) }
    }
}

private fun formatBaht(value: Double): String = when {
    value >= 1_000_000 -> "฿%.1fM".format(value / 1_000_000)
    value >= 1_000     -> "฿%.0fK".format(value / 1_000)
    else               -> "฿%.0f".format(value)
}
