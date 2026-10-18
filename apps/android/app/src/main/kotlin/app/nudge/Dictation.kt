// Speech to text for the composer, on the phone: the audio never leaves it unless the player
// lets it, since redaction (ADR 2) only sees the text. Android 14 and later tell the languages
// apart by themselves; before that, the player picks one of theirs.
package app.nudge

import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.os.Build
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognitionSupport
import android.speech.RecognitionSupportCallback
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.core.os.ConfigurationCompat
import java.util.Locale
import kotlin.coroutines.resume
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.suspendCancellableCoroutine

class Dictation(private val context: Context, private val preferences: SharedPreferences) {
    sealed interface State {
        data object Idle : State
        /** Hearing [text] so far, in [language] once the recognizer said which. */
        data class Listening(val text: String, val language: String?, val level: Float) : State
        /** Done, having heard [text]. */
        data class Done(val text: String) : State
        data class Failed(val message: String) : State
    }

    /** Whether a language pack is on the phone, on its way, there to download, or missing. */
    enum class Pack { INSTALLED, DOWNLOADING, DOWNLOADABLE, MISSING, UNKNOWN }

    private val mutableState = MutableStateFlow<State>(State.Idle)
    val state: StateFlow<State> = mutableState.asStateFlow()

    private val mutableLanguages = MutableStateFlow(savedLanguages())
    /** The player's speech languages on this device, as BCP 47 tags, the first preferred. */
    val languages: StateFlow<List<String>> = mutableLanguages.asStateFlow()

    private val mutableLanguage = MutableStateFlow(preferences.getString(LANGUAGE, null) ?: mutableLanguages.value.first())
    /** The language to listen for where the phone can't tell them apart. */
    val language: StateFlow<String> = mutableLanguage.asStateFlow()

    private val mutableOnline = MutableStateFlow(preferences.getBoolean(ONLINE, false))
    /** Whether the player let the phone's speech service send audio off the phone. */
    val online: StateFlow<Boolean> = mutableOnline.asStateFlow()

    /** Whether this phone recognizes speech on the phone itself. */
    val onDevice: Boolean
        get() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && SpeechRecognizer.isOnDeviceRecognitionAvailable(context)

    /** Whether there's a recognizer at all, on the phone or through a service. */
    val available: Boolean get() = onDevice || SpeechRecognizer.isRecognitionAvailable(context)

    /**
     * Whether the recognizer tells the player's languages apart, so there's nothing to pick: on
     * Android 14 and later, when the phone has all of them.
     */
    val detectsLanguage: Boolean
        get() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE && onDevice && mutableLanguages.value.none(::missing)

    private val mutablePacks = MutableStateFlow<Map<String, Pack>>(emptyMap())
    /** The language packs [check] found, so a language the phone lacks isn't asked of it. */
    val packs: StateFlow<Map<String, Pack>> = mutablePacks.asStateFlow()

    /** Whether the on-device recognizer lacks [tag], as far as [check] found out. */
    private fun missing(tag: String) = mutablePacks.value[tag] == Pack.MISSING

    private var recognizer: SpeechRecognizer? = null
    /** What earlier stretches of this dictation heard; the recognizer starts again after a pause. */
    private var heard = ""
    private var wanted = false

    fun setLanguages(tags: List<String>) {
        val list = tags.distinct().ifEmpty { defaultLanguages() }
        mutableLanguages.value = list
        preferences.edit().putString(LANGUAGES, list.joinToString(",")).apply()
        if (mutableLanguage.value !in list) choose(list.first())
    }

    fun choose(tag: String) {
        mutableLanguage.value = tag
        preferences.edit().putString(LANGUAGE, tag).apply()
    }

    /** The next of the player's languages, for the chip that switches them. */
    fun nextLanguage() {
        val list = mutableLanguages.value
        choose(list[(list.indexOf(mutableLanguage.value) + 1) % list.size])
    }

    fun allowOnline(allowed: Boolean) {
        mutableOnline.value = allowed
        preferences.edit().putBoolean(ONLINE, allowed).apply()
    }

    /** Starts listening; [state] carries the words. Call on the main thread, with RECORD_AUDIO granted. */
    fun start() {
        if (recognizer != null) return
        heard = ""
        wanted = true
        listen()
    }

    /** Stops listening; [state] becomes [State.Done] once the last words are in. */
    fun stop() {
        wanted = false
        recognizer?.stopListening()
    }

    /** Stops at once and forgets what wasn't final yet. */
    fun cancel() {
        wanted = false
        release()
        mutableState.value = State.Idle
    }

    /** Whether the language to listen for has to go to the speech service: the phone lacks it. */
    val needsOnline: Boolean get() = !onDevice || missing(mutableLanguage.value)

    private fun listen() {
        val speech = when {
            !needsOnline -> SpeechRecognizer.createOnDeviceSpeechRecognizer(context)
            mutableOnline.value && SpeechRecognizer.isRecognitionAvailable(context) -> SpeechRecognizer.createSpeechRecognizer(context)
            onDevice -> {
                mutableState.value = State.Failed("This phone can't recognize ${displayName(mutableLanguage.value)} on its own.")
                return
            }
            else -> {
                mutableState.value = State.Failed("This phone can't recognize speech on its own.")
                return
            }
        }
        recognizer = speech
        speech.setRecognitionListener(Listener())
        speech.startListening(intent())
        mutableState.value = State.Listening(heard, null, 0f)
    }

    private fun release() {
        recognizer?.destroy()
        recognizer = null
    }

    private fun intent(language: String = mutableLanguage.value) = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
        putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
        putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
        putExtra(RecognizerIntent.EXTRA_LANGUAGE, language)
        // Only the languages the phone has: one it lacks would stop it hearing any.
        val allowed = ArrayList(mutableLanguages.value.filterNot(::missing))
        if (detectsLanguage && !missing(language) && allowed.size > 1) {
            putExtra(RecognizerIntent.EXTRA_ENABLE_LANGUAGE_DETECTION, true)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_DETECTION_ALLOWED_LANGUAGES, allowed)
            // Switching mid-dictation, for a Norwegian sentence after an English one.
            putExtra(RecognizerIntent.EXTRA_ENABLE_LANGUAGE_SWITCH, RecognizerIntent.LANGUAGE_SWITCH_BALANCED)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_SWITCH_ALLOWED_LANGUAGES, allowed)
        }
    }

    /** Looks up which of [tags] the on-device recognizer has, can fetch, or lacks, into [packs]. */
    suspend fun check(tags: List<String>) {
        mutablePacks.value = mutablePacks.value + packsFor(tags)
    }

    private suspend fun packsFor(tags: List<String>): Map<String, Pack> {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || !onDevice) return tags.associateWith { Pack.UNKNOWN }
        val support = suspendCancellableCoroutine<RecognitionSupport?> { continuation ->
            val speech = SpeechRecognizer.createOnDeviceSpeechRecognizer(context)
            speech.checkRecognitionSupport(intent(tags.firstOrNull() ?: "en-US"), context.mainExecutor, object : RecognitionSupportCallback {
                override fun onSupportResult(support: RecognitionSupport) {
                    speech.destroy()
                    continuation.resume(support)
                }

                override fun onError(error: Int) {
                    speech.destroy()
                    continuation.resume(null)
                }
            })
            continuation.invokeOnCancellation { speech.destroy() }
        } ?: return tags.associateWith { Pack.UNKNOWN }
        fun List<String>.has(tag: String) = any { it.equals(tag, ignoreCase = true) }
        return tags.associateWith { tag ->
            when {
                support.installedOnDeviceLanguages.has(tag) -> Pack.INSTALLED
                support.pendingOnDeviceLanguages.has(tag) -> Pack.DOWNLOADING
                support.supportedOnDeviceLanguages.has(tag) -> Pack.DOWNLOADABLE
                else -> Pack.MISSING
            }
        }
    }

    /** Asks the phone to fetch the language pack for [tag]; it may show its own prompt. */
    fun download(tag: String) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || !onDevice) return
        val speech = SpeechRecognizer.createOnDeviceSpeechRecognizer(context)
        speech.triggerModelDownload(intent(tag))
        speech.destroy()
    }

    private inner class Listener : RecognitionListener {
        private var language: String? = null

        override fun onReadyForSpeech(params: Bundle?) {}
        override fun onBeginningOfSpeech() {}
        override fun onBufferReceived(buffer: ByteArray?) {}
        override fun onEvent(eventType: Int, params: Bundle?) {}
        override fun onEndOfSpeech() {}

        override fun onRmsChanged(rmsdB: Float) {
            val listening = mutableState.value as? State.Listening ?: return
            // About -2 dB in silence to 10 dB when speaking up.
            mutableState.value = listening.copy(level = ((rmsdB + 2f) / 12f).coerceIn(0f, 1f))
        }

        override fun onLanguageDetection(results: Bundle) {
            language = results.getString(SpeechRecognizer.DETECTED_LANGUAGE) ?: language
            (mutableState.value as? State.Listening)?.let { mutableState.value = it.copy(language = language) }
        }

        override fun onPartialResults(partialResults: Bundle?) {
            val words = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull() ?: return
            mutableState.value = State.Listening(join(heard, words), language, (mutableState.value as? State.Listening)?.level ?: 0f)
        }

        override fun onResults(results: Bundle?) {
            val words = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()
            heard = join(heard, words)
            release()
            // The recognizer ends at a pause; the player stops it, so carry on until they do.
            if (wanted) listen() else finish()
        }

        override fun onError(error: Int) {
            release()
            when (error) {
                // Silence: the player stopped talking, so the dictation is done.
                SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> finish()
                // Stopped by the player before anything was final.
                SpeechRecognizer.ERROR_CLIENT -> finish()
                else -> {
                    wanted = false
                    mutableState.value = State.Failed(explain(error))
                }
            }
        }

        private fun finish() {
            wanted = false
            mutableState.value = State.Done(heard)
        }
    }

    private fun explain(error: Int): String = when (error) {
        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Nudge may not use the microphone. Allow it in the phone's settings."
        SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED -> "This phone can't recognize ${displayName(mutableLanguage.value)}."
        SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE -> "${displayName(mutableLanguage.value)} isn't on this phone yet. Download it in Settings, under Speech."
        SpeechRecognizer.ERROR_AUDIO -> "The microphone didn't work."
        SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "Speech recognition is busy. Try again in a moment."
        SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT, SpeechRecognizer.ERROR_SERVER, SpeechRecognizer.ERROR_SERVER_DISCONNECTED ->
            "The speech service couldn't be reached."
        else -> "Speech recognition stopped ($error)."
    }

    private fun savedLanguages(): List<String> =
        preferences.getString(LANGUAGES, null)?.split(",")?.filter { it.isNotBlank() }?.ifEmpty { null } ?: defaultLanguages()

    /** The phone's languages, and English, so a Norwegian phone listens for both. */
    private fun defaultLanguages(): List<String> {
        val locales = ConfigurationCompat.getLocales(context.resources.configuration)
        val phone = (0 until locales.size()).mapNotNull { locales[it] }.map(::speechTag)
        return (phone + "en-US").distinctBy { it.substringBefore('-') }
    }

    companion object {
        private const val LANGUAGES = "speech.languages"
        private const val LANGUAGE = "speech.language"
        private const val ONLINE = "speech.online"

        /** Languages to offer when adding one, beyond the phone's own. */
        val common = listOf(
            "nb-NO", "nn-NO", "en-US", "en-GB", "sv-SE", "da-DK", "de-DE", "fr-FR", "es-ES", "it-IT",
            "nl-NL", "pl-PL", "pt-BR", "fi-FI", "uk-UA", "ar-SA", "hi-IN", "ja-JP", "ko-KR", "cmn-Hans-CN",
        )

        /** A tag the recognizers know: Norwegian as Bokmål, and a region where there's none. */
        fun speechTag(locale: Locale): String {
            val language = when (locale.language) {
                "no" -> "nb"
                else -> locale.language
            }
            val region = locale.country.ifEmpty {
                when (language) {
                    "nb", "nn" -> "NO"
                    "en" -> "US"
                    "sv" -> "SE"
                    "da" -> "DK"
                    else -> language.uppercase()
                }
            }
            return "$language-$region"
        }

        fun displayName(tag: String): String =
            Locale.forLanguageTag(tag).let { it.getDisplayName(it).replaceFirstChar { c -> c.titlecase(it) } }

        /** The short label on the chip: "NB", "EN". */
        fun shortName(tag: String): String = tag.substringBefore('-').uppercase()

        /** [before] and [after] with one space between, where both have words. */
        fun join(before: String, after: String): String = when {
            before.isBlank() -> after.trim()
            after.isBlank() -> before.trimEnd()
            else -> before.trimEnd() + " " + after.trim()
        }
    }
}
