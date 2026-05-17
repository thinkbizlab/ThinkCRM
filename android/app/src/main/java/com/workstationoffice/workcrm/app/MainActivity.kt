package com.workstationoffice.workcrm.app

import android.content.Intent
import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.fragment.app.FragmentActivity
import com.workstationoffice.workcrm.auth.MicrosoftOAuth
import androidx.compose.material3.Surface
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.viewmodel.compose.viewModel
import com.workstationoffice.workcrm.auth.AuthViewModel
import com.workstationoffice.workcrm.auth.BiometricGate
import com.workstationoffice.workcrm.auth.LoginScreen
import com.workstationoffice.workcrm.designsystem.Tokens
import com.workstationoffice.workcrm.designsystem.WorkCRMTheme

class MainActivity : FragmentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // If we were cold-launched directly by the OAuth redirect (rare — usually
        // singleTask means we're already up), the initial intent carries the
        // callback URL too. Cover that case.
        intent?.data?.let { MicrosoftOAuth.deliverCallback(it) }
        setContent {
            WorkCRMTheme {
                Surface(color = Tokens.backgroundPrimary, modifier = Modifier) {
                    val auth: AuthViewModel = viewModel()
                    val state by auth.state.collectAsState()
                    if (state.session != null) {
                        BiometricGate { MainNav(auth = auth) }
                    } else {
                        LoginScreen(viewModel = auth)
                    }
                }
            }
        }
    }

    /// Called when the OS routes a `workcrm://oauth/callback?...` intent back
    /// to this already-running activity (singleTask launchMode keeps us
    /// foreground rather than creating a fresh activity instance). We hand the
    /// URI off to the OAuth helper which resolves the in-flight continuation.
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        intent.data?.let { MicrosoftOAuth.deliverCallback(it) }
    }
}
