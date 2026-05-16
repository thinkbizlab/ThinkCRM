package com.workstationoffice.workcrm.app

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.workstationoffice.workcrm.auth.AuthViewModel
import com.workstationoffice.workcrm.designsystem.Eyebrow

@Composable
fun MoreScreen(
    auth: AuthViewModel,
    onOpenCustomers: () -> Unit,
    onOpenItems: () -> Unit,
    onOpenTeamKpi: () -> Unit,
    onOpenSync: () -> Unit
) {
    val state by auth.state.collectAsState()

    Column(
        modifier = Modifier.fillMaxSize().padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        state.session?.user?.let { user ->
            Text(user.fullName, style = MaterialTheme.typography.titleLarge)
            Text(user.email,    style = MaterialTheme.typography.bodyMedium)
            HorizontalDivider()
        }

        Eyebrow("Browse")
        TextButton(onClick = onOpenCustomers) { Text("Customers") }
        TextButton(onClick = onOpenItems)     { Text("Items") }

        Eyebrow("KPI")
        TextButton(onClick = onOpenTeamKpi) { Text("Team KPI") }

        Eyebrow("Offline")
        TextButton(onClick = onOpenSync) { Text("Sync Status") }

        HorizontalDivider()
        TextButton(onClick = { auth.signOut() }) { Text("Sign out") }
    }
}
