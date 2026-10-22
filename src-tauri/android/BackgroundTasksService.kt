package app.imagestudio.background

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

class BackgroundTasksService : Service() {
  companion object {
    const val START = "app.imagestudio.background.START"
    const val FINISH = "app.imagestudio.background.FINISH"
    private const val CHANNEL = "ai-tasks"
    private const val NOTIFICATION_ID = 1901
  }

  private val tasks = mutableSetOf<String>()
  private var wakeLock: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val taskId = intent?.getStringExtra("taskId")
    if (intent?.action == START && !taskId.isNullOrBlank()) {
      tasks.add(taskId)
      updateNotification()
      if (wakeLock?.isHeld != true) {
        wakeLock = getSystemService(PowerManager::class.java)
          .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "$packageName:ai-tasks")
          .apply { acquire(60 * 60 * 1000L) }
      }
    } else if (intent?.action == FINISH && taskId != null) {
      tasks.remove(taskId)
      if (tasks.isEmpty()) {
        releaseWakeLock()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf(startId)
      } else {
        updateNotification()
      }
    } else {
      stopSelf(startId)
    }
    // 不重启已经失去请求状态的服务，避免应用退出后留下空通知。
    return START_NOT_STICKY
  }

  private fun updateNotification() {
    val manager = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= 26) {
      manager.createNotificationChannel(NotificationChannel(CHANNEL, "AI 后台任务", NotificationManager.IMPORTANCE_LOW))
    }
    val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL) else Notification.Builder(this)
    builder.setSmallIcon(android.R.drawable.stat_notify_sync)
      .setContentTitle("Image Studio 正在处理任务")
      .setContentText("${tasks.size} 个任务运行中，生图和结果检查完成后自动结束")
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setCategory(Notification.CATEGORY_PROGRESS)
    packageManager.getLaunchIntentForPackage(packageName)?.let { launch ->
      builder.setContentIntent(PendingIntent.getActivity(this, 0, launch,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
    }
    if (Build.VERSION.SDK_INT >= 29) {
      startForeground(NOTIFICATION_ID, builder.build(), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    } else {
      startForeground(NOTIFICATION_ID, builder.build())
    }
  }

  private fun releaseWakeLock() {
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
  }

  override fun onTimeout(startId: Int, fgsType: Int) {
    tasks.clear()
    releaseWakeLock()
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  override fun onDestroy() {
    releaseWakeLock()
    super.onDestroy()
  }
}
