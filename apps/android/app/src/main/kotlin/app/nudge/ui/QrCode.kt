package app.nudge.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import com.google.zxing.qrcode.encoder.Encoder

/** The dark modules of `text`'s QR code, row by row, with no quiet zone around them. */
fun qrModules(text: String): List<BooleanArray> {
    val matrix = Encoder.encode(
        text,
        ErrorCorrectionLevel.M,
        mapOf(EncodeHintType.CHARACTER_SET to "UTF-8"),
    ).matrix
    return List(matrix.height) { y -> BooleanArray(matrix.width) { x -> matrix.get(x, y).toInt() == 1 } }
}

/**
 * `text` as a QR code, black on white whatever the theme, so every camera reads it, with the
 * quiet zone of one module a side the web UI's have too.
 */
@Composable
fun QrCode(text: String, description: String, modifier: Modifier = Modifier) {
    val modules = remember(text) { qrModules(text) }
    Canvas(modifier.aspectRatio(1f).semantics { contentDescription = description }) {
        val count = modules.size + 2
        val cell = size.minDimension / count
        drawRect(Color.White)
        modules.forEachIndexed { y, row ->
            row.forEachIndexed { x, dark ->
                if (dark) {
                    // A hair larger, so neighbours meet without seams.
                    drawRect(Color.Black, Offset((x + 1) * cell, (y + 1) * cell), Size(cell + 0.5f, cell + 0.5f))
                }
            }
        }
    }
}
