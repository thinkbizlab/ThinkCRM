package com.workstationoffice.workcrm.offline

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.PrimaryKey
import java.util.UUID

/**
 * Room entity mirroring the iOS `PendingAction` struct. The `id` doubles as
 * the `clientRequestId` the backend's `ClientRequestLog` dedupes on, so
 * retries after partial network failures don't double-mutate the visit row.
 *
 * `payload` is stored as a JSON blob in a TEXT column — discriminator-tagged
 * via the `kind` column so the sync engine knows how to deserialise it.
 */
@Entity(tableName = "pending_action")
data class PendingActionEntity(
    @PrimaryKey val id: String = UUID.randomUUID().toString(),
    val kind: String,                // "visit_checkin" | "visit_checkout"
    val visitId: String,
    val payloadJson: String,
    @ColumnInfo(name = "selfie_filename") val selfieFilename: String? = null,
    val createdAt: Long,
    var retryCount: Int = 0,
    var lastError: String? = null,
    var lastAttemptAt: Long? = null,
    var nextEligibleAt: Long = 0L
)
