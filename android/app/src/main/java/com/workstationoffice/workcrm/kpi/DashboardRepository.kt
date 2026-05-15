package com.workstationoffice.workcrm.kpi

import com.workstationoffice.workcrm.models.DashboardOverview
import com.workstationoffice.workcrm.networking.ApiClient
import java.time.Calendar
import java.time.YearMonth
import java.util.Date

object DashboardRepository {
    suspend fun overview(month: String? = null, repId: String? = null, teamId: String? = null): DashboardOverview =
        ApiClient.api.dashboardOverview(month = month, repId = repId, teamId = teamId)

    /** Mirrors iOS daysLeftInMonth — the kpi-alert cron's last-5-days rule. */
    fun daysLeftInMonth(now: Date = Date()): Int {
        val cal = java.util.Calendar.getInstance().apply { time = now }
        val lastDay = cal.getActualMaximum(java.util.Calendar.DAY_OF_MONTH)
        val today = cal.get(java.util.Calendar.DAY_OF_MONTH)
        return maxOf(0, lastDay - today + 1)
    }

    fun currentMonthKey(): String {
        val ym = YearMonth.now()
        return "%04d-%02d".format(ym.year, ym.monthValue)
    }
}
