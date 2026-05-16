package com.workstationoffice.workcrm.location

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import androidx.core.content.ContextCompat
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.android.gms.tasks.CancellationTokenSource
import kotlinx.coroutines.tasks.await

/**
 * Single-fix wrapper around `FusedLocationProviderClient`. Throws
 * `LocationPermissionDenied` if the user hasn't granted location at the
 * time of the call — the check-in screen surfaces that as an actionable
 * "open Settings" prompt.
 */
class LocationPermissionDenied : Exception("Location permission denied")

object LocationService {
    suspend fun currentLocation(context: Context): Location {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            throw LocationPermissionDenied()
        }
        return fetch(context)
    }

    @SuppressLint("MissingPermission") // checked above
    private suspend fun fetch(context: Context): Location {
        val client = LocationServices.getFusedLocationProviderClient(context)
        val cts = CancellationTokenSource()
        val location = client.getCurrentLocation(Priority.PRIORITY_HIGH_ACCURACY, cts.token).await()
            ?: error("No location available — outdoor signal required for check-in.")
        return location
    }
}
