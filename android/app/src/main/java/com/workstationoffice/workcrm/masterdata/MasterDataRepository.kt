package com.workstationoffice.workcrm.masterdata

import com.workstationoffice.workcrm.models.CustomerPage
import com.workstationoffice.workcrm.models.Item
import com.workstationoffice.workcrm.models.Paginated
import com.workstationoffice.workcrm.networking.ApiClient

object MasterDataRepository {
    suspend fun customers(page: Int, pageSize: Int = 50, scope: String = "team"): CustomerPage =
        ApiClient.api.customers(page = page, pageSize = pageSize, scope = scope)

    suspend fun items(limit: Int = 50, offset: Int = 0): Paginated<Item> =
        ApiClient.api.items(limit = limit, offset = offset)
}
