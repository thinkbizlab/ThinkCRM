package com.workstationoffice.workcrm.networking

import com.workstationoffice.workcrm.models.*
import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.PATCH
import retrofit2.http.POST
import retrofit2.http.Path
import retrofit2.http.Query

/**
 * Retrofit interface mirroring the Fastify REST surface the iOS app uses.
 * Keep method names in sync with iOS Repositories so a feature reads the same
 * on both platforms.
 */
interface WorkCrmApi {

    // Auth

    @POST("auth/login")
    suspend fun login(@Body body: LoginRequest): LoginResponse

    @POST("auth/refresh")
    suspend fun refresh(@Body body: RefreshRequest): RefreshResponse

    @POST("auth/devices")
    suspend fun registerDevice(@Body body: DeviceRegistrationRequest): kotlinx.serialization.json.JsonElement

    @DELETE("auth/devices")
    suspend fun unregisterDevice(@Body body: DeviceRegistrationRequest)

    // Visits

    @GET("visits")
    suspend fun visits(
        @Query("status") status: String? = null,
        @Query("limit") limit: Int? = null,
        @Query("offset") offset: Int? = null
    ): Paginated<Visit>

    @GET("visits/{id}")
    suspend fun visit(@Path("id") id: String): Visit

    @POST("visits/{id}/checkin")
    suspend fun checkIn(@Path("id") id: String, @Body body: CheckInRequest): VisitCheckInResponse

    @POST("visits/{id}/checkout")
    suspend fun checkOut(@Path("id") id: String, @Body body: CheckOutRequest): VisitCheckOutResponse

    // Deals

    @GET("deals/stages")
    suspend fun dealStages(): List<DealStage>

    @GET("deals")
    suspend fun deals(
        @Query("limit") limit: Int? = null,
        @Query("offset") offset: Int? = null,
        @Query("customerId") customerId: String? = null
    ): Paginated<Deal>

    @GET("deals/{id}")
    suspend fun deal(@Path("id") id: String): Deal

    @PATCH("deals/{id}")
    suspend fun updateDeal(@Path("id") id: String, @Body body: DealUpdateRequest): Deal

    @GET("deals/{id}/progress-updates")
    suspend fun progressUpdates(@Path("id") id: String): List<DealProgressUpdate>

    @POST("deals/{id}/progress-updates")
    suspend fun postProgress(@Path("id") id: String, @Body body: DealProgressUpdateRequest): DealProgressUpdate

    // Master data

    @GET("customers")
    suspend fun customers(
        @Query("page") page: Int,
        @Query("pageSize") pageSize: Int,
        @Query("scope") scope: String = "mine"
    ): CustomerPage

    @GET("items")
    suspend fun items(
        @Query("limit") limit: Int,
        @Query("offset") offset: Int
    ): Paginated<Item>

    // Dashboard / KPI

    @GET("dashboard/overview")
    suspend fun dashboardOverview(
        @Query("month") month: String? = null,
        @Query("repId") repId: String? = null,
        @Query("teamId") teamId: String? = null
    ): DashboardOverview

    // Mobile sync analytics — best-effort POST when a rep discards a row
    // that exhausted retries. Backend caps the batch at 50 events.
    @POST("sync/discards")
    suspend fun postSyncDiscards(@Body body: SyncDiscardBatch): SyncDiscardPostResponse
}
