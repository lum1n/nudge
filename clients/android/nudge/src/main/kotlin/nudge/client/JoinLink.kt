// `nudge://join?server=…&assistant=…`, as an admin's invite of someone from another assistant makes them.
package nudge.client

import java.net.URI
import java.net.URLDecoder

/** What a join link says: the assistant to join, from the player's home, and its server. */
data class JoinLink(val server: String, val assistant: String) {
    companion object {
        /** Null for anything but a join link with an http(s) server and an assistant. */
        fun parse(link: String): JoinLink? {
            val uri = runCatching { URI(link) }.getOrNull() ?: return null
            if (!uri.scheme.equals("nudge", ignoreCase = true) || !uri.host.equals("join", ignoreCase = true)) {
                return null
            }
            val query = (uri.rawQuery ?: return null).split("&").mapNotNull { pair ->
                val parts = pair.split("=", limit = 2)
                if (parts.size != 2) return@mapNotNull null
                URLDecoder.decode(parts[0], "UTF-8") to URLDecoder.decode(parts[1], "UTF-8").trim()
            }.toMap()
            val server = query["server"] ?: return null
            val scheme = runCatching { URI(server).scheme?.lowercase() }.getOrNull()
            if (scheme != "http" && scheme != "https") return null
            val assistant = query["assistant"]?.takeIf { it.isNotEmpty() } ?: return null
            return JoinLink(server, assistant)
        }
    }
}
