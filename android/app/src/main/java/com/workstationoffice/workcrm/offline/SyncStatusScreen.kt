package com.workstationoffice.workcrm.offline

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.workstationoffice.workcrm.designsystem.Eyebrow
import com.workstationoffice.workcrm.designsystem.PrimaryButton
import com.workstationoffice.workcrm.designsystem.SecondaryButton
import com.workstationoffice.workcrm.designsystem.Tokens
import com.workstationoffice.workcrm.designsystem.WorkCard
import kotlinx.coroutines.launch

@androidx.compose.runtime.Composable
fun SyncStatusScreen() {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val actions by OfflineDatabase.get().pendingActionDao().observeAll().collectAsState(initial = emptyList())
    val online by Reachability.isOnline.collectAsState()

    Column(modifier = Modifier.fillMaxSize().background(Tokens.backgroundPrimary).padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        WorkCard {
            Text(if (online) "Online" else "Offline", color = Tokens.textPrimary, style = MaterialTheme.typography.titleLarge)
            Spacer(modifier = Modifier.height(8.dp))
            Text("${actions.size} pending", color = Tokens.textSecondary)
            Spacer(modifier = Modifier.height(12.dp))
            PrimaryButton(
                text = "Sync now",
                enabled = online && actions.isNotEmpty()
            ) {
                SyncEngine.scheduleNow(context)
            }
        }

        if (actions.isEmpty()) {
            Text("No pending actions", color = Tokens.textSecondary)
        } else {
            LazyColumn(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                items(actions, key = { it.id }) { action ->
                    WorkCard {
                        Eyebrow(if (action.kind == PendingActionKind.VISIT_CHECKIN) "Check-in" else "Check-out")
                        Spacer(modifier = Modifier.height(8.dp))
                        Text("Visit ${action.visitId}", color = Tokens.textPrimary)
                        Spacer(modifier = Modifier.height(4.dp))
                        Text("Attempts: ${action.retryCount}", color = Tokens.textSecondary)
                        action.lastError?.let {
                            Spacer(modifier = Modifier.height(8.dp))
                            Text(it, color = Tokens.danger)
                        }
                        if (action.lastError != null && action.retryCount >= 3) {
                            Spacer(modifier = Modifier.height(8.dp))
                            SecondaryButton(text = "Discard") {
                                scope.launch {
                                    OfflineDatabase.get().pendingActionDao().delete(action.id)
                                    action.selfieFilename?.let { SelfieStore.delete(context, it) }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
