package com.workstationoffice.workcrm.auth

import android.content.Context
import android.net.Uri
import android.util.Base64
import androidx.browser.customtabs.CustomTabsIntent
import com.workstationoffice.workcrm.models.LoginResponse
import com.workstationoffice.workcrm.models.OAuthBeginRequest
import com.workstationoffice.workcrm.models.OAuthCompleteRequest
import com.workstationoffice.workcrm.networking.ApiClient
import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.suspendCancellableCoroutine
import java.security.MessageDigest
import java.security.SecureRandom
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Sign-in with Microsoft via OAuth 2.0 authorization-code flow + PKCE.
 *
 *   1. POST /auth/oauth/ms365/mobile/begin → returns the authorize URL the
 *      client opens in a Chrome Custom Tab. We send the PKCE code_challenge.
 *   2. User signs in inside the Custom Tab. Microsoft redirects to
 *      `workcrm://oauth/callback?code=…&state=…`.
 *   3. Android routes the redirect back to MainActivity (singleTask +
 *      <intent-filter android:scheme="workcrm" host="oauth" pathPrefix="/callback"/>).
 *      MainActivity calls [deliverCallback]; this object's suspended continuation
 *      resumes with the parsed code + state.
 *   4. POST /auth/oauth/ms365/mobile/complete with { code, state, codeVerifier,
 *      tenantSlug } — backend exchanges with Microsoft (proving possession via
 *      the verifier), returns our own JWT pair.
 */
sealed class MicrosoftOAuthException(message: String) : Exception(message) {
    object UserCancelled : MicrosoftOAuthException("Sign-in cancelled.")
    class InvalidCallback(reason: String) : MicrosoftOAuthException("Sign-in returned an invalid response: $reason")
    class Backend(message: String) : MicrosoftOAuthException(message)
}

object MicrosoftOAuth {
    private const val REDIRECT_URI = "workcrm://oauth/callback"
    private const val CALLBACK_SCHEME = "workcrm"

    @Volatile
    private var pending: CancellableContinuation<Uri>? = null

    /** Called by `MainActivity.onNewIntent` whenever the OS delivers a URL with our scheme. */
    fun deliverCallback(uri: Uri) {
        val cont = pending ?: return
        pending = null
        if (uri.scheme != CALLBACK_SCHEME) {
            cont.resumeWithException(MicrosoftOAuthException.InvalidCallback("scheme=${uri.scheme}"))
            return
        }
        cont.resume(uri)
    }

    /** Run the full flow and return a [LoginResponse]. Throws on cancel or HTTP failure. */
    suspend fun signIn(context: Context, tenantSlug: String): LoginResponse {
        val verifier = generateCodeVerifier()
        val challenge = codeChallenge(verifier)

        // Step 1 — get the authorize URL with our PKCE challenge baked in.
        val begin = ApiClient.api.ms365MobileBegin(
            OAuthBeginRequest(
                tenantSlug    = tenantSlug,
                codeChallenge = challenge,
                redirectUri   = REDIRECT_URI
            )
        )

        // Step 2-3 — open Chrome Custom Tab, wait for the redirect back into MainActivity.
        val callbackUri = launchCustomTab(context, Uri.parse(begin.authorizationUrl))
        val code  = callbackUri.getQueryParameter("code")
            ?: throw MicrosoftOAuthException.InvalidCallback("missing code")
        val state = callbackUri.getQueryParameter("state")
            ?: throw MicrosoftOAuthException.InvalidCallback("missing state")

        // Step 4 — exchange on the backend, receive our session tokens.
        return try {
            ApiClient.api.ms365MobileComplete(
                OAuthCompleteRequest(
                    tenantSlug   = tenantSlug,
                    code         = code,
                    state        = state,
                    codeVerifier = verifier,
                    redirectUri  = REDIRECT_URI
                )
            )
        } catch (e: Exception) {
            throw MicrosoftOAuthException.Backend(e.message ?: "Token exchange failed.")
        }
    }

    private suspend fun launchCustomTab(context: Context, authUrl: Uri): Uri =
        suspendCancellableCoroutine { cont ->
            pending = cont
            cont.invokeOnCancellation { if (pending === cont) pending = null }

            // Custom Tab shares cookies with Chrome so a previously-signed-in
            // MS account on the device just works (same UX argument as iOS's
            // ASWebAuthenticationSession with prefersEphemeralWebBrowserSession=false).
            val customTabs = CustomTabsIntent.Builder()
                .setShowTitle(true)
                .build()
            try {
                customTabs.launchUrl(context, authUrl)
            } catch (e: Exception) {
                pending = null
                cont.resumeWithException(MicrosoftOAuthException.Backend("Could not open browser: ${e.message}"))
            }
            // Note: there is no reliable "user dismissed the tab" signal from
            // Custom Tabs. If the user backs out, the continuation simply never
            // resumes — the caller's coroutine scope cancels eventually when the
            // user navigates away from LoginScreen, and our invokeOnCancellation
            // clears the pending slot.
        }

    // MARK: - PKCE helpers

    /// Generate a 43–128 char URL-safe code_verifier per RFC 7636 §4.1. We pick
    /// 32 random bytes → 43 base64url chars, comfortably above the floor and
    /// matching what most OAuth client libraries do by default.
    private fun generateCodeVerifier(): String {
        val bytes = ByteArray(32)
        SecureRandom().nextBytes(bytes)
        return base64UrlNoPadding(bytes)
    }

    /// `code_challenge = base64url(SHA256(code_verifier))` — the `S256` method.
    private fun codeChallenge(verifier: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII))
        return base64UrlNoPadding(digest)
    }

    private fun base64UrlNoPadding(bytes: ByteArray): String =
        Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
}
