package com.workstationoffice.workcrm.deals

import com.workstationoffice.workcrm.models.*
import com.workstationoffice.workcrm.networking.ApiClient

object DealsRepository {
    suspend fun stages(): List<DealStage> = ApiClient.api.dealStages()

    suspend fun deals(limit: Int = 200, offset: Int = 0): Paginated<Deal> =
        ApiClient.api.deals(limit = limit, offset = offset)

    suspend fun detail(id: String): Deal = ApiClient.api.deal(id)

    suspend fun update(id: String, patch: DealUpdateRequest): Deal =
        ApiClient.api.updateDeal(id, patch)

    suspend fun progressUpdates(dealId: String): List<DealProgressUpdate> =
        ApiClient.api.progressUpdates(dealId)

    suspend fun postProgress(dealId: String, note: String): DealProgressUpdate =
        ApiClient.api.postProgress(dealId, DealProgressUpdateRequest(note))
}
