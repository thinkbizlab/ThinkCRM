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
import com.workstationoffice.workcrm.models.Customer
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

class CustomerListViewModel : ViewModel() {
    data class State(val rows: List<Customer> = emptyList(), val loading: Boolean = false)
    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    private var page = 1
    private var totalPages = 1

    init { refresh() }
    fun refresh() { page = 1; load(reset = true) }
    fun loadMore(lastId: String?) {
        if (lastId == null || lastId != _state.value.rows.lastOrNull()?.id) return
        if (_state.value.loading || page >= totalPages) return
        page += 1
        load(reset = false)
    }

    private fun load(reset: Boolean) {
        _state.update { it.copy(loading = true) }
        viewModelScope.launch {
            try {
                val resp = MasterDataRepository.customers(page = page)
                totalPages = resp.totalPages
                _state.update {
                    it.copy(
                        rows = if (reset) resp.rows else it.rows + resp.rows,
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
fun CustomerListScreen() {
    val vm: CustomerListViewModel = viewModel()
    val state by vm.state.collectAsState()
    LazyColumn(
        modifier = Modifier.fillMaxSize().background(Tokens.backgroundPrimary),
        contentPadding = PaddingValues(20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        items(state.rows, key = { it.id }) { c ->
            WorkCard {
                c.customerCode?.let { Eyebrow(it) }
                Spacer(Modifier.height(4.dp))
                Text(c.name, color = Tokens.textPrimary, style = MaterialTheme.typography.bodyLarge)
                c.taxId?.takeIf { it.isNotBlank() }?.let {
                    Spacer(Modifier.height(4.dp))
                    Text(it, color = Tokens.textSecondary, style = MaterialTheme.typography.bodyMedium)
                }
            }
            LaunchedEffect(c.id) { vm.loadMore(c.id) }
        }
        if (state.loading) item { CircularProgressIndicator(color = Tokens.accent) }
    }
}
