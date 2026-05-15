package com.workstationoffice.workcrm.offline

import android.content.Context
import android.util.Base64
import java.io.File

/**
 * Manages selfie JPEG files captured during offline check-ins. Files live at
 * `filesDir/offline-selfies/<actionId>.jpg`. Stateless — the filesystem is the
 * source of truth. Mirrors iOS SelfieStore.
 */
object SelfieStore {
    private const val DIR = "offline-selfies"

    fun save(context: Context, actionId: String, jpegData: ByteArray): String {
        val dir = File(context.filesDir, DIR).apply { mkdirs() }
        val file = File(dir, "$actionId.jpg")
        file.writeBytes(jpegData)
        return file.name
    }

    fun load(context: Context, filename: String): ByteArray {
        return File(context.filesDir, "$DIR/$filename").readBytes()
    }

    fun delete(context: Context, filename: String) {
        File(context.filesDir, "$DIR/$filename").delete()
    }

    /** Encode a JPEG buffer as `data:image/jpeg;base64,…` for the checkin endpoint. */
    fun toDataUri(jpegData: ByteArray): String {
        val base64 = Base64.encodeToString(jpegData, Base64.NO_WRAP)
        return "data:image/jpeg;base64,$base64"
    }
}
