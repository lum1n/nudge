package nudge.client

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.os.Build
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import nudge.ffi.attachmentImageMaxSide

/** The image types the server takes as images (ADR 24); anything else is a file. */
val IMAGE_TYPES = setOf("image/png", "image/jpeg", "image/gif", "image/webp")

/** A file ready to upload: its name, type and bytes. */
class Upload(val name: String, val mime: String, val bytes: ByteArray)

/**
 * The size and type to redraw an image of `mime` at before uploading it, or null to send it as
 * it is. Photos are scaled down to `maxSide` on the long side, as providers would anyway. A GIF
 * stays as it is, since redrawing it would stop it moving; an image type providers don't take,
 * such as HEIC, becomes a JPEG so the model can see it.
 */
fun scaling(mime: String, width: Int, height: Int, maxSide: Int): Scaling? {
    if (mime == "image/gif" || width <= 0 || height <= 0) return null
    val known = mime in IMAGE_TYPES
    val scale = minOf(1.0, maxSide.toDouble() / maxOf(width, height))
    if (known && scale == 1.0) return null
    return Scaling(
        width = maxOf(1, Math.round(width * scale).toInt()),
        height = maxOf(1, Math.round(height * scale).toInt()),
        mime = if (known) mime else "image/jpeg",
    )
}

data class Scaling(val width: Int, val height: Int, val mime: String)

/** A size for people: `240 KB`, `1.2 MB`. */
fun sizeLabel(bytes: Long): String = when {
    bytes < 1024 -> "$bytes B"
    bytes < 1024 * 1024 -> "${Math.round(bytes / 1024.0)} KB"
    else -> String.format(java.util.Locale.ROOT, "%.1f MB", bytes / (1024.0 * 1024.0))
}

/**
 * `file` scaled down for uploading (see [scaling]); as it is when it isn't an image to redraw or
 * one Android can't read. On Android 9 and later the photo's EXIF orientation is applied.
 */
fun scaleForUpload(file: Upload, maxSide: Int = attachmentImageMaxSide().toInt()): Upload {
    if (!file.mime.startsWith("image/")) return file
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(file.bytes, 0, file.bytes.size, bounds)
    val target = scaling(file.mime, bounds.outWidth, bounds.outHeight, maxSide) ?: return file
    val bitmap = decode(file.bytes, target) ?: return file
    val format = when (target.mime) {
        "image/png" -> Bitmap.CompressFormat.PNG
        "image/webp" ->
            if (Build.VERSION.SDK_INT >= 30) Bitmap.CompressFormat.WEBP_LOSSY
            else @Suppress("DEPRECATION") Bitmap.CompressFormat.WEBP
        else -> Bitmap.CompressFormat.JPEG
    }
    val out = ByteArrayOutputStream()
    bitmap.compress(format, 85, out)
    bitmap.recycle()
    val name = if (target.mime == file.mime) file.name else file.name.substringBeforeLast('.') + ".jpg"
    return Upload(name, target.mime, out.toByteArray())
}

private fun decode(bytes: ByteArray, target: Scaling): Bitmap? = try {
    if (Build.VERSION.SDK_INT >= 28) {
        ImageDecoder.decodeBitmap(ImageDecoder.createSource(ByteBuffer.wrap(bytes))) { decoder, info, _ ->
            // The size here is after the orientation is applied, so the long side may swap.
            val size = info.size
            val scale = minOf(1.0, maxOf(target.width, target.height).toDouble() / maxOf(size.width, size.height))
            decoder.setTargetSize(
                maxOf(1, Math.round(size.width * scale).toInt()),
                maxOf(1, Math.round(size.height * scale).toInt()),
            )
            decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
        }
    } else {
        // A power of two at most as large as needed, then scaled to the size exactly.
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        var sample = 1
        while (bounds.outWidth / (sample * 2) >= target.width && bounds.outHeight / (sample * 2) >= target.height) sample *= 2
        val sampled = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
        sampled?.let {
            Bitmap.createScaledBitmap(it, target.width, target.height, true).also { scaled -> if (scaled !== it) it.recycle() }
        }
    }
} catch (_: Exception) {
    null
}
