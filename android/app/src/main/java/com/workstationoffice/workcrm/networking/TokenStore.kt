package com.workstationoffice.workcrm.networking

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.workstationoffice.workcrm.models.User
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/**
 * Keystore-backed token + user-snapshot store. Uses
 * `EncryptedSharedPreferences` so the tokens are sealed under a key the
 * device's hardware-backed Keystore manages. Mirrors iOS Keychain pattern
 * (kSecAttrAccessibleWhenUnlockedThisDeviceOnly).
 *
 * Singleton initialised once from [com.workstationoffice.workcrm.app.WorkCRMApplication].
 */
@Serializable
data class AuthSession(
    val accessToken: String,
    val refreshToken: String,
    val user: User
)

object TokenStore {
    private const val PREFS_NAME = "workcrm_secure_session"
    private const val KEY_SESSION = "session_v1"

    @Volatile private var prefs: android.content.SharedPreferences? = null
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    fun init(context: Context) {
        if (prefs != null) return
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        prefs = EncryptedSharedPreferences.create(
            context,
            PREFS_NAME,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }

    fun load(): AuthSession? {
        val raw = prefs?.getString(KEY_SESSION, null) ?: return null
        return runCatching { json.decodeFromString<AuthSession>(raw) }.getOrNull()
    }

    fun save(session: AuthSession) {
        prefs?.edit()?.putString(KEY_SESSION, json.encodeToString(session))?.apply()
    }

    fun clear() {
        prefs?.edit()?.remove(KEY_SESSION)?.apply()
    }
}
