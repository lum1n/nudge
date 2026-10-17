// FCM data messages from the server: an answer is ready or an action waits for approval in one
// of the player's rooms. The app makes the notification itself, so a tap opens the room. Through
// the push relay they come sealed for this device, and are opened here first.
package app.nudge

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import androidx.core.app.NotificationCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class PushService : FirebaseMessagingService() {
    private val model get() = (application as NudgeApplication).model

    override fun onRegistered(token: String) {
        model.onPushToken(token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data["sealed"]?.let { sealed ->
            // Not for this device's key, such as one sealed before the app was reinstalled.
            val push = model.openPush(sealed) ?: return
            mapOf(
                "assistant" to push.assistant,
                "roomId" to push.roomId,
                "kind" to push.kind,
                "url" to push.url,
                "title" to push.title,
                "body" to push.body,
                "tag" to push.tag,
                "account" to push.account,
            )
        } ?: message.data
        val room = data["roomId"] ?: return
        // The room is on screen: the timeline shows it already.
        if (model.foreground && model.showing(data["account"], data["assistant"], room)) return
        val open = Intent(this, MainActivity::class.java)
            .setAction(Intent.ACTION_VIEW)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra(MainActivity.EXTRA_ROOM, room)
            .putExtra(MainActivity.EXTRA_ASSISTANT, data["assistant"])
            .putExtra(MainActivity.EXTRA_ACCOUNT, data["account"])
        val tag = data["tag"] ?: room
        val notification = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(data["title"] ?: getString(R.string.app_name))
            .setContentText(data["body"])
            .setStyle(NotificationCompat.BigTextStyle().bigText(data["body"]))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(if (data["kind"] == "approval") NotificationCompat.CATEGORY_REMINDER else NotificationCompat.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .setContentIntent(
                PendingIntent.getActivity(
                    this, tag.hashCode(), open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                ),
            )
            .build()
        // Notifications of one room replace each other.
        getSystemService(NotificationManager::class.java).notify(tag, 0, notification)
    }

    companion object {
        const val CHANNEL = "news"
    }
}
