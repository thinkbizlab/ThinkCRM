package com.workstationoffice.workcrm.offline

import kotlinx.serialization.Serializable

/**
 * Payload variants persisted as `payloadJson` inside `PendingActionEntity`.
 * Discriminator-tagged via the entity's `kind` column so the sync engine
 * picks the right Serializer.
 */
@Serializable
data class CheckInPayload(
    val lat: Double,
    val lng: Double,
    val capturedAt: String,            // ISO-8601
    val selfieFilename: String
)

@Serializable
data class CheckOutPayload(
    val lat: Double,
    val lng: Double,
    val capturedAt: String,            // ISO-8601
    val result: String
)

object PendingActionKind {
    const val VISIT_CHECKIN  = "visit_checkin"
    const val VISIT_CHECKOUT = "visit_checkout"
}
