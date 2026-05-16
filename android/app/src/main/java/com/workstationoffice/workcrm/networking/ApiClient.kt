package com.workstationoffice.workcrm.networking

import com.workstationoffice.workcrm.BuildConfig
import com.workstationoffice.workcrm.models.RefreshRequest
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory
import java.util.concurrent.TimeUnit

/**
 * Builds the Retrofit instance and wires the two OkHttp interceptors:
 *   - AuthInterceptor injects `Authorization: Bearer <access>` on every
 *     authed request.
 *   - RefreshInterceptor catches 401s, runs a single-flight refresh, and
 *     retries the original request once. If refresh fails, it clears the
 *     session so the UI bounces to LoginScreen.
 *
 * Mirrors ios/WorkCRM/Networking/APIClient.swift.
 */
object ApiClient {
    private val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
        coerceInputValues = true
    }

    private val refreshMutex = Mutex()

    private val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .addInterceptor(authInterceptor)
            .addInterceptor(refreshInterceptor)
            .apply {
                if (BuildConfig.DEBUG) {
                    addInterceptor(HttpLoggingInterceptor().apply {
                        level = HttpLoggingInterceptor.Level.BASIC
                    })
                }
            }
            .build()
    }

    val api: WorkCrmApi by lazy {
        Retrofit.Builder()
            .baseUrl(BuildConfig.API_BASE_URL.let { if (it.endsWith("/")) it else "$it/" })
            .client(client)
            .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
            .build()
            .create(WorkCrmApi::class.java)
    }

    private val authInterceptor = okhttp3.Interceptor { chain ->
        val token = TokenStore.load()?.accessToken
        val request = if (token != null) {
            chain.request().newBuilder()
                .addHeader("Authorization", "Bearer $token")
                .build()
        } else chain.request()
        chain.proceed(request)
    }

    private val refreshInterceptor = okhttp3.Interceptor { chain ->
        val original = chain.request()
        val response = chain.proceed(original)
        if (response.code != 401 || original.url.encodedPath.endsWith("/auth/refresh")) {
            return@Interceptor response
        }

        // Single-flight refresh. The backend's refresh-token rotation has
        // replay detection — re-submitting the same refresh token twice
        // revokes ALL sessions for the user. So if 12 requests fire in
        // parallel and all 401, we must guarantee only one of them actually
        // calls /auth/refresh. We pass the stale access token in so the
        // mutex's late arrivals can detect "someone else already rotated"
        // and skip the refresh.
        val staleAccessToken = original.header("Authorization")?.removePrefix("Bearer ")
        val refreshed = runBlocking { tryRefresh(staleAccessToken) }
        if (!refreshed) {
            return@Interceptor response
        }
        response.close()

        // Retry exactly once with the new token.
        val newToken = TokenStore.load()?.accessToken ?: return@Interceptor response
        val retried = original.newBuilder()
            .header("Authorization", "Bearer $newToken")
            .build()
        chain.proceed(retried)
    }

    private suspend fun tryRefresh(staleAccessToken: String?): Boolean = refreshMutex.withLock {
        val current = TokenStore.load() ?: return false
        // Another caller already rotated us — skip the refresh and let
        // the interceptor retry the original request with the new token.
        if (staleAccessToken != null && current.accessToken != staleAccessToken) return true
        return try {
            // Build a fresh Retrofit client without our refresh interceptor
            // to avoid infinite recursion. Reuse the same JSON converter.
            val rawClient = OkHttpClient.Builder()
                .connectTimeout(15, TimeUnit.SECONDS)
                .readTimeout(15, TimeUnit.SECONDS)
                .build()
            val rawApi = Retrofit.Builder()
                .baseUrl(BuildConfig.API_BASE_URL.let { if (it.endsWith("/")) it else "$it/" })
                .client(rawClient)
                .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
                .build()
                .create(WorkCrmApi::class.java)
            val refreshed = rawApi.refresh(RefreshRequest(current.refreshToken))
            TokenStore.save(
                current.copy(
                    accessToken  = refreshed.accessToken,
                    refreshToken = refreshed.refreshToken
                )
            )
            true
        } catch (e: Exception) {
            TokenStore.clear()
            false
        }
    }
}
