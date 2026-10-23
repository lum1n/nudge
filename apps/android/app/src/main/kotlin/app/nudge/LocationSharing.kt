// Tells home where the player is, while the app is on screen and they turned it on in their
// profile. Home keeps it as a private value: the model only ever sees a placeholder for it, and
// only in the player's own room and private messages. The place's name comes from the phone's
// geocoder; nothing goes to any other server.
package app.nudge

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.location.Address
import android.location.Geocoder
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Looper
import kotlin.coroutines.resume
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import nudge.ffi.KnownLocation
import nudge.ffi.NudgeClient

class LocationSharing(
    private val context: Context,
    private val preferences: SharedPreferences,
    private val scope: CoroutineScope,
) {
    private val mutableEnabled = MutableStateFlow(preferences.getBoolean(ENABLED, false))
    /** Whether the player chose to share where they are, on this phone. */
    val enabled: StateFlow<Boolean> = mutableEnabled.asStateFlow()

    private val mutableKnown = MutableStateFlow<KnownLocation?>(null)
    /** What home last said it knows. */
    val known: StateFlow<KnownLocation?> = mutableKnown.asStateFlow()

    private val mutableProblem = MutableStateFlow<String?>(null)
    /** Why the last update failed, or why the phone won't tell. */
    val problem: StateFlow<String?> = mutableProblem.asStateFlow()

    private val manager = context.getSystemService(LocationManager::class.java)
    private val listener = LocationListener { location -> scope.launch { share(location) } }
    private var client: NudgeClient? = null
    private var foreground = false
    private var updating = false

    /** Home's client; null while signed out. Only home learns where the player is. */
    fun setClient(client: NudgeClient?) {
        if (client === this.client) return
        this.client = client
        mutableKnown.value = null
        resume()
    }

    /** Updates only while the app is on screen. */
    fun setForeground(foreground: Boolean) {
        this.foreground = foreground
        resume()
    }

    /**
     * Turns sharing on or off; ask for the location permission before turning it on. Off also has
     * home forget where the player was.
     */
    suspend fun setEnabled(on: Boolean) {
        mutableEnabled.value = on
        preferences.edit().putBoolean(ENABLED, on).apply()
        mutableProblem.value = null
        resume()
        if (on) return
        val client = client ?: return
        try {
            mutableKnown.value = client.forgetLocation().location
        } catch (error: Exception) {
            mutableProblem.value = explain(error)
        }
    }

    /** What home knows now, for the profile. */
    suspend fun refresh() {
        val client = client ?: return
        mutableKnown.value = runCatching { client.personal().location }.getOrNull()
    }

    private fun permitted(): Boolean =
        listOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION).any {
            context.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED
        }

    @SuppressLint("MissingPermission") // Checked in permitted().
    private fun resume() {
        val wanted = mutableEnabled.value && foreground && client != null
        if (!wanted || manager == null) {
            if (updating) manager?.removeUpdates(listener)
            updating = false
            return
        }
        if (!permitted()) {
            mutableProblem.value = "Nudge may not use this phone's location. Allow it in the system's settings."
            return
        }
        if (updating) return
        val provider = listOf(
            if (Build.VERSION.SDK_INT >= 31) LocationManager.FUSED_PROVIDER else null,
            LocationManager.NETWORK_PROVIDER,
            LocationManager.GPS_PROVIDER,
        ).firstOrNull { it != null && manager.isProviderEnabled(it) }
        if (provider == null) {
            mutableProblem.value = "Location is off on this phone."
            return
        }
        // A street's worth is enough to say what is near, and kind to the battery.
        manager.requestLocationUpdates(provider, 60_000L, 200f, listener, Looper.getMainLooper())
        updating = true
        manager.getLastKnownLocation(provider)?.let { last -> scope.launch { share(last) } }
    }

    private suspend fun share(location: Location) {
        val client = client ?: return
        if (!mutableEnabled.value) return
        val place = runCatching { placeOf(location) }.getOrNull()
        try {
            mutableKnown.value = client.shareLocation(location.latitude, location.longitude, place).location
            mutableProblem.value = null
        } catch (error: Exception) {
            mutableProblem.value = explain(error)
        }
    }

    /** Such as "Storgata 5, Oslo, NO": the street address, or the place's name, and the town. */
    private suspend fun placeOf(location: Location): String? {
        if (!Geocoder.isPresent()) return null
        val geocoder = Geocoder(context)
        val address: Address? = if (Build.VERSION.SDK_INT >= 33) {
            suspendCancellableCoroutine { done ->
                geocoder.getFromLocation(location.latitude, location.longitude, 1, object : Geocoder.GeocodeListener {
                    override fun onGeocode(addresses: MutableList<Address>) = done.resume(addresses.firstOrNull())
                    override fun onError(errorMessage: String?) = done.resume(null)
                })
            }
        } else {
            withContext(Dispatchers.IO) {
                @Suppress("DEPRECATION")
                geocoder.getFromLocation(location.latitude, location.longitude, 1)?.firstOrNull()
            }
        }
        address ?: return null
        val street = listOfNotNull(address.thoroughfare, address.subThoroughfare).joinToString(" ")
        return listOfNotNull(
            street.ifEmpty { address.featureName },
            address.locality ?: address.adminArea,
            address.countryCode,
        ).filter { it.isNotBlank() }.joinToString(", ").ifEmpty { null }
    }

    private companion object {
        const val ENABLED = "location.share"
    }
}
