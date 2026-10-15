// `nudge://pair?server=…&assistant=…&code=…`, as `nudge pair` and the admin API make them.
package nudge.client

import java.net.URI
import java.net.URLDecoder

/** What a pairing link says: where the server is, which assistant, and the one-time code. */
data class PairingLink(val server: String, val assistant: String, val code: String) {
    companion object {
        /** Null for anything but a pairing link with an http(s) server, an assistant and a code. */
        fun parse(link: String): PairingLink? {
            val uri = runCatching { URI(link) }.getOrNull() ?: return null
            if (!uri.scheme.equals("nudge", ignoreCase = true) || !uri.host.equals("pair", ignoreCase = true)) {
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
            val code = query["code"]?.takeIf { it.isNotEmpty() } ?: return null
            return PairingLink(server, assistant, code)
        }
    }
}
