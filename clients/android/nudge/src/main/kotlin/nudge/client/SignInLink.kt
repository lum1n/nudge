// `nudge://sign-in?server=…&request=…`, as the web UI's sign-in page shows them in a QR code.
package nudge.client

import java.net.URI
import java.net.URLDecoder

/**
 * What a sign-in link says: the server whose web UI shows it, and the browser's request there,
 * which an app signed in to that server approves with `NudgeClient.approveSignIn`.
 */
data class SignInLink(val server: String, val request: String) {
    companion object {
        /** Null for anything but a sign-in link with an http(s) server and a request. */
        fun parse(link: String): SignInLink? {
            val uri = runCatching { URI(link) }.getOrNull() ?: return null
            if (!uri.scheme.equals("nudge", ignoreCase = true) || !uri.host.equals("sign-in", ignoreCase = true)) {
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
            val request = query["request"]?.takeIf { it.isNotEmpty() } ?: return null
            return SignInLink(server, request)
        }
    }
}
