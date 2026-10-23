package app.imagestudio.background

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.ResultReceiver

class BackgroundTasksService : Service() {
  companion object {
    const val START = "app.imagestudio.background.START"
    const val FINISH = "app.imagestudio.background.FINISH"
    const val RESULT = "resultReceiver"
    private const val CHANNEL = "ai-tasks"
    private const val NOTIFICATION_ID = 1901
    // 有界超时防止异常时永久持锁；原生定时续期，不依赖后台 WebView 的 JS 定时器。
    private const val LOCK_TIMEOUT_MS = 10 * 60 * 1000L
    private const val RENEW_INTERVAL_MS = 2 * 60 * 1000L
  }

  private val tasks = mutableSetOf<String>()
  private var wakeLock: PowerManager.WakeLock? = null
  private val handler = Handler(Looper.getMainLooper())
  private val renewLock = object : Runnable {
    override fun run() {
      if (tasks.isEmpty()) return
      try {
        acquireWakeLock()
        BackgroundTaskRuntime.update(tasks.size, wakeLock?.isHeld == true)
        handler.postDelayed(this, RENEW_INTERVAL_MS)
      } catch (error: Exception) {
        interrupt("Android 唤醒锁续期失败：${error.message ?: "系统拒绝"}")
      }
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val taskId = intent?.getStringExtra("taskId")
    try {
      when {
        intent?.action == START && !taskId.isNullOrBlank() -> {
          tasks.add(taskId)
          // 先满足前台服务时限，锁成功后才向调用方确认 ready。
          updateNotification()
          acquireWakeLock()
          BackgroundTaskRuntime.update(tasks.size, wakeLock?.isHeld == true, clearError = true)
          handler.removeCallbacks(renewLock)
          handler.postDelayed(renewLock, RENEW_INTERVAL_MS)
          reply(intent, null)
        }
        intent?.action == FINISH && taskId != null -> {
          tasks.remove(taskId)
          if (tasks.isEmpty()) stopProtection(startId) else {
            updateNotification()
            BackgroundTaskRuntime.update(tasks.size, wakeLock?.isHeld == true)
          }
        }
        else -> {
          if (tasks.isEmpty()) stopProtection(startId)
          reply(intent, "无效的后台任务")
        }
      }
    } catch (error: Exception) {
      val reason = "Android 后台保护启动失败：${error.message ?: "系统拒绝"}"
      reply(intent, reason)
      // 不让权限/前台服务异常逃出 onStartCommand 导致整个应用崩溃重启。
      interrupt(reason)
    }
    return START_NOT_STICKY
  }

  @Suppress("DEPRECATION")
  private fun reply(intent: Intent?, error: String?) {
    // 调用方被销毁或 Parcelable 异常也不能让服务崩溃并拖累其他任务。
    runCatching {
      val receiver = if (Build.VERSION.SDK_INT >= 33) intent?.getParcelableExtra(RESULT, ResultReceiver::class.java)
        else intent?.getParcelableExtra<ResultReceiver>(RESULT)
      val result = Bundle()
      if (error != null) result.putString("error", error)
      receiver?.send(if (error == null) 0 else 1, result)
    }
  }

  private fun acquireWakeLock() {
    val lock = wakeLock ?: getSystemService(PowerManager::class.java)
      .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "$packageName:ai-tasks")
      .also { it.setReferenceCounted(false); wakeLock = it }
    // 非引用计数锁的重复 acquire 更新超时；并发任务完成一个不会释放其他任务的锁。
    lock.acquire(LOCK_TIMEOUT_MS)
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
    handler.removeCallbacks(renewLock)
    wakeLock?.let { if (it.isHeld) runCatching { it.release() } }
    wakeLock = null
  }

  private fun stopProtection(startId: Int) {
    releaseWakeLock()
    BackgroundTaskRuntime.update(0, false)
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf(startId)
  }

  private fun interrupt(reason: String) {
    tasks.clear()
    releaseWakeLock()
    BackgroundTaskRuntime.interrupted(reason)
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  override fun onTimeout(startId: Int, fgsType: Int) {
    // Android 15+ 的 dataSync 总时限必须停止服务，不能盲目重启或伪称任务完成。
    interrupt("Android 已达到后台数据同步时限，任务已停止。请回到应用后手动继续。")
  }

  override fun onDestroy() {
    val interrupted = tasks.isNotEmpty()
    tasks.clear()
    releaseWakeLock()
    if (interrupted) BackgroundTaskRuntime.interrupted("Android 后台服务被系统终止，任务已停止。请检查电池优化设置后手动继续。")
    else BackgroundTaskRuntime.update(0, false)
    super.onDestroy()
  }
}
