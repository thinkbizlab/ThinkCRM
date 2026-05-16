package com.workstationoffice.workcrm.auth

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.background
import androidx.compose.foundation.shape.RectangleShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.input.ImeAction
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
    val keyboard = LocalSoftwareKeyboardController.current
    val context = LocalContext.current

    fun submit() {
        if (state.isSubmitting || email.isBlank() || password.isBlank() || tenantSlug.isBlank()) return
        keyboard?.hide()
        viewModel.signIn(tenantSlug, email, password)
    }

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
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next),
            modifier = Modifier.fillMaxWidth()
        )

        OutlinedTextField(
            value = email,
            onValueChange = { email = it },
            label = { Text(t(L10n.LoginEmail)) },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next),
            modifier = Modifier.fillMaxWidth()
        )

        // KeyboardType.Password marks the field as a password to AutofillService
        // and the Google Password Manager, which surfaces saved credentials.
        OutlinedTextField(
            value = password,
            onValueChange = { password = it },
            label = { Text(t(L10n.LoginPassword)) },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { submit() }),
            modifier = Modifier.fillMaxWidth()
        )

        state.errorMessage?.let { error ->
            Text(error, color = Tokens.danger, style = MaterialTheme.typography.bodyMedium)
        }

        PrimaryButton(
            text = t(L10n.LoginCta),
            enabled = !state.isSubmitting && email.isNotBlank() && password.isNotBlank() && tenantSlug.isNotBlank(),
            onClick = { submit() }
        )

        // ── Divider between password and OAuth ────────────────────────────
        androidx.compose.foundation.layout.Row(
            verticalAlignment = Alignment.CenterVertically
        ) {
            HorizontalDivider(modifier = Modifier.weight(1f), color = Tokens.surfaceBorder)
            Text(
                "  or  ",
                color = Tokens.textSecondary,
                style = MaterialTheme.typography.bodyMedium
            )
            HorizontalDivider(modifier = Modifier.weight(1f), color = Tokens.surfaceBorder)
        }

        OutlinedButton(
            onClick = {
                keyboard?.hide()
                viewModel.signInWithMicrosoft(context, tenantSlug)
            },
            enabled = !state.isSubmitting && tenantSlug.isNotBlank(),
            modifier = Modifier.fillMaxWidth().height(48.dp)
        ) {
            MicrosoftMark()
            androidx.compose.foundation.layout.Spacer(modifier = Modifier.width(8.dp))
            Text("Sign in with Microsoft")
        }
    }
}

/**
 * Microsoft "windowed" mark: four equal colored squares in a 2×2 grid. Hardcoded
 * colors stay correct across light/dark backgrounds, and inlining avoids
 * dragging in a Microsoft brand vector asset.
 */
@Composable
private fun MicrosoftMark() {
    val side = 7.dp
    val gap  = 1.dp
    androidx.compose.foundation.layout.Column(verticalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(gap)) {
        androidx.compose.foundation.layout.Row(horizontalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(gap)) {
            androidx.compose.foundation.layout.Box(modifier = Modifier.size(side).clip(RectangleShape).background(Color(0xFFF25022)))
            androidx.compose.foundation.layout.Box(modifier = Modifier.size(side).clip(RectangleShape).background(Color(0xFF7FBA00)))
        }
        androidx.compose.foundation.layout.Row(horizontalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(gap)) {
            androidx.compose.foundation.layout.Box(modifier = Modifier.size(side).clip(RectangleShape).background(Color(0xFF00A4EF)))
            androidx.compose.foundation.layout.Box(modifier = Modifier.size(side).clip(RectangleShape).background(Color(0xFFFFB900)))
        }
    }
}

