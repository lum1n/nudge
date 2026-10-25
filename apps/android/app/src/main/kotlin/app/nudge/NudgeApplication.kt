package app.nudge

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner

class NudgeApplication : Application() {
    lateinit var model: AppModel
        private set

    override fun onCreate() {
        super.onCreate()
        Texts.use(this)
        model = AppModel(this)
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(PushService.CHANNEL, getString(R.string.channel_news), NotificationManager.IMPORTANCE_HIGH)
                .apply { description = getString(R.string.channel_news_description) },
        )
        // Disconnected in the background: the server then pushes what happens in the rooms.
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) = model.setForeground(true)
            override fun onStop(owner: LifecycleOwner) = model.setForeground(false)
        })
    }
}
