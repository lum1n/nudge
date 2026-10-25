package app.nudge

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.w3c.dom.Element

/** [Texts] for JVM tests: the English strings, read from `res/values` and found by their R names. */
object EnglishTexts {
    private val strings = mutableMapOf<String, String>()
    private val plurals = mutableMapOf<String, Map<String, String>>()

    init {
        val files = File("src/main/res/values").listFiles { file -> file.name.startsWith("strings") }!!
        for (file in files) {
            val root = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(file).documentElement
            val each = root.getElementsByTagName("string")
            for (i in 0 until each.length) (each.item(i) as Element).let { strings[it.getAttribute("name")] = unescape(it.textContent) }
            val counted = root.getElementsByTagName("plurals")
            for (i in 0 until counted.length) {
                val element = counted.item(i) as Element
                val items = element.getElementsByTagName("item")
                plurals[element.getAttribute("name")] =
                    (0 until items.length).map { items.item(it) as Element }.associate { it.getAttribute("quantity") to unescape(it.textContent) }
            }
        }
    }

    private fun unescape(value: String) = value.replace("\\'", "'").replace("\\\"", "\"").replace("\\n", "\n")

    private fun nameOf(type: String, id: Int): String =
        Class.forName("app.nudge.R\$$type").fields.first { it.getInt(null) == id }.name

    /** Makes [text] answer in English. */
    fun install() {
        Texts.string = { id, args -> strings.getValue(nameOf("string", id)).format(*args) }
        Texts.quantity = { id, count, args ->
            val forms = plurals.getValue(nameOf("plurals", id))
            (forms[if (count == 1) "one" else "other"] ?: forms.getValue("other")).format(*args)
        }
    }
}
