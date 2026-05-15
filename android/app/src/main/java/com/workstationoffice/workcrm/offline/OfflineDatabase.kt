package com.workstationoffice.workcrm.offline

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Insert
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.Update
import kotlinx.coroutines.flow.Flow

@Dao
interface PendingActionDao {
    @Query("SELECT * FROM pending_action ORDER BY createdAt ASC")
    fun observeAll(): Flow<List<PendingActionEntity>>

    @Query("SELECT * FROM pending_action ORDER BY createdAt ASC")
    suspend fun listAll(): List<PendingActionEntity>

    @Query("SELECT COUNT(*) FROM pending_action")
    fun observeCount(): Flow<Int>

    @Query("SELECT * FROM pending_action WHERE visitId = :visitId")
    suspend fun forVisit(visitId: String): List<PendingActionEntity>

    @Query("SELECT * FROM pending_action WHERE nextEligibleAt <= :now ORDER BY createdAt ASC LIMIT 1")
    suspend fun nextEligible(now: Long): PendingActionEntity?

    @Insert
    suspend fun insert(action: PendingActionEntity)

    @Update
    suspend fun update(action: PendingActionEntity)

    @Query("DELETE FROM pending_action WHERE id = :id")
    suspend fun delete(id: String)
}

@Database(entities = [PendingActionEntity::class], version = 1, exportSchema = false)
abstract class OfflineDatabase : RoomDatabase() {
    abstract fun pendingActionDao(): PendingActionDao

    companion object {
        @Volatile private var instance: OfflineDatabase? = null

        fun init(context: Context) {
            if (instance != null) return
            synchronized(this) {
                if (instance == null) {
                    instance = Room.databaseBuilder(
                        context.applicationContext,
                        OfflineDatabase::class.java,
                        "workcrm-offline.db"
                    ).build()
                }
            }
        }

        fun get(): OfflineDatabase = requireNotNull(instance) {
            "OfflineDatabase.init() must be called from WorkCRMApplication.onCreate()"
        }
    }
}
