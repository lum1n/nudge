package app.nudge

import android.Manifest
import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import app.nudge.ui.NudgeApp
import app.nudge.ui.NudgeTheme
import nudge.client.JoinLink
import nudge.client.PairingLink

class MainActivity : ComponentActivity() {
    private val model get() = (application as NudgeApplication).model

    private val askForNotifications =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) {}

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        handle(intent)
        setContent {
            NudgeTheme {
                NudgeApp(model, askForNotifications = ::askForNotifications)
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    /** A `nudge://pair` or `nudge://join` link, or a tapped notification. */
    private fun handle(intent: Intent?) {
        intent ?: return
        intent.data?.let { uri ->
            PairingLink.parse(uri.toString())?.let { model.pendingLink.value = it }
            JoinLink.parse(uri.toString())?.let { model.pendingJoin.value = it }
        }
        intent.getStringExtra(EXTRA_ROOM)?.let { room ->
            model.open(intent.getStringExtra(EXTRA_ACCOUNT), intent.getStringExtra(EXTRA_ASSISTANT), room)
        }
    }

    private fun askForNotifications() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            askForNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    companion object {
        const val EXTRA_ROOM = "app.nudge.room"
        const val EXTRA_ASSISTANT = "app.nudge.assistant"
        const val EXTRA_ACCOUNT = "app.nudge.account"
    }
}
