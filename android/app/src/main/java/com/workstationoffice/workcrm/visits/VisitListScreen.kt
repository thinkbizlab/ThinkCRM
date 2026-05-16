package com.workstationoffice.workcrm.visits

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.workstationoffice.workcrm.designsystem.Eyebrow
import com.workstationoffice.workcrm.designsystem.L10n
import com.workstationoffice.workcrm.designsystem.Tokens
import com.workstationoffice.workcrm.designsystem.WorkCard
import com.workstationoffice.workcrm.designsystem.t
import com.workstationoffice.workcrm.models.Visit
import com.workstationoffice.workcrm.offline.OfflineDatabase
import com.workstationoffice.workcrm.offline.Reachability
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

class VisitListViewModel : ViewModel() {
    data class State(
        val visits: List<Visit> = emptyList(),
        val isLoading: Boolean = false,
        val error: String? = null
    )

    private val pageSize = 50
    private var offset = 0
    private var total = 0
    private var exhausted = false

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    init { refresh() }

    fun refresh() {
        offset = 0; total = 0; exhausted = false
        fetch(reset = true)
    }

    fun loadMoreIfNeeded(lastId: String?) {
        if (lastId == null) return
        if (exhausted || _state.value.isLoading) return
        if (_state.value.visits.lastOrNull()?.id != lastId) return
        fetch(reset = false)
    }

    private fun fetch(reset: Boolean) {
        _state.update { it.copy(isLoading = true, error = null) }
        viewModelScope.launch {
            try {
                val page = VisitsRepository.list(limit = pageSize, offset = offset)
                total = page.total
                offset += page.rows.size
                val merged = if (reset) page.rows else _state.value.visits + page.rows
                _state.update { it.copy(visits = merged, isLoading = false) }
                if (merged.size >= total || page.rows.isEmpty()) exhausted = true
            } catch (e: Exception) {
                _state.update { it.copy(isLoading = false, error = e.message ?: "Load failed") }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@androidx.compose.runtime.Composable
fun VisitListScreen(onOpenVisit: (String) -> Unit) {
    val viewModel: VisitListViewModel = viewModel()
    val state by viewModel.state.collectAsState()
    val pendingCount by OfflineDatabase.get().pendingActionDao().observeCount().collectAsState(initial = 0)
    val online by Reachability.isOnline.collectAsState()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(t(L10n.TabToday)) },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Tokens.backgroundPrimary)
            )
        },
        bottomBar = {
            if (pendingCount > 0 || !online) {
                PendingFooter(pendingCount = pendingCount, online = online)
            }
        }
    ) { padding ->
        Box(modifier = Modifier.fillMaxSize().padding(padding).background(Tokens.backgroundPrimary)) {
            when {
                state.isLoading && state.visits.isEmpty() ->
                    CircularProgressIndicator(modifier = Modifier.align(Alignment.Center), color = Tokens.accent)
                state.visits.isEmpty() -> Text(
                    t(L10n.VisitsEmpty),
                    color = Tokens.textSecondary,
                    modifier = Modifier.align(Alignment.Center)
                )
                else -> LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(20.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    item { Eyebrow(t(L10n.VisitsTitle)) }
                    items(state.visits, key = { it.id }) { visit ->
                        VisitRow(visit = visit, onTap = { onOpenVisit(visit.id) })
                        LaunchedEffect(visit.id) {
                            viewModel.loadMoreIfNeeded(visit.id)
                        }
                    }
                    if (state.isLoading) {
                        item { CircularProgressIndicator(color = Tokens.accent) }
                    }
                }
            }
        }
    }
}

@androidx.compose.runtime.Composable
private fun VisitRow(visit: Visit, onTap: () -> Unit) {
    val label = buildString {
        visit.visitNo?.let { append(it); append(", ") }
        append(visit.customer?.name ?: "no customer")
        append(", status ")
        append(visit.status.replace('_', ' ').lowercase())
        visit.plannedAt?.let { append(", planned ").append(it) }
    }
    Box(modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp))) {
        Surface(
            color = Tokens.backgroundElevated,
            onClick = onTap,
            // mergeDescendants flattens the child Text composables for TalkBack
            // so swiping the list reads one announcement per row instead of
            // bouncing through 4+ child elements per card.
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 48.dp)
                .semantics(mergeDescendants = true) { contentDescription = label }
        ) {
            Column(modifier = Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    visit.visitNo?.let { Eyebrow(it) }
                    Spacer(modifier = Modifier.weight(1f))
                    StatusChip(status = visit.status)
                }
                Text(visit.customer?.name ?: "—", color = Tokens.textPrimary, style = MaterialTheme.typography.titleLarge)
                visit.objective?.takeIf { it.isNotBlank() }?.let {
                    Text(it, color = Tokens.textSecondary, maxLines = 2)
                }
            }
        }
    }
}

@androidx.compose.runtime.Composable
private fun StatusChip(status: String) {
    val (label, color) = when (status) {
        "PLANNED"     -> "PLANNED"     to Tokens.textSecondary
        "CHECKED_IN"  -> "CHECKED IN"  to Tokens.accent
        "CHECKED_OUT" -> "DONE"        to Tokens.success
        "CANCELLED"   -> "CANCELLED"   to Tokens.danger
        else          -> status        to Tokens.textSecondary
    }
    Text(
        text = label,
        color = color,
        style = MaterialTheme.typography.labelSmall,
        modifier = Modifier
            .clip(RoundedCornerShape(99.dp))
            .background(Tokens.backgroundPrimary)
            .padding(horizontal = 8.dp, vertical = 4.dp)
    )
}

@androidx.compose.runtime.Composable
private fun PendingFooter(pendingCount: Int, online: Boolean) {
    Box(
        // liveRegion = Polite makes TalkBack announce changes to the footer
        // (count drops, online flip) without interrupting the user's current
        // focus — so a rep who just queued an offline check-in hears the
        // confirmation when sync completes.
        modifier = Modifier
            .fillMaxWidth().padding(20.dp).clip(RoundedCornerShape(12.dp))
            .background(Tokens.backgroundElevated).padding(16.dp)
            .semantics { liveRegion = LiveRegionMode.Polite }
    ) {
        Text(
            text = if (online)
                "Pending: $pendingCount · Syncing…"
            else
                "${t(L10n.VisitOffline)} · $pendingCount pending",
            color = Tokens.textPrimary,
            style = MaterialTheme.typography.bodyMedium
        )
    }
}
