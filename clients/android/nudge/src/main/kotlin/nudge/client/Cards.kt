package nudge.client

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import nudge.ffi.NudgeClient
import nudge.ffi.ToolPart

/**
 * A card a tool shows in the chat (ADR 27): blocks to read, fields to fill in, buttons to press.
 * The app draws it with its own controls; a press reaches the room as the reader's message.
 */
@Serializable
data class UiCard(
    val v: Int,
    val title: String? = null,
    /** Blocks of types this app knows; the others are left out. */
    val blocks: List<UiBlock> = emptyList(),
    val fields: List<UiField> = emptyList(),
    val buttons: List<UiButton> = emptyList(),
    /** Its buttons work once, for anyone. */
    val once: Boolean = true,
    /** `room` or `asker`: only who the answer was for may press. */
    val who: String = "room",
)

@Serializable
sealed interface UiBlock {
    @Serializable @SerialName("heading")
    data class Heading(val text: String) : UiBlock

    /** Markdown, as messages have it. */
    @Serializable @SerialName("text")
    data class Text(val markdown: String) : UiBlock

    @Serializable @SerialName("kv")
    data class KeyValues(val pairs: List<Pair>) : UiBlock {
        @Serializable
        data class Pair(val label: String, val value: String)
    }

    @Serializable @SerialName("list")
    data class Items(val items: List<Item>) : UiBlock {
        @Serializable
        data class Item(val title: String, val subtitle: String? = null)
    }

    @Serializable @SerialName("table")
    data class Table(val columns: List<String>, val rows: List<List<String>>) : UiBlock

    /** One of the room's attachments, by id. */
    @Serializable @SerialName("image")
    data class Image(val attachment: String, val alt: String) : UiBlock

    @Serializable @SerialName("divider")
    data object Divider : UiBlock

    /** Places on a map, and a line through [path] such as a route; the app picks the map. */
    @Serializable @SerialName("map")
    data class Places(val markers: List<Marker> = emptyList(), val path: List<Point> = emptyList()) : UiBlock {
        @Serializable
        data class Marker(val lat: Double, val lon: Double, val label: String)

        @Serializable
        data class Point(val lat: Double, val lon: Double)
    }

    /** `bar`, `line`, `area` or `pie`: a value per label in each series, null for a gap. */
    @Serializable @SerialName("chart")
    data class Chart(
        val kind: String,
        val labels: List<String>,
        val series: List<Series>,
        val unit: String? = null,
    ) : UiBlock {
        @Serializable
        data class Series(val name: String, val values: List<Double?>)
    }

    /** Headline numbers; [Stat.tone] is `good`, `bad`, `neutral` or null. */
    @Serializable @SerialName("stats")
    data class Stats(val items: List<Stat>) : UiBlock {
        @Serializable
        data class Stat(val label: String, val value: String, val change: String? = null, val tone: String? = null)
    }

    /** How far along things are; [Bar.max] is what full is. */
    @Serializable @SerialName("progress")
    data class Progress(val items: List<Bar>) : UiBlock {
        @Serializable
        data class Bar(val label: String, val value: Double, val max: Double = 100.0, val note: String? = null)
    }

    /** Steps in order; [Step.state] is `done`, `current`, `upcoming` or null. */
    @Serializable @SerialName("timeline")
    data class Timeline(val items: List<Step>) : UiBlock {
        @Serializable
        data class Step(val title: String, val time: String? = null, val subtitle: String? = null, val state: String? = null)
    }
}

@Serializable
data class UiField(
    val name: String,
    val label: String,
    /** `text`, `number`, `boolean`, `choice`, `date` (`YYYY-MM-DD`) or `time` (`HH:MM`). */
    val type: String,
    val options: List<String> = emptyList(),
    val placeholder: String? = null,
    val multiline: Boolean = false,
    val optional: Boolean = false,
)

@Serializable
data class UiButton(
    val id: String,
    val label: String,
    /** `primary`, `danger`, or null. */
    val style: String? = null,
    /** Pressing it sends no field values and needs none filled in. */
    val skipsFields: Boolean = false,
)

/** The latest press on a card: which button, and the display name of who pressed it. */
data class UiPressed(val button: String, val by: String)

/** The card a tool showed, when its details hold one. */
val ToolPart.card: UiCard?
    get() {
        val details = detailsJson?.let(::frameOf) ?: return null
        val ui = details["ui"] as? JsonObject ?: return null
        if ((ui["v"] as? JsonPrimitive)?.content != "1") return null
        val known = buildJsonObject {
            for ((key, value) in ui) if (key != "blocks") put(key, value)
        }
        return runCatching {
            panelJson.decodeFromJsonElement<UiCard>(known).copy(blocks = blocksOf(ui["blocks"]))
        }.getOrNull()
    }

/** The latest press on the tool's card, if it was pressed. */
val ToolPart.pressed: UiPressed?
    get() {
        val pressed = detailsJson?.let(::frameOf)?.get("pressed") as? JsonObject ?: return null
        val button = (pressed["button"] as? JsonPrimitive)?.content ?: return null
        val by = (pressed["by"] as? JsonObject)?.get("displayName") as? JsonPrimitive
        return UiPressed(button, by?.content ?: "")
    }

private fun blocksOf(blocks: JsonElement?): List<UiBlock> =
    (blocks as? kotlinx.serialization.json.JsonArray).orEmpty().mapNotNull { block ->
        runCatching { panelJson.decodeFromJsonElement<UiBlock>(block.jsonObject) }.getOrNull()
    }

/** What a field holds before it is sent. */
sealed interface UiValue {
    data class Text(val text: String) : UiValue
    data class Number(val number: Double) : UiValue
    data class Flag(val on: Boolean) : UiValue
}

/**
 * The values a press on [button] sends, as JSON, or the label of a required field left empty.
 * A number field's text that isn't a number counts as empty.
 */
fun UiCard.valuesFor(button: UiButton, values: Map<String, UiValue>): Result<String?> {
    if (button.skipsFields) return Result.success(null)
    val json = buildJsonObject {
        for (field in fields) {
            val value = values[field.name] ?: if (field.type == "boolean") UiValue.Flag(false) else null
            val element = when (value) {
                is UiValue.Text -> value.text.takeIf { it.isNotEmpty() }?.let(::JsonPrimitive)
                is UiValue.Number -> JsonPrimitive(value.number)
                is UiValue.Flag -> JsonPrimitive(value.on)
                null -> null
            }
            if (element == null) {
                if (!field.optional) return Result.failure(MissingField(field.label))
                continue
            }
            put(field.name, element)
        }
    }
    return Result.success(json.toString())
}

/** A required field left empty: [label] names it. */
class MissingField(val label: String) : Exception(label)

/** Presses [button] on the card tool call [callId] showed in [room], with [values]. */
suspend fun NudgeClient.press(room: String, callId: String, card: UiCard, button: UiButton, values: Map<String, UiValue>) {
    val json = card.valuesFor(button, values).getOrThrow()
    pressCard(room, callId, button.id, json)
}
