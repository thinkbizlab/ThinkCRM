package com.workstationoffice.workcrm.app

import android.app.Application
import androidx.work.Configuration
import com.workstationoffice.workcrm.networking.TokenStore
import com.workstationoffice.workcrm.offline.OfflineDatabase
import com.workstationoffice.workcrm.offline.Reachability
import com.workstationoffice.workcrm.offline.SyncEngine

/**
 * Initialises the singletons mobile clients need before any Activity runs:
 *   - Keystore-backed TokenStore (Retrofit's auth interceptor calls into it
 *     on the very first request, so it must be ready before MainActivity).
 *   - Room database + sync engine.
 *   - NWPathMonitor-equivalent Reachability so an offline → online flip
 *     drains the queue without waiting for an Activity to mount.
 */
class WorkCRMApplication : Application(), Configuration.Provider {
    override fun onCreate() {
        super.onCreate()
        TokenStore.init(this)
        OfflineDatabase.init(this)
        SyncEngine.setContext(this)
        Reachability.init(this)
        // Drain any leftover queue rows from a previous launch.
        SyncEngine.scheduleNow(this)
    }

    override val workManagerConfiguration: Configuration
        get() = Configuration.Builder()
            .setMinimumLoggingLevel(android.util.Log.INFO)
            .build()
}
