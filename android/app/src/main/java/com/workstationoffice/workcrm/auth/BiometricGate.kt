package com.workstationoffice.workcrm.auth

import android.content.Context
import android.content.ContextWrapper
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.fragment.app.FragmentActivity
import com.workstationoffice.workcrm.designsystem.PrimaryButton
import com.workstationoffice.workcrm.designsystem.Tokens

/**
 * Wraps content behind a FaceID/fingerprint/passcode gate using
 * androidx.biometric. Mirrors iOS BiometricGate. If biometrics aren't
 * enrolled, falls back to device passcode (`BIOMETRIC_WEAK | DEVICE_CREDENTIAL`).
 */
@Composable
fun BiometricGate(content: @Composable () -> Unit) {
    val context = LocalContext.current
    val activity = remember(context) { context.findFragmentActivity() }
    var unlocked by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        if (activity == null) {
            // Compose-only previews / tests — skip the gate.
            unlocked = true
            return@LaunchedEffect
        }
        promptForUnlock(activity, onSuccess = { unlocked = true }, onError = { error = it })
    }

    if (unlocked) {
        content()
    } else {
        Column(
            modifier = Modifier.fillMaxSize().padding(32.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Text("WorkCRM", style = MaterialTheme.typography.titleLarge, color = Tokens.textPrimary)
            error?.let { Text(it, color = Tokens.danger, style = MaterialTheme.typography.bodyMedium) }
            PrimaryButton(text = "Unlock", onClick = {
                activity?.let { promptForUnlock(it, onSuccess = { unlocked = true }, onError = { error = it }) }
            })
        }
    }
}

private fun promptForUnlock(
    activity: FragmentActivity,
    onSuccess: () -> Unit,
    onError: (String) -> Unit
) {
    val executor = androidx.core.content.ContextCompat.getMainExecutor(activity)
    val prompt = BiometricPrompt(activity, executor, object : BiometricPrompt.AuthenticationCallback() {
        override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) { onSuccess() }
        override fun onAuthenticationError(errorCode: Int, errString: CharSequence) { onError(errString.toString()) }
    })

    val info = BiometricPrompt.PromptInfo.Builder()
        .setTitle("Unlock WorkCRM")
        .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_WEAK or BiometricManager.Authenticators.DEVICE_CREDENTIAL)
        .build()

    prompt.authenticate(info)
}

private fun Context.findFragmentActivity(): FragmentActivity? {
    var ctx: Context? = this
    while (ctx is ContextWrapper) {
        if (ctx is FragmentActivity) return ctx
        ctx = ctx.baseContext
    }
    return null
}
