// Reminders when the player gets somewhere (ADR 18). Home says which places to watch, and the
// phone's own geofences wake the app when the player gets to one or leaves it, also with the app
// closed; the app then tells home, which says the reminder in its room. Where the places are stays
// between home and the phone.
package app.nudge

import android.Manifest
import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.location.Location
import android.os.Build
import com.google.android.gms.location.Geofence
import com.google.android.gms.location.GeofencingEvent
import com.google.android.gms.location.GeofencingRequest
import com.google.android.gms.location.LocationServices
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.tasks.await
import nudge.ffi.NudgeClient

class Geofences(
    private val context: Context,
    private val preferences: SharedPreferences,
    private val scope: CoroutineScope,
) {
    private val mutableEnabled = MutableStateFlow(preferences.getBoolean(ENABLED, false))
    /** Whether the player turned on reminders when they arrive, on this phone. */
    val enabled: StateFlow<Boolean> = mutableEnabled.asStateFlow()

    private val mutableProblem = MutableStateFlow<String?>(null)
    /** Why the phone can't watch the places, if it can't. */
    val problem: StateFlow<String?> = mutableProblem.asStateFlow()

    private val mutableWatching = MutableStateFlow(0)
    /** How many places the phone watches now. */
    val watching: StateFlow<Int> = mutableWatching.asStateFlow()

    private val geofencing = LocationServices.getGeofencingClient(context)
    private val fused = LocationServices.getFusedLocationProviderClient(context)
    private val syncing = Mutex()
    private var client: NudgeClient? = null

    private val intent: PendingIntent by lazy {
        PendingIntent.getBroadcast(
            context,
            0,
            Intent(context, GeofenceReceiver::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
        )
    }

    /** Home's client; null while signed out. Only home hears where the player got to. */
    fun setClient(client: NudgeClient?) {
        if (client === this.client) return
        this.client = client
        scope.launch { sync() }
    }

    /** Turns it on or off; ask for the location permissions, background too, before turning it on. */
    suspend fun setEnabled(on: Boolean) {
        mutableEnabled.value = on
        preferences.edit().putBoolean(ENABLED, on).apply()
        mutableProblem.value = null
        sync()
    }

    /** Whether the phone lets Nudge use its location with the app closed. */
    fun permitted(): Boolean =
        context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED &&
            (Build.VERSION.SDK_INT < 29 ||
                context.checkSelfPermission(Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED)

    /**
     * Asks home which places to watch, from where the phone is (or `at`), and watches those
     * instead of the ones before. Called when the app opens and closes, after a reboot, and when
     * the player leaves the circle home's places of a kind were found in.
     */
    @SuppressLint("MissingPermission") // Checked in permitted().
    suspend fun sync(at: Location? = null) = syncing.withLock {
        val client = client
        if (client == null || !mutableEnabled.value) {
            runCatching { geofencing.removeGeofences(intent).await() }
            mutableWatching.value = 0
            return@withLock
        }
        if (!permitted()) {
            mutableProblem.value = "Nudge may not use this phone's location all the time. Allow it in the system's settings."
            return@withLock
        }
        try {
            val here = at ?: runCatching { fused.lastLocation.await() }.getOrNull()
            val answer = client.arrivalRegions(here?.latitude, here?.longitude)
            val fences = answer.regions.map { region ->
                Geofence.Builder()
                    .setRequestId(region.id)
                    .setCircularRegion(region.latitude, region.longitude, region.radius.toFloat())
                    .setExpirationDuration(Geofence.NEVER_EXPIRE)
                    .setTransitionTypes(Geofence.GEOFENCE_TRANSITION_ENTER or Geofence.GEOFENCE_TRANSITION_EXIT)
                    .build()
            } + listOfNotNull(
                answer.refresh?.let { circle ->
                    Geofence.Builder()
                        .setRequestId(REFRESH)
                        .setCircularRegion(circle.latitude, circle.longitude, circle.radius.toFloat())
                        .setExpirationDuration(Geofence.NEVER_EXPIRE)
                        .setTransitionTypes(Geofence.GEOFENCE_TRANSITION_EXIT)
                        .build()
                },
            )
            runCatching { geofencing.removeGeofences(intent).await() }
            if (fences.isNotEmpty()) {
                geofencing.addGeofences(
                    GeofencingRequest.Builder()
                        // Only crossings from now on: being somewhere already isn't arriving.
                        .setInitialTrigger(0)
                        .addGeofences(fences)
                        .build(),
                    intent,
                ).await()
            }
            mutableWatching.value = answer.regions.size
            mutableProblem.value = null
        } catch (error: Exception) {
            // An assistant without the places extension answers 404: nothing to watch.
            mutableWatching.value = 0
            mutableProblem.value = explain(error)
        }
    }

    /** The phone crossed geofences: tells home, or asks again for places of a kind. */
    suspend fun crossed(event: GeofencingEvent) {
        if (event.hasError()) return
        val entered = event.geofenceTransition == Geofence.GEOFENCE_TRANSITION_ENTER
        val client = client ?: return
        for (fence in event.triggeringGeofences.orEmpty()) {
            if (fence.requestId == REFRESH) {
                sync(event.triggeringLocation)
                continue
            }
            runCatching { client.reportRegionEvent(fence.requestId, entered) }
        }
    }

    private companion object {
        const val ENABLED = "location.arrive"
        const val REFRESH = "refresh"
    }
}

/** Where the phone's geofences and reboots reach the app, also when it isn't running. */
class GeofenceReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val model = (context.applicationContext as NudgeApplication).model
        val pending = goAsync()
        model.scope.launch {
            try {
                when (intent.action) {
                    Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED -> model.geofences.sync()
                    else -> GeofencingEvent.fromIntent(intent)?.let { model.geofences.crossed(it) }
                }
            } finally {
                pending.finish()
            }
        }
    }
}
