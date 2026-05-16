package com.workstationoffice.workcrm.models

import kotlinx.serialization.Serializable

// Mirrors ios/WorkCRM/Models/Models.swift. Field names use camelCase to match
// the backend's response shape — no renaming required.

@Serializable
data class LoginRequest(
    val tenantSlug: String,
    val email: String,
    val password: String
)

@Serializable
data class LoginResponse(
    val accessToken: String,
    val refreshToken: String,
    val tokenType: String,
    val user: User
)

@Serializable
data class RefreshRequest(val refreshToken: String)

@Serializable
data class RefreshResponse(
    val accessToken: String,
    val refreshToken: String,
    val tokenType: String
)

@Serializable
data class DeviceRegistrationRequest(
    val platform: String,        // "IOS" | "ANDROID"
    val deviceToken: String,
    val deviceName: String? = null
)

// MARK: MS365 mobile OAuth (PKCE)

@Serializable
data class OAuthBeginRequest(
    val tenantSlug: String,
    val codeChallenge: String,    // base64url(SHA256(verifier))
    val redirectUri: String
)

@Serializable
data class OAuthBeginResponse(
    val authorizationUrl: String,
    val state: String
)

@Serializable
data class OAuthCompleteRequest(
    val tenantSlug: String,
    val code: String,
    val state: String,
    val codeVerifier: String,
    val redirectUri: String
)

@Serializable
data class User(
    val id: String,
    val tenantId: String,
    val tenantSlug: String,
    val role: String,
    val email: String,
    val fullName: String,
    val avatarUrl: String? = null
)

@Serializable
data class Paginated<T>(
    val rows: List<T>,
    val total: Int,
    val limit: Int,
    val offset: Int
)

@Serializable
data class CustomerPage(
    val rows: List<Customer>,
    val total: Int,
    val page: Int,
    val pageSize: Int,
    val totalPages: Int
)

// MARK: Visit

@Serializable
data class Visit(
    val id: String,
    val tenantId: String,
    val visitNo: String? = null,
    val status: String,                    // PLANNED | CHECKED_IN | CHECKED_OUT | CANCELLED
    val plannedAt: String? = null,         // ISO-8601 — parsed by repository
    val checkInAt: String? = null,
    val checkOutAt: String? = null,
    val objective: String? = null,
    val result: String? = null,
    val siteLat: Double? = null,
    val siteLng: Double? = null,
    val customer: VisitCustomerRef? = null,
    val deal: VisitDealRef? = null
)

@Serializable
data class VisitCustomerRef(val id: String, val name: String)

@Serializable
data class VisitDealRef(val id: String, val dealNo: String? = null, val dealName: String? = null)

@Serializable
data class CheckInRequest(
    val lat: Double,
    val lng: Double,
    val selfieUrl: String,                 // data:image/jpeg;base64,…
    val capturedAt: String? = null,
    val clientRequestId: String? = null    // uuid v4 from offline-sync queue
)

@Serializable
data class CheckOutRequest(
    val lat: Double,
    val lng: Double,
    val result: String,
    val capturedAt: String? = null,
    val clientRequestId: String? = null
)

@Serializable
data class VisitCheckInResponse(val visit: Visit, val notifWarnings: List<String>? = null)

@Serializable
data class VisitCheckOutResponse(val visit: Visit, val notifWarnings: List<String>? = null)

// MARK: Deals

@Serializable
data class Deal(
    val id: String,
    val dealNo: String,
    val dealName: String,
    val stageId: String,
    val status: String,
    val estimatedValue: Double,
    val followUpAt: String,                // ISO-8601
    val closedAt: String? = null,
    val customerId: String,
    val ownerId: String? = null,
    val lostNote: String? = null
)

@Serializable
data class DealStage(
    val id: String,
    val stageName: String,
    val stageOrder: Int,
    val isClosedWon: Boolean = false,
    val isClosedLost: Boolean = false,
    val isDefault: Boolean? = null
)

@Serializable
data class DealUpdateRequest(
    val estimatedValue: Double? = null,
    val followUpAt: String? = null,
    val closedAt: String? = null,
    val stageId: String? = null
)

@Serializable
data class DealProgressUpdateRequest(val note: String)

@Serializable
data class DealProgressUpdate(
    val id: String,
    val dealId: String,
    val note: String,
    val createdAt: String,
    val createdBy: ProgressAuthor? = null
) {
    @Serializable
    data class ProgressAuthor(val id: String, val fullName: String? = null)
}

// MARK: Master data

@Serializable
data class Customer(
    val id: String,
    val customerCode: String? = null,
    val name: String,
    val taxId: String? = null,
    val disabled: Boolean? = null
)

@Serializable
data class Item(
    val id: String,
    val itemCode: String,
    val name: String,
    val unitPrice: Double,
    val isActive: Boolean = true
)

// MARK: Dashboard / KPI

@Serializable
data class DashboardOverview(
    val period: Period,
    val kpis: KpiSummary,
    val targetVsActual: List<TargetVsActual>,
    val teamPerformance: List<TeamPerformanceRow>? = null
) {
    @Serializable
    data class Period(val month: String, val dateFrom: String, val dateTo: String)
}

@Serializable
data class KpiSummary(
    val activeDeals: Int,
    val pipelineValue: Double,
    val wonValue: Double,
    val lostValue: Double,
    val visitCompletionRate: Double,
    val dealsCreatedInPeriod: Int,
    val visitsPlannedInPeriod: Int,
    val usersInScope: Int
)

@Serializable
data class TargetVsActual(
    val userId: String,
    val userName: String,
    val avatarUrl: String? = null,
    val teamId: String? = null,
    val teamName: String,
    val month: String,
    val target: Triple,
    val actual: Triple,
    val progress: Triple
) {
    @Serializable
    data class Triple(val visits: Double, val newDealValue: Double, val revenue: Double)
}

// MARK: Mobile sync analytics

@Serializable
data class SyncDiscardEvent(
    val kind: String,                  // "visit_checkin" | "visit_checkout"
    val visitId: String,
    val retryCount: Int,
    val lastError: String? = null,
    val queuedDurationMs: Int,
    val platform: String               // "ANDROID"
)

@Serializable
data class SyncDiscardBatch(val events: List<SyncDiscardEvent>)

@Serializable
data class SyncDiscardPostResponse(val inserted: Int)

@Serializable
data class TeamPerformanceRow(
    val teamId: String,
    val teamName: String,
    val memberCount: Int,
    val activeDeals: Int,
    val pipelineValue: Double,
    val wonValue: Double,
    val lostValue: Double,
    val checkedOutVisits: Int,
    val plannedVisits: Int,
    val visitCompletionRate: Double
)
