// An extension's settings as a form: the fields its JSON Schema (as TypeBox writes it) describes,
// for an app to draw natively, and the settings as a JSON object to edit and save.
package nudge.client

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import nudge.ffi.ExtensionSetup
import nudge.ffi.SavedExtensionSetup

/** What kind of control a setting takes. */
sealed interface SettingKind {
    /** A string; `secret` ones (a password, a token, a key) are typed without being shown. */
    data class Text(val secret: Boolean) : SettingKind

    data class Number(val integer: Boolean, val minimum: Double?, val maximum: Double?) : SettingKind

    data object Toggle : SettingKind

    /** One of a fixed few values. */
    data class Choice(val options: List<JsonElement>) : SettingKind

    /** A list of strings, one per line. */
    data object Lines : SettingKind

    /** Some of the assistant's rooms, by id, or `*` for every room: offer them by name. */
    data object Rooms : SettingKind

    /** An object of its own fields. */
    data class Group(val fields: List<SettingField>) : SettingKind

    /** A list of objects, such as mail accounts, each with these fields. */
    data class Items(val fields: List<SettingField>) : SettingKind

    /** Anything else, edited as JSON. */
    data object Json : SettingKind
}

/** One setting: its key, a label to show, its help, and its default. */
data class SettingField(
    val name: String,
    val label: String,
    val description: String?,
    val required: Boolean,
    val default: JsonElement?,
    val kind: SettingKind,
)

/** Names whose values are usually secrets. */
private val SECRET = Regex("token|password|secret|key$", RegexOption.IGNORE_CASE)

/** The fields of an object schema, given as JSON; none for no schema. */
fun settingFields(schemaJson: String?): List<SettingField> {
    schemaJson ?: return emptyList()
    val schema = runCatching { panelJson.parseToJsonElement(schemaJson).jsonObject }.getOrNull() ?: return emptyList()
    return fieldsOf(schema)
}

private fun fieldsOf(schema: JsonObject): List<SettingField> {
    val merged = mergeAllOf(schema)
    val required = (merged["required"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }?.toSet().orEmpty()
    val properties = merged["properties"] as? JsonObject ?: return emptyList()
    return properties.mapNotNull { (name, property) ->
        val schema = property as? JsonObject ?: return@mapNotNull null
        SettingField(
            name = name,
            label = schema.string("title") ?: humanize(name),
            description = schema.string("description"),
            required = name in required,
            default = schema["default"],
            kind = kindOf(name, schema),
        )
    }
}

private fun kindOf(name: String, schema: JsonObject): SettingKind {
    if (schema.string("x-nudge") == "rooms") return SettingKind.Rooms
    choicesOf(schema)?.let { return SettingKind.Choice(it) }
    return when (typeOf(schema)) {
        "boolean" -> SettingKind.Toggle
        "number", "integer" -> SettingKind.Number(
            integer = typeOf(schema) == "integer",
            minimum = (schema["minimum"] as? JsonPrimitive)?.doubleOrNull,
            maximum = (schema["maximum"] as? JsonPrimitive)?.doubleOrNull,
        )
        "string" -> SettingKind.Text(
            secret = schema.string("format") == "password" ||
                (schema["writeOnly"] as? JsonPrimitive)?.booleanOrNull == true ||
                SECRET.containsMatchIn(name),
        )
        "array" -> {
            val items = schema["items"] as? JsonObject
            when {
                items == null -> SettingKind.Json
                typeOf(items) == "string" && choicesOf(items) == null -> SettingKind.Lines
                typeOf(items) == "object" && mergeAllOf(items)["properties"] != null -> SettingKind.Items(fieldsOf(items))
                else -> SettingKind.Json
            }
        }
        "object" ->
            if (mergeAllOf(schema)["properties"] != null) SettingKind.Group(fieldsOf(schema)) else SettingKind.Json
        else -> SettingKind.Json
    }
}

private fun JsonObject.string(key: String) = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

/** `allOf` (TypeBox's intersections) as one object schema. */
private fun mergeAllOf(schema: JsonObject): JsonObject {
    val parts = schema["allOf"] as? JsonArray ?: return schema
    val properties = LinkedHashMap<String, JsonElement>()
    val required = LinkedHashSet<JsonElement>()
    (schema["properties"] as? JsonObject)?.let { properties.putAll(it) }
    (schema["required"] as? JsonArray)?.let { required.addAll(it) }
    for (part in parts) {
        val merged = mergeAllOf(part as? JsonObject ?: continue)
        (merged["properties"] as? JsonObject)?.let { properties.putAll(it) }
        (merged["required"] as? JsonArray)?.let { required.addAll(it) }
    }
    return JsonObject(schema - "allOf" + mapOf("properties" to JsonObject(properties), "required" to JsonArray(required.toList())))
}

private fun typeOf(schema: JsonObject): String? {
    schema.string("type")?.let { return it }
    if (schema["allOf"] != null) return "object"
    val types = (schema["anyOf"] as? JsonArray)?.map { (it as? JsonObject)?.string("type") }?.toSet() ?: return null
    return types.singleOrNull()
}

private fun choicesOf(schema: JsonObject): List<JsonElement>? {
    (schema["enum"] as? JsonArray)?.let { return it }
    val parts = schema["anyOf"] as? JsonArray ?: return null
    val consts = parts.map { (it as? JsonObject)?.get("const") }
    return if (consts.isNotEmpty() && consts.all { it != null }) consts.filterNotNull() else null
}

/** `pollSeconds` → "Poll seconds". */
private fun humanize(name: String): String {
    val words = name.replace(Regex("([a-z0-9])([A-Z])"), "$1 $2").replace(Regex("[_-]+"), " ")
    return words.lowercase().replaceFirstChar { it.uppercase() }
}

/** The extension's settings, as an object. */
val ExtensionSetup.settings: JsonObject
    get() = runCatching { panelJson.parseToJsonElement(settingsJson).jsonObject }.getOrNull() ?: JsonObject(emptyMap())

/** `settings` without the top-level values that equal their defaults, to keep the config short. */
fun JsonObject.withoutDefaults(fields: List<SettingField>): JsonObject {
    val defaults = fields.associate { it.name to it.default }
    return JsonObject(filter { (key, value) -> defaults[key] == null || defaults[key] != value })
}

/** The setup as `saveExtensionSetups` takes it, with these settings. */
fun ExtensionSetup.saved(enabled: Boolean, settings: JsonObject, rooms: List<nudge.ffi.RoomKind>?) = SavedExtensionSetup(
    from = from,
    enabled = enabled,
    settingsJson = settings.withoutDefaults(settingFields(schemaJson)).toString(),
    rooms = rooms,
)
