package com.workstationoffice.workcrm

import com.workstationoffice.workcrm.offline.SyncEngine
import org.junit.Assert.assertEquals
import org.junit.Test

class SyncBackoffTest {
    @Test fun firstRetryIs30s()   = assertEquals(30_000L,    SyncEngine.backoffMillis(1))
    @Test fun secondRetryIs2m()   = assertEquals(120_000L,   SyncEngine.backoffMillis(2))
    @Test fun fifthRetryIs1h()    = assertEquals(3_600_000L, SyncEngine.backoffMillis(5))
    @Test fun cappedAtOneHour()   = assertEquals(3_600_000L, SyncEngine.backoffMillis(50))
    @Test fun zeroOrLessIsFirstBucket() {
        assertEquals(30_000L, SyncEngine.backoffMillis(0))
        assertEquals(30_000L, SyncEngine.backoffMillis(-5))
    }
}
