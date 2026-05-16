package com.workstationoffice.workcrm.auth

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.workstationoffice.workcrm.models.LoginRequest
import com.workstationoffice.workcrm.networking.ApiClient
import com.workstationoffice.workcrm.networking.AuthSession
import com.workstationoffice.workcrm.networking.TokenStore
import com.workstationoffice.workcrm.push.DeviceRegistrar
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class AuthState(
    val session: AuthSession? = null,
    val isSubmitting: Boolean = false,
    val errorMessage: String? = null
)

/**
 * Coordinates login + sign-out and bridges TokenStore to Compose. Mirrors
 * iOS AuthViewModel — the StateFlow's `session` field drives the
 * Login vs MainNav top-level branch in MainActivity.
 */
class AuthViewModel : ViewModel() {
    private val _state = MutableStateFlow(AuthState(session = TokenStore.load()))
    val state: StateFlow<AuthState> = _state.asStateFlow()

    fun signIn(tenantSlug: String, email: String, password: String) {
        _state.update { it.copy(isSubmitting = true, errorMessage = null) }
        viewModelScope.launch {
            try {
                val response = ApiClient.api.login(
                    LoginRequest(
                        tenantSlug = tenantSlug.trim(),
                        email      = email.trim().lowercase(),
                        password   = password
                    )
                )
                val session = AuthSession(
                    accessToken  = response.accessToken,
                    refreshToken = response.refreshToken,
                    user         = response.user
                )
                TokenStore.save(session)
                _state.update { it.copy(session = session, isSubmitting = false) }
                // Best-effort FCM device-token registration. Failures are
                // non-fatal — the next launch re-tries.
                DeviceRegistrar.registerIfPossible()
            } catch (e: Exception) {
                _state.update { it.copy(isSubmitting = false, errorMessage = humanise(e)) }
            }
        }
    }

    fun signOut() {
        TokenStore.clear()
        _state.update { it.copy(session = null) }
    }

    private fun humanise(e: Exception): String {
        // The retrofit HttpException class is per-call; pull a clean message
        // for the 401 case which is the one users see most often.
        val msg = e.message ?: return "Sign-in failed"
        if (msg.contains("401")) return "Invalid email or password"
        return msg
    }
}
