package com.workstationoffice.workcrm.visits

import com.workstationoffice.workcrm.models.Paginated
import com.workstationoffice.workcrm.models.Visit
import com.workstationoffice.workcrm.networking.ApiClient

object VisitsRepository {
    suspend fun list(status: String? = null, limit: Int = 50, offset: Int = 0): Paginated<Visit> =
        ApiClient.api.visits(status = status, limit = limit, offset = offset)

    suspend fun detail(id: String): Visit = ApiClient.api.visit(id)
}
