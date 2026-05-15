package com.workstationoffice.workcrm.auth

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.workstationoffice.workcrm.designsystem.Eyebrow
import com.workstationoffice.workcrm.designsystem.L10n
import com.workstationoffice.workcrm.designsystem.PrimaryButton
import com.workstationoffice.workcrm.designsystem.Tokens
import com.workstationoffice.workcrm.designsystem.t

private const val DEFAULT_TENANT = "workcrm"

@Composable
fun LoginScreen(viewModel: AuthViewModel) {
    val state by viewModel.state.collectAsState()
    var tenantSlug by remember { mutableStateOf(DEFAULT_TENANT) }
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }

    Column(
        modifier = Modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.spacedBy(20.dp)
    ) {
        Spacer(Modifier.height(40.dp))
        Eyebrow("WorkCRM")
        Text(
            t(L10n.LoginTitle),
            style = MaterialTheme.typography.displayMedium,
            color = Tokens.textPrimary
        )

        OutlinedTextField(
            value = tenantSlug,
            onValueChange = { tenantSlug = it },
            label = { Text(t(L10n.LoginTenantSlug)) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth()
        )

        OutlinedTextField(
            value = email,
            onValueChange = { email = it },
            label = { Text(t(L10n.LoginEmail)) },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
            modifier = Modifier.fillMaxWidth()
        )

        OutlinedTextField(
            value = password,
            onValueChange = { password = it },
            label = { Text(t(L10n.LoginPassword)) },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            modifier = Modifier.fillMaxWidth()
        )

        state.errorMessage?.let { error ->
            Text(error, color = Tokens.danger, style = MaterialTheme.typography.bodyMedium)
        }

        PrimaryButton(
            text = t(L10n.LoginCta),
            enabled = !state.isSubmitting && email.isNotBlank() && password.isNotBlank() && tenantSlug.isNotBlank(),
            onClick = { viewModel.signIn(tenantSlug, email, password) }
        )
    }
}
