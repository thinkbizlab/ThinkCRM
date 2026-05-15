package com.workstationoffice.workcrm.app

import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.fragment.app.FragmentActivity
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
}
