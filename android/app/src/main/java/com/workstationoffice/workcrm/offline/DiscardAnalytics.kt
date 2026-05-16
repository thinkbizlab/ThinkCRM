package com.workstationoffice.workcrm.offline

import com.workstationoffice.workcrm.models.SyncDiscardBatch
import com.workstationoffice.workcrm.models.SyncDiscardEvent
import com.workstationoffice.workcrm.networking.ApiClient

/**
 * Best-effort analytics for the "user discarded a permanently-failed offline
 * action" event. Mirrors iOS DiscardAnalytics.swift. Failures here don't block
 * the discard itself — the row is already gone from the local queue by the
 * time we post, and the analytics row is opportunistic.
 */
object DiscardAnalytics {
    /** Build the event payload from a queued row being discarded. */
    fun event(action: PendingActionEntity, nowMillis: Long = System.currentTimeMillis()): SyncDiscardEvent {
        return SyncDiscardEvent(
            kind             = action.kind,                      // already matches the backend's enum
            visitId          = action.visitId,
            retryCount       = action.retryCount,
            lastError        = action.lastError?.take(500),
            queuedDurationMs = (nowMillis - action.createdAt).coerceAtLeast(0L).toInt(),
            platform         = "ANDROID"
        )
    }

    /** Fire-and-forget post. Errors are swallowed and logged. */
    suspend fun report(events: List<SyncDiscardEvent>) {
        if (events.isEmpty()) return
        try {
            ApiClient.api.postSyncDiscards(SyncDiscardBatch(events))
        } catch (e: Exception) {
            android.util.Log.w("DiscardAnalytics", "post failed: ${e.message}")
        }
    }
}
