package com.workstationoffice.workcrm.offline

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.workstationoffice.workcrm.models.CheckInRequest
import com.workstationoffice.workcrm.models.CheckOutRequest
import com.workstationoffice.workcrm.networking.ApiClient
import kotlinx.coroutines.delay
import kotlinx.serialization.json.Json
import retrofit2.HttpException

/**
 * The Android counterpart to iOS SyncEngine. WorkManager owns the wake-on-
 * connectivity behavior — schedule one-time work with a CONNECTED constraint,
 * and the OS handles "drain when network returns" without us subscribing.
 */
object SyncEngine {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    /**
     * Reset a row so it's eligible immediately and clear its backoff/error
     * state, then schedule a drain. Used by the "Retry now" button on the
     * Sync Status screen — drain() alone wouldn't pick up a permanently-failed
     * row since the failure path pushed nextEligibleAt 24h into the future.
     */
    suspend fun retryNow(context: Context, actionId: String) {
        val dao = OfflineDatabase.get().pendingActionDao()
        val row = dao.listAll().firstOrNull { it.id == actionId } ?: return
        dao.update(row.copy(
            retryCount     = 0,
            lastError      = null,
            lastAttemptAt  = null,
            nextEligibleAt = System.currentTimeMillis()
        ))
        scheduleNow(context)
    }

    /** Enqueue a one-time drain. Idempotent — APPEND_OR_REPLACE keeps the queue moving without duplicating runs. */
    fun scheduleNow(context: Context) {
        val request = OneTimeWorkRequestBuilder<SyncWorker>()
            .setConstraints(
                Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.CONNECTED)
                    .build()
            )
            .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(
            "workcrm-sync",
            ExistingWorkPolicy.REPLACE,
            request
        )
    }

    suspend fun drain(context: Context) {
        val dao = OfflineDatabase.get().pendingActionDao()
        while (true) {
            val row = dao.nextEligible(System.currentTimeMillis()) ?: break
            try {
                send(row)
                dao.delete(row.id)
                row.selfieFilename?.let { SelfieStore.delete(context, it) }
            } catch (e: HttpException) {
                handleHttpError(dao, row, e)
            } catch (e: Exception) {
                handleTransientError(dao, row, e)
            }
            // Tiny yield so a flood of queued actions doesn't hog the worker.
            delay(50)
        }
    }

    private suspend fun send(row: PendingActionEntity) {
        when (row.kind) {
            PendingActionKind.VISIT_CHECKIN -> {
                val payload = json.decodeFromString(CheckInPayload.serializer(), row.payloadJson)
                val context = currentContext() ?: error("SyncEngine: no Application context")
                val jpegData = SelfieStore.load(context, payload.selfieFilename)
                val request = CheckInRequest(
                    lat             = payload.lat,
                    lng             = payload.lng,
                    selfieUrl       = SelfieStore.toDataUri(jpegData),
                    capturedAt      = payload.capturedAt,
                    clientRequestId = row.id
                )
                ApiClient.api.checkIn(row.visitId, request)
            }
            PendingActionKind.VISIT_CHECKOUT -> {
                val payload = json.decodeFromString(CheckOutPayload.serializer(), row.payloadJson)
                val request = CheckOutRequest(
                    lat             = payload.lat,
                    lng             = payload.lng,
                    result          = payload.result,
                    capturedAt      = payload.capturedAt,
                    clientRequestId = row.id
                )
                ApiClient.api.checkOut(row.visitId, request)
            }
        }
    }

    private suspend fun handleHttpError(dao: PendingActionDao, row: PendingActionEntity, e: HttpException) {
        val code = e.code()
        // Permanent 4xx (except 401/408/429) → push next attempt 24h out and
        // mark with lastError so the user can act in Sync Status.
        if (code in 400 until 500 && code !in setOf(401, 408, 429)) {
            dao.update(row.copy(
                retryCount = row.retryCount + 1,
                lastError  = "HTTP $code",
                lastAttemptAt = System.currentTimeMillis(),
                nextEligibleAt = System.currentTimeMillis() + 24 * 60 * 60 * 1000L
            ))
            return
        }
        // Transient — backoff.
        dao.update(row.copy(
            retryCount = row.retryCount + 1,
            lastError  = "HTTP $code",
            lastAttemptAt = System.currentTimeMillis(),
            nextEligibleAt = System.currentTimeMillis() + backoffMillis(row.retryCount + 1)
        ))
    }

    private suspend fun handleTransientError(dao: PendingActionDao, row: PendingActionEntity, e: Exception) {
        dao.update(row.copy(
            retryCount = row.retryCount + 1,
            lastError  = e.message ?: e.javaClass.simpleName,
            lastAttemptAt = System.currentTimeMillis(),
            nextEligibleAt = System.currentTimeMillis() + backoffMillis(row.retryCount + 1)
        ))
    }

    /** 30s, 2m, 10m, 30m, 1h capped — mirrors iOS table. Internal for tests. */
    internal fun backoffMillis(retryCount: Int): Long {
        val table = longArrayOf(30_000, 120_000, 600_000, 1_800_000, 3_600_000)
        val idx = (retryCount - 1).coerceIn(0, table.size - 1)
        return table[idx]
    }

    // Application context handoff — set from WorkCRMApplication. Cleanly hands
    // a context to the engine without requiring every Repository to thread one
    // through. The worker also passes its own context to drain().
    @Volatile private var appContext: Context? = null
    fun setContext(context: Context) { appContext = context.applicationContext }
    private fun currentContext(): Context? = appContext
}

/** WorkManager worker — single drain pass. Retries the whole job on FAILURE so
 *  a single transient error doesn't strand the queue. */
class SyncWorker(appContext: Context, params: WorkerParameters) : CoroutineWorker(appContext, params) {
    override suspend fun doWork(): Result {
        SyncEngine.setContext(applicationContext)
        return try {
            SyncEngine.drain(applicationContext)
            Result.success()
        } catch (e: Exception) {
            Result.retry()
        }
    }
}
