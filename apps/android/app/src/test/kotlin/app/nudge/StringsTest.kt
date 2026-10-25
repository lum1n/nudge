package app.nudge

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element

/** The bokmål strings match the English ones (but those marked untranslatable): the same names and arguments. */
class StringsTest {
    private val res = File("src/main/res")

    /** Each string's and quantity string's name, with the format arguments it takes, sorted. */
    private fun strings(folder: String): Map<String, List<String>> {
        val files = File(res, folder).listFiles { file -> file.name.startsWith("strings") && file.extension == "xml" }
        assertTrue("no strings in $folder", !files.isNullOrEmpty())
        val out = sortedMapOf<String, List<String>>()
        for (file in files!!) {
            val root = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(file).documentElement
            for (tag in listOf("string", "plurals")) {
                val nodes = root.getElementsByTagName(tag)
                for (i in 0 until nodes.length) {
                    val element = nodes.item(i) as Element
                    val name = element.getAttribute("name")
                    if (element.getAttribute("translatable") == "false") continue
                    assertTrue("$name is in $folder twice", name !in out)
                    out[name] = ARGUMENT.findAll(element.textContent).map { it.value }.distinct().sorted().toList()
                }
            }
        }
        return out
    }

    @Test
    fun everyEnglishStringIsInBokmal() {
        val english = strings("values")
        val bokmal = strings("values-nb")
        assertEquals(english.keys - bokmal.keys, emptySet<String>())
        assertEquals(bokmal.keys - english.keys, emptySet<String>())
    }

    @Test
    fun bokmalTakesTheSameArguments() {
        val bokmal = strings("values-nb")
        for ((name, arguments) in strings("values")) {
            val translated = bokmal[name] ?: continue
            assertEquals("arguments of $name", arguments, translated)
        }
    }

    private companion object {
        /** `%1$s`, `%2$d`: positional arguments. */
        val ARGUMENT = Regex("""%\d+\$[sd]""")
    }
}
