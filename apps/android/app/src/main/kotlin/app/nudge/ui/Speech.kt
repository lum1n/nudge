// Dictating into the composer, and the player's speech languages in Settings.
package app.nudge.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Download
import androidx.compose.material.icons.outlined.KeyboardArrowUp
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material.icons.outlined.RecordVoiceOver
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MediumFlexibleTopAppBar
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedListItem
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.scale
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.nudge.Dictation
import app.nudge.Dictation.Pack
import app.nudge.R
import app.nudge.text
import kotlinx.coroutines.delay

/**
 * The mic in the composer, and the chip that picks the language where the phone can't tell.
 * What it hears goes after [draft] as it's heard, through [onDraft]; it never sends.
 */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun DictationButton(
    dictation: Dictation,
    key: Any,
    draft: String,
    onDraft: (String) -> Unit,
    /** Whether this composer is dictating, so the room can stop it when the player types or sends. */
    dictating: Boolean,
    onDictating: (Boolean) -> Unit,
    problem: (String) -> Unit,
) {
    val context = LocalContext.current
    val state by dictation.state.collectAsStateWithLifecycle()
    val languages by dictation.languages.collectAsStateWithLifecycle()
    val language by dictation.language.collectAsStateWithLifecycle()
    // Read so the chip shows once it's known that the phone lacks one of the languages.
    val packs by dictation.packs.collectAsStateWithLifecycle()
    LaunchedEffect(languages) { dictation.check(languages) }
    // The draft when dictation started: the words go after it.
    var before by remember(key) { mutableStateOf("") }
    var askOnline by remember { mutableStateOf(false) }

    fun begin() {
        before = draft
        onDictating(true)
        dictation.start()
    }

    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) begin() else problem(text(R.string.room_speech_mic_needed))
    }

    fun tap() {
        when {
            dictating -> dictation.stop()
            !dictation.available -> problem(text(R.string.room_speech_unavailable))
            dictation.needsOnline && !dictation.online.value -> askOnline = true
            ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED ->
                permission.launch(Manifest.permission.RECORD_AUDIO)
            else -> begin()
        }
    }

    // From the flow itself, not [state]: that may still hold the end of the dictation before.
    LaunchedEffect(dictating) {
        if (!dictating) return@LaunchedEffect
        dictation.state.collect { heard ->
            when (heard) {
                is Dictation.State.Listening -> onDraft(Dictation.join(before, heard.text))
                is Dictation.State.Done -> {
                    onDraft(Dictation.join(before, heard.text))
                    onDictating(false)
                }
                is Dictation.State.Failed -> {
                    onDictating(false)
                    problem(heard.message)
                }
                Dictation.State.Idle -> onDictating(false)
            }
        }
    }
    val stillDictating by rememberUpdatedState(dictating)
    DisposableEffect(key) { onDispose { if (stillDictating) dictation.cancel() } }

    Row(verticalAlignment = Alignment.CenterVertically) {
        if (packs.isNotEmpty() && !dictation.detectsLanguage && languages.size > 1) {
            TextButton(onClick = dictation::nextLanguage, enabled = !dictating) {
                Text(Dictation.shortName(language), style = MaterialTheme.typography.labelLarge)
            }
        }
        val listening = state as? Dictation.State.Listening
        if (dictating) {
            FilledIconButton(
                onClick = ::tap,
                shapes = IconButtonDefaults.shapes(),
                modifier = Modifier.scale(1f + 0.15f * (listening?.level ?: 0f)),
            ) { Icon(Icons.Filled.Mic, stringResource(R.string.room_speech_stop)) }
        } else {
            IconButton(onClick = ::tap) { Icon(Icons.Outlined.Mic, stringResource(R.string.room_speech_dictate)) }
        }
    }

    if (askOnline) {
        AlertDialog(
            onDismissRequest = { askOnline = false },
            icon = { Icon(Icons.Outlined.RecordVoiceOver, null) },
            title = { Text(stringResource(R.string.room_speech_online_title)) },
            text = {
                Text(
                    if (dictation.onDevice) stringResource(R.string.room_speech_online_language, Dictation.displayName(language))
                    else stringResource(R.string.room_speech_online),
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    askOnline = false
                    dictation.allowOnline(true)
                    tap()
                }) { Text(stringResource(R.string.room_speech_use_it)) }
            },
            dismissButton = { TextButton(onClick = { askOnline = false }) { Text(stringResource(R.string.room_speech_not_now)) } },
        )
    }
}

/** The player's speech languages, and the language packs the phone has for them. */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun SpeechScreen(dictation: Dictation, close: () -> Unit) {
    val languages by dictation.languages.collectAsStateWithLifecycle()
    val online by dictation.online.collectAsStateWithLifecycle()
    val packs by dictation.packs.collectAsStateWithLifecycle()
    var adding by remember { mutableStateOf(false) }
    val scrollBehavior = TopAppBarDefaults.exitUntilCollapsedScrollBehavior()
    val candidates = (languages + Dictation.common).distinct()

    // Packs download in the background; look again now and then while the screen is open.
    LaunchedEffect(candidates) {
        while (true) {
            dictation.check(candidates)
            delay(5_000)
        }
    }

    Scaffold(
        containerColor = groupedBackground(),
        modifier = Modifier.nestedScroll(scrollBehavior.nestedScrollConnection),
        topBar = {
            MediumFlexibleTopAppBar(
                colors = groupedTopBarColors(),
                title = { Text(stringResource(R.string.room_speech_title)) },
                navigationIcon = { IconButton(onClick = close) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.room_speech_back)) } },
                scrollBehavior = scrollBehavior,
            )
        },
    ) { padding ->
        LazyColumn(
            Modifier.imePadding(),
            contentPadding = PaddingValues(
                start = 16.dp,
                end = 16.dp,
                top = padding.calculateTopPadding(),
                bottom = padding.calculateBottomPadding() + 24.dp,
            ),
        ) {
            group(
                text(R.string.room_speech_languages),
                buildList<GroupRow> {
                    languages.forEachIndexed { index, tag ->
                        add { shapes ->
                            SegmentedListItem(
                                shapes = shapes,
                                supportingContent = { Text(describe(packs[tag], dictation.onDevice)) },
                                trailingContent = {
                                    Row {
                                        if (packs[tag] == Pack.DOWNLOADABLE) {
                                            IconButton(onClick = { dictation.download(tag) }) { Icon(Icons.Outlined.Download, stringResource(R.string.room_download)) }
                                        }
                                        if (index > 0) {
                                            IconButton(onClick = {
                                                dictation.setLanguages(languages.toMutableList().apply { add(index - 1, removeAt(index)) })
                                            }) { Icon(Icons.Outlined.KeyboardArrowUp, stringResource(R.string.room_speech_move_up)) }
                                        }
                                        if (languages.size > 1) {
                                            IconButton(onClick = { dictation.setLanguages(languages - tag) }) {
                                                Icon(Icons.Outlined.Close, stringResource(R.string.room_remove))
                                            }
                                        }
                                    }
                                },
                            ) { Text(Dictation.displayName(tag)) }
                        }
                    }
                    add { shapes ->
                        SegmentedListItem(
                            onClick = { adding = true },
                            shapes = shapes,
                            leadingContent = { Icon(Icons.Outlined.Add, null) },
                        ) { Text(stringResource(R.string.room_speech_add)) }
                    }
                },
            )
            item {
                Text(
                    stringResource(if (dictation.detectsLanguage) R.string.room_speech_detects else R.string.room_speech_tap),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(16.dp),
                )
            }
            if (!dictation.onDevice || languages.any { packs[it] == Pack.MISSING }) {
                group(
                    text(R.string.room_speech_off_phone),
                    listOf { shapes ->
                        SegmentedListItem(
                            checked = online,
                            onCheckedChange = dictation::allowOnline,
                            shapes = shapes,
                            supportingContent = {
                                Text(stringResource(R.string.room_speech_online_explain))
                            },
                            trailingContent = { Switch(checked = online, onCheckedChange = null) },
                        ) { Text(stringResource(R.string.room_speech_use_service)) }
                    },
                )
            }
        }
    }

    if (adding) {
        AlertDialog(
            onDismissRequest = { adding = false },
            title = { Text(stringResource(R.string.room_speech_add)) },
            text = {
                LazyColumn {
                    candidates.filter { it !in languages }
                        .sortedBy { Dictation.displayName(it) }
                        .forEach { tag ->
                            item(key = tag) {
                                SegmentedListItem(
                                    onClick = {
                                        adding = false
                                        dictation.setLanguages(languages + tag)
                                        if (packs[tag] == Pack.DOWNLOADABLE) dictation.download(tag)
                                    },
                                    shapes = ListItemDefaults.segmentedShapes(0, 1),
                                    supportingContent = { Text(describe(packs[tag], dictation.onDevice)) },
                                ) { Text(Dictation.displayName(tag)) }
                            }
                        }
                }
            },
            confirmButton = { TextButton(onClick = { adding = false }) { Text(stringResource(R.string.room_cancel)) } },
        )
    }
}

private fun describe(pack: Pack?, onDevice: Boolean): String = when {
    !onDevice -> text(R.string.room_speech_pack_service)
    pack == Pack.INSTALLED -> text(R.string.room_speech_pack_installed)
    pack == Pack.DOWNLOADING -> text(R.string.room_speech_pack_downloading)
    pack == Pack.DOWNLOADABLE -> text(R.string.room_speech_pack_downloadable)
    pack == Pack.MISSING -> text(R.string.room_speech_pack_missing)
    else -> text(R.string.room_speech_pack_maybe)
}
