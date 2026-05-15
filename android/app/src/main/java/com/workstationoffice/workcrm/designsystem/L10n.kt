package com.workstationoffice.workcrm.designsystem

import java.util.Locale

/**
 * Bilingual string lookup mirroring the iOS L10n.swift table. Keep additions
 * in sync across both platforms so the QA team only has one translation matrix.
 */
enum class L10n {
    LoginTitle, LoginTenantSlug, LoginEmail, LoginPassword, LoginCta, LoginError,
    TabToday, TabDeals, TabKpi, TabMore,
    VisitsTitle, VisitsEmpty, VisitCheckIn, VisitCheckOut, VisitPendingSync, VisitOffline,
    KpiPersonalTitle, KpiTeamTitle, KpiVisits, KpiWonDeals, KpiRevenue, KpiConversion, KpiDaysLeft,
    CommonRetry, CommonCancel, CommonOk, CommonLoading
}

private val dictionary: Map<L10n, Pair<String, String>> = mapOf(
    L10n.LoginTitle        to ("เข้าสู่ระบบ" to "Sign in"),
    L10n.LoginTenantSlug   to ("รหัสองค์กร" to "Workspace slug"),
    L10n.LoginEmail        to ("อีเมล" to "Email"),
    L10n.LoginPassword     to ("รหัสผ่าน" to "Password"),
    L10n.LoginCta          to ("เข้าสู่ระบบ" to "Sign in"),
    L10n.LoginError        to ("ลงชื่อเข้าใช้ล้มเหลว" to "Sign-in failed"),
    L10n.TabToday          to ("วันนี้" to "Today"),
    L10n.TabDeals          to ("ดีล" to "Deals"),
    L10n.TabKpi            to ("เป้า KPI" to "KPI"),
    L10n.TabMore           to ("เพิ่มเติม" to "More"),
    L10n.VisitsTitle       to ("รายการเยี่ยมวันนี้" to "Today's visits"),
    L10n.VisitsEmpty       to ("ไม่มีนัดในวันนี้" to "No visits scheduled"),
    L10n.VisitCheckIn      to ("เช็คอิน" to "Check in"),
    L10n.VisitCheckOut     to ("เช็คเอาท์" to "Check out"),
    L10n.VisitPendingSync  to ("รอซิงค์" to "Pending sync"),
    L10n.VisitOffline      to ("ออฟไลน์" to "Offline"),
    L10n.KpiPersonalTitle  to ("เป้าหมายของฉัน" to "My KPI"),
    L10n.KpiTeamTitle      to ("เป้าหมายทีม" to "Team KPI"),
    L10n.KpiVisits         to ("จำนวนเยี่ยม" to "Visits"),
    L10n.KpiWonDeals       to ("ดีลที่ปิดได้" to "Won deals"),
    L10n.KpiRevenue        to ("ยอดขาย" to "Revenue"),
    L10n.KpiConversion     to ("อัตราปิดดีล" to "Conversion"),
    L10n.KpiDaysLeft       to ("วันที่เหลือ" to "Days left"),
    L10n.CommonRetry       to ("ลองอีกครั้ง" to "Retry"),
    L10n.CommonCancel      to ("ยกเลิก" to "Cancel"),
    L10n.CommonOk          to ("ตกลง" to "OK"),
    L10n.CommonLoading     to ("กำลังโหลด…" to "Loading…")
)

fun t(key: L10n): String {
    val useThai = Locale.getDefault().language == "th"
    val pair = dictionary[key] ?: return ""
    return if (useThai) pair.first else pair.second
}
