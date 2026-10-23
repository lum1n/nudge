// The player's profile at home: name, picture, time zone, language, which pushes they get, and
// each extension's settings for them. Their home sends it to every assistant they joined. Their
// personal details and where they are stay at home.
package app.nudge.ui

import android.Manifest
import android.os.Build
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Base64
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MediumFlexibleTopAppBar
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.collectAsState
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import app.nudge.AppModel
import app.nudge.Session
import app.nudge.explain
import java.io.ByteArrayOutputStream
import java.util.Locale
import java.util.TimeZone
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import nudge.client.settingFields
import nudge.client.withoutDefaults
import nudge.ffi.Notifications
import nudge.ffi.PersonalDetails
import nudge.ffi.PersonalUpdate
import nudge.ffi.Places
import nudge.ffi.PlayerSettings
import nudge.ffi.Profile
import nudge.ffi.ProfileUpdate

/** What the form holds until it is saved. */
private data class ProfileDraft(
    val displayName: String,
    val avatar: String?,
    val timeZone: String,
    val language: String,
    val notifications: Notifications,
    val extensions: Map<String, JsonObject>,
)

private fun draftOf(profile: Profile) = ProfileDraft(
    displayName = profile.displayName,
    avatar = profile.avatar,
    timeZone = profile.timeZone.orEmpty(),
    language = profile.language.orEmpty(),
    notifications = profile.notifications,
    extensions = runCatching { Json.parseToJsonElement(profile.extensionsJson).jsonObject }
        .getOrNull().orEmpty()
        .mapValues { (_, value) -> value as? JsonObject ?: JsonObject(emptyMap()) },
)

/** The personal details in the form until they are saved. */
private data class PersonalDraft(val fullName: String, val email: String, val phone: String, val address: String)

private fun personalDraftOf(details: PersonalDetails) = PersonalDraft(
    fullName = details.fullName.orEmpty(),
    email = details.email.orEmpty(),
    phone = details.phone.orEmpty(),
    address = details.address.orEmpty(),
)

@OptIn(ExperimentalMaterial3Api::class, ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun ProfileScreen(model: AppModel, session: Session, close: () -> Unit) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val client = session.client
    var draft by remember { mutableStateOf<ProfileDraft?>(null) }
    var personal by remember { mutableStateOf<PersonalDraft?>(null) }
    val sharing by model.location.enabled.collectAsState()
    val known by model.location.known.collectAsState()
    val locationProblem by model.location.problem.collectAsState()
    val askLocation = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
        if (granted.values.any { it }) scope.launch { model.location.setEnabled(true) }
    }
    val arriving by model.geofences.enabled.collectAsState()
    val watching by model.geofences.watching.collectAsState()
    val arrivingProblem by model.geofences.problem.collectAsState()
    // Android 11 and later ask for "all the time" on its own, after "while using the app".
    val askBackground = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) scope.launch { model.geofences.setEnabled(true) }
    }
    val askForeground = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
        if (granted[Manifest.permission.ACCESS_FINE_LOCATION] == true) {
            if (Build.VERSION.SDK_INT >= 29) askBackground.launch(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
            else scope.launch { model.geofences.setEnabled(true) }
        }
    }
    var extensions by remember { mutableStateOf<List<PlayerSettings>>(emptyList()) }
    // Null without the places extension.
    var places by remember { mutableStateOf<Places?>(null) }
    var busy by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }
    var saved by remember { mutableStateOf(false) }
    val scrollBehavior = TopAppBarDefaults.exitUntilCollapsedScrollBehavior()

    LaunchedEffect(client) {
        try {
            draft = draftOf(client.profile())
            personal = runCatching { personalDraftOf(client.personal()) }.getOrNull()
            model.location.refresh()
            extensions = runCatching { client.profileExtensions() }.getOrDefault(emptyList())
            places = runCatching { client.places() }.getOrNull()
        } catch (error: Exception) {
            problem = explain(error)
        }
    }

    fun change(next: ProfileDraft) {
        saved = false
        draft = next
    }

    fun changePersonal(next: PersonalDraft) {
        saved = false
        personal = next
    }

    val pick = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        val current = draft ?: return@rememberLauncherForActivityResult
        uri ?: return@rememberLauncherForActivityResult
        scope.launch {
            val avatar = withContext(Dispatchers.Default) { runCatching { avatarOf(context, uri) }.getOrNull() }
            if (avatar == null) problem = "That picture could not be read." else change(current.copy(avatar = avatar))
        }
    }

    Scaffold(
        containerColor = groupedBackground(),
        modifier = Modifier.nestedScroll(scrollBehavior.nestedScrollConnection),
        topBar = {
            MediumFlexibleTopAppBar(
                colors = groupedTopBarColors(),
                title = { Text("Profile") },
                navigationIcon = { IconButton(onClick = close) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
                scrollBehavior = scrollBehavior,
            )
        },
    ) { padding ->
        val form = draft
        if (form == null) {
            Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                problem?.let { Text(it, color = MaterialTheme.colorScheme.error) } ?: LoadingIndicator()
            }
            return@Scaffold
        }
        LazyColumn(
            Modifier.imePadding(),
            contentPadding = PaddingValues(
                start = 16.dp,
                end = 16.dp,
                top = padding.calculateTopPadding(),
                bottom = padding.calculateBottomPadding() + 24.dp,
            ),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item {
                Text(
                    "The assistant reads your nudges' times in your time zone and answers you in your language. " +
                        "Assistants you joined get this too.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            item {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Avatar(form.avatar)
                    TextButton(onClick = { pick.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }) {
                        Text("Choose a picture")
                    }
                    if (form.avatar != null) {
                        TextButton(onClick = { change(form.copy(avatar = null)) }) { Text("Remove") }
                    }
                }
            }
            item {
                OutlinedTextField(
                    value = form.displayName,
                    onValueChange = { change(form.copy(displayName = it)) },
                    label = { Text("Name") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            item {
                val phone = TimeZone.getDefault().id
                OutlinedTextField(
                    value = form.timeZone,
                    onValueChange = { change(form.copy(timeZone = it)) },
                    label = { Text("Time zone") },
                    placeholder = { Text("The assistant's") },
                    supportingText = { Text("Such as Europe/Oslo") },
                    trailingIcon = if (form.timeZone != phone) ({ TextButton(onClick = { change(form.copy(timeZone = phone)) }) { Text("This phone's") } }) else null,
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            item {
                val phone = Locale.getDefault().language
                OutlinedTextField(
                    value = form.language,
                    onValueChange = { change(form.copy(language = it)) },
                    label = { Text("Language") },
                    supportingText = { Text("Such as en, nb or de") },
                    trailingIcon = if (form.language != phone) ({ TextButton(onClick = { change(form.copy(language = phone)) }) { Text("This phone's") } }) else null,
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            personal?.let { details ->
                item {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("Personal details", style = MaterialTheme.typography.titleSmall)
                        Text(
                            "For filling in forms, writing mail and finding what is near you. Only you see them, and " +
                                "they stay at home: the model gets placeholders such as ⟦EMAIL1⟧, in your own room and " +
                                "private messages, and tools get the real values. Your location is sent while the app is open.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        OutlinedTextField(
                            value = details.fullName,
                            onValueChange = { changePersonal(details.copy(fullName = it)) },
                            label = { Text("Full name") },
                            singleLine = true,
                            modifier = Modifier.fillMaxWidth(),
                        )
                        OutlinedTextField(
                            value = details.email,
                            onValueChange = { changePersonal(details.copy(email = it)) },
                            label = { Text("E-mail") },
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
                            singleLine = true,
                            modifier = Modifier.fillMaxWidth(),
                        )
                        OutlinedTextField(
                            value = details.phone,
                            onValueChange = { changePersonal(details.copy(phone = it)) },
                            label = { Text("Phone") },
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
                            singleLine = true,
                            modifier = Modifier.fillMaxWidth(),
                        )
                        OutlinedTextField(
                            value = details.address,
                            onValueChange = { changePersonal(details.copy(address = it)) },
                            label = { Text("Address") },
                            modifier = Modifier.fillMaxWidth(),
                        )
                        SwitchRow("Share where I am", sharing) { on ->
                            if (on) {
                                askLocation.launch(
                                    arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION),
                                )
                            } else {
                                scope.launch { model.location.setEnabled(false) }
                            }
                        }
                        SwitchRow("Reminders when I arrive", arriving) { on ->
                            if (on) {
                                askForeground.launch(
                                    arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION),
                                )
                            } else {
                                scope.launch { model.geofences.setEnabled(false) }
                            }
                        }
                        Text(
                            arrivingProblem?.takeIf { arriving }
                                ?: if (arriving) "Watching $watching places for your reminders. Allow location all the time for it to work with the app closed."
                                else "For \"remind me when I get home\": the phone tells home when you get to a place you have a reminder for.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        known?.takeIf { sharing }?.let { location ->
                            val at = java.text.DateFormat.getTimeInstance(java.text.DateFormat.SHORT)
                                .format(java.util.Date(location.at.toLong()))
                            Text(
                                "${location.text}, $at",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        locationProblem?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
                    }
                }
            }
            places?.let { mine ->
                item(key = "places") {
                    fun act(action: suspend () -> Unit) = scope.launch {
                        try {
                            action()
                            places = client.places()
                        } catch (error: Exception) {
                            problem = explain(error)
                        }
                    }
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text("Places", style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(vertical = 4.dp))
                        Text(
                            "Ask the assistant to save a place or remind you when you get somewhere. The model only sees places as placeholders such as ⟦PLACE:home⟧.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        mine.places.forEach { place ->
                            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                                Column(Modifier.weight(1f)) {
                                    Text(place.name)
                                    Text(place.address, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                                TextButton(onClick = { act { client.forgetPlace(place.name) } }) { Text("Forget") }
                            }
                        }
                        mine.reminders.forEach { reminder ->
                            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                                Text(
                                    (if (reminder.arrive) "Getting to " else "Leaving ") +
                                        (reminder.place ?: "any ${reminder.kind}") +
                                        (if (reminder.always) ", every time" else "") + ": ${reminder.message}",
                                    Modifier.weight(1f),
                                )
                                TextButton(onClick = { act { client.cancelArrivalReminder(reminder.id) } }) { Text("Cancel") }
                            }
                        }
                    }
                }
            }
            item {
                Column {
                    Text("Notifications", style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(vertical = 4.dp))
                    SwitchRow("Answers and nudges", form.notifications.answers) {
                        change(form.copy(notifications = form.notifications.copy(answers = it)))
                    }
                    SwitchRow("Actions waiting for approval", form.notifications.approvals) {
                        change(form.copy(notifications = form.notifications.copy(approvals = it)))
                    }
                }
            }
            extensions.forEach { extension ->
                item(key = "extension:${extension.name}") {
                    val fields = remember(extension.schemaJson) { settingFields(extension.schemaJson) }
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(extension.name, style = MaterialTheme.typography.titleSmall)
                        extension.description?.let {
                            Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        SettingFields(fields, form.extensions[extension.name] ?: JsonObject(emptyMap())) { next ->
                            change(form.copy(extensions = form.extensions + (extension.name to next)))
                        }
                    }
                }
            }
            problem?.let { message -> item { Text(message, color = MaterialTheme.colorScheme.error) } }
            item {
                Button(
                    enabled = !busy && form.displayName.isNotBlank(),
                    shapes = ButtonDefaults.shapes(),
                    onClick = {
                        busy = true
                        problem = null
                        scope.launch {
                            try {
                                // Each extension's settings in full, or `null` when all are defaults.
                                val chosen: Map<String, JsonElement> = extensions.associate { extension ->
                                    val value = (form.extensions[extension.name] ?: JsonObject(emptyMap()))
                                        .withoutDefaults(settingFields(extension.schemaJson))
                                    extension.name to (if (value.isEmpty()) JsonNull else value)
                                }
                                val next = client.updateProfile(
                                    ProfileUpdate(
                                        displayName = form.displayName.trim(),
                                        // An empty string clears it.
                                        avatar = form.avatar ?: "",
                                        timeZone = form.timeZone.trim(),
                                        language = form.language.trim(),
                                        notifications = form.notifications,
                                        extensionsJson = if (chosen.isEmpty()) null else JsonObject(chosen).toString(),
                                    ),
                                )
                                draft = draftOf(next)
                                personal?.let { details ->
                                    // An empty string clears one.
                                    personal = personalDraftOf(
                                        client.updatePersonal(
                                            PersonalUpdate(
                                                fullName = details.fullName.trim(),
                                                email = details.email.trim(),
                                                phone = details.phone.trim(),
                                                address = details.address.trim(),
                                            ),
                                        ),
                                    )
                                }
                                session.me.value = session.me.value?.let { me ->
                                    me.copy(player = me.player.copy(displayName = next.displayName))
                                }
                                saved = true
                            } catch (error: Exception) {
                                problem = explain(error)
                            } finally {
                                busy = false
                            }
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                ) { Text(if (saved) "Saved" else "Save") }
            }
        }
    }
}

@Composable
private fun SwitchRow(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, Modifier.weight(1f))
        Switch(checked = checked, onCheckedChange = onChange)
    }
}

@Composable
private fun Avatar(avatar: String?) {
    val image = remember(avatar) {
        avatar?.substringAfter("base64,", "")?.takeIf { it.isNotEmpty() }?.let { data ->
            runCatching {
                val bytes = Base64.decode(data, Base64.DEFAULT)
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
            }.getOrNull()
        }
    }
    val modifier = Modifier.size(64.dp).clip(CircleShape)
    if (image == null) {
        Box(modifier.background(MaterialTheme.colorScheme.surfaceVariant))
    } else {
        Image(image, contentDescription = "Your picture", modifier = modifier, contentScale = ContentScale.Crop)
    }
}

/** Avatars are kept small: a 128 px square, as a data URL. */
private fun avatarOf(context: android.content.Context, uri: Uri): String {
    val resolver = context.contentResolver
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    resolver.openInputStream(uri).use { BitmapFactory.decodeStream(it, null, bounds) }
    // Decoded at no more than about twice the size it ends at.
    var sample = 1
    while (minOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= 256) sample *= 2
    val bitmap = resolver.openInputStream(uri).use {
        BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample })
    } ?: error("Not an image")
    val side = minOf(bitmap.width, bitmap.height)
    val square = Bitmap.createBitmap(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side)
    val small = Bitmap.createScaledBitmap(square, 128, 128, true)
    val bytes = ByteArrayOutputStream().use { out ->
        // WEBP_LOSSY is from API 30; WEBP is the same, lossy at under 100.
        @Suppress("DEPRECATION")
        small.compress(Bitmap.CompressFormat.WEBP, 85, out)
        out.toByteArray()
    }
    return "data:image/webp;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)
}
